/**
 * Persistent state management — tracks how far we've read in each session's
 * transcript so the Stop hook only processes new messages.
 *
 * Schema (per EIS §2): top-level keys are either session IDs (UUID-shaped)
 * mapping to SessionState, or one reserved key `_active_by_cwd` mapping to
 * Record<cwd, sessionId> (the slash-command lookup map — ADR-006).
 */

import {
  readFileSync,
  writeFileSync,
  writeSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { TracingState, SessionState } from "./types.js";

// ─── Atomic read-modify-write ────────────────────────────────────────────────

/** How long a caller waits for the lock before giving up on the update. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

/**
 * How old a lock file has to be before it is treated as abandoned. The
 * critical section is one read plus one write of a small JSON file, so a
 * lock that has been held this long belongs to a process that died (or was
 * killed by a hook timeout) without releasing it.
 */
const LOCK_STALE_MS = 30_000;

function lockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The token written into the lock file by whoever created it: the owning pid
 * (so an abandoned lock says which process left it) plus a per-acquisition
 * uuid (so two acquisitions from the same process are still distinguishable).
 */
function newOwnerToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

/**
 * Create the lock file exclusively and stamp the owner into it.
 * Returns false if someone else holds it — never throws.
 */
function tryCreateLock(lock: string, owner: string): boolean {
  let fd: number;
  try {
    // O_EXCL | O_CREAT: fails atomically if the file already exists.
    fd = openSync(lock, "wx");
  } catch {
    return false;
  }
  try {
    writeSync(fd, owner);
  } catch {
    /* the lock is held either way; the stamp is only for diagnosis */
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Has the lock file been sitting there longer than a real critical section? */
function isLockStale(lock: string, now: number): boolean {
  try {
    return now - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Gone between the failed create and this check — not stale, just free.
    return false;
  }
}

/**
 * Remove a lock judged stale, by renaming it aside first. Rename is atomic:
 * if two processes both judge the same lock stale, only one rename finds the
 * file, so the loser cannot go on to delete the winner's fresh lock.
 */
function dropStaleLock(lock: string): void {
  const aside = `${lock}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // lost the race, or the holder released it first
  }
  try {
    unlinkSync(aside);
  } catch {
    /* ignore */
  }
}

/**
 * Wait for the lock and take it. Returns the owner token on success, or null
 * if the lock could not be taken within `LOCK_TIMEOUT_MS` — in which case the
 * caller does NOT hold the lock and must not enter the critical section.
 */
async function acquireLock(stateFilePath: string): Promise<string | null> {
  const lock = lockPath(stateFilePath);
  const owner = newOwnerToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(stateFilePath), { recursive: true });

  for (;;) {
    if (tryCreateLock(lock, owner)) return owner;

    // A lock old enough to be abandoned is dropped and then re-attempted.
    // The re-attempt is what decides: if it fails (another waiter got there
    // first), we keep waiting rather than pretending to hold the lock.
    if (isLockStale(lock, Date.now())) {
      dropStaleLock(lock);
      if (tryCreateLock(lock, owner)) return owner;
    }

    if (Date.now() >= deadline) return null;
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Release the lock, but only if it is still the one we took. A holder that
 * overran `LOCK_STALE_MS` and had its lock stolen must not delete the lock
 * its successor now holds.
 */
function releaseLock(stateFilePath: string, owner: string): void {
  const lock = lockPath(stateFilePath);
  try {
    if (readFileSync(lock, "utf-8").trim() !== owner) return;
    unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

/**
 * Atomically read state, apply `fn`, and write the result back.
 * A file lock prevents concurrent hooks from clobbering each other.
 *
 * Returns true if the update was written, false if the lock could not be
 * taken and the update was skipped. Every caller is a hook that must not
 * block or fail visibly, so skipping is the intended degradation — a lost
 * timestamp costs accuracy, a half-written state file costs the session.
 * Callers may ignore the result; those that care can log the skip.
 */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<boolean> {
  const owner = await acquireLock(stateFilePath);
  if (!owner) return false;
  try {
    const state = loadState(stateFilePath);
    writeFileSync(stateFilePath, JSON.stringify(fn(state), null, 2));
    return true;
  } finally {
    releaseLock(stateFilePath, owner);
  }
}

// ─── State helpers ──────────────────────────────────────────────────────────

export function loadState(stateFilePath: string): TracingState {
  try {
    const raw = readFileSync(stateFilePath, "utf-8");
    return JSON.parse(raw) as TracingState;
  } catch {
    return {};
  }
}

export function saveState(stateFilePath: string, state: TracingState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

/** Reserved (non-session-id) keys at the top level of TracingState. */
const RESERVED_KEYS = new Set(["_active_by_cwd"]);

const DEFAULT_SESSION: SessionState = {
  last_line: -1,
  turn_count: 0,
  updated: "",
  task_run_map: {},
};

/**
 * Heuristic check: is this entry shaped like a Record<string,string> lookup map
 * rather than a SessionState? (SessionState always has numeric `last_line`;
 * lookup maps don't.)
 */
function isReservedShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.last_line !== "number";
}

export function getSessionState(state: TracingState, sessionId: string): SessionState {
  if (RESERVED_KEYS.has(sessionId)) return { ...DEFAULT_SESSION };
  const entry = state[sessionId];
  if (!entry || isReservedShape(entry)) return { ...DEFAULT_SESSION };
  return entry as SessionState;
}

// ─── _active_by_cwd helpers (FR-4 / ADR-006) ────────────────────────────────

/**
 * Get the active session ID for a cwd, or undefined.
 * Caller must pre-realpath cwd to handle symlinks (HLD §8 risk row 3).
 */
export function getActiveByCwd(state: TracingState, cwd: string): string | undefined {
  return state._active_by_cwd?.[cwd];
}

/**
 * Upsert the active session ID for a cwd.
 * Caller must pre-realpath cwd. Last-writer-wins per HLD §8 risk row 4.
 */
export function setActiveByCwd(state: TracingState, cwd: string, sessionId: string): TracingState {
  return {
    ...state,
    _active_by_cwd: { ...state._active_by_cwd, [cwd]: sessionId },
  };
}

/**
 * Remove the cwd entry only if it points at the given sessionId (no-op otherwise).
 * Prevents a SessionEnd for an old session from clobbering a newer session's
 * claim on the same cwd.
 */
export function removeActiveByCwd(
  state: TracingState,
  cwd: string,
  sessionId: string,
): TracingState {
  const map = state._active_by_cwd;
  if (!map || map[cwd] !== sessionId) return state;
  const { [cwd]: _drop, ...rest } = map;
  return { ...state, _active_by_cwd: rest };
}

// ─── Session pruning ────────────────────────────────────────────────────────

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Remove sessions whose `updated` timestamp is older than 24 hours, and
 * garbage-collect any `_active_by_cwd` entries pointing at pruned sessions.
 */
export function pruneOldSessions(state: TracingState, now: number = Date.now()): TracingState {
  const cutoff = now - SESSION_MAX_AGE_MS;
  const pruned: TracingState = {};

  // Pass 1: prune old sessions (skip reserved keys).
  for (const [key, value] of Object.entries(state)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (!value || isReservedShape(value)) continue;
    const session = value as SessionState;
    const updatedMs = session.updated ? new Date(session.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      pruned[key] = session;
    }
  }

  // Pass 2: re-attach _active_by_cwd, dropping entries pointing at pruned sessions.
  const oldMap = state._active_by_cwd ?? {};
  const newMap: Record<string, string> = {};
  for (const [cwd, sid] of Object.entries(oldMap)) {
    if (sid in pruned) newMap[cwd] = sid;
  }
  if (Object.keys(newMap).length > 0) {
    pruned._active_by_cwd = newMap;
  }

  return pruned;
}
