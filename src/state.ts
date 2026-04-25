/**
 * Persistent state management — tracks how far we've read in each session's
 * transcript so the Stop hook only processes new messages.
 *
 * Schema (per EIS §2): top-level keys are either session IDs (UUID-shaped)
 * mapping to SessionState, or one reserved key `_active_by_cwd` mapping to
 * Record<cwd, sessionId> (the slash-command lookup map — ADR-006).
 */

import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { TracingState, SessionState } from "./types.js";

// ─── Atomic read-modify-write ────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

function lockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(stateFilePath: string): Promise<void> {
  const lock = lockPath(stateFilePath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(stateFilePath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      // O_EXCL | O_CREAT: fails atomically if the file already exists.
      const fd = openSync(lock, "wx");
      closeSync(fd);
      return;
    } catch {
      await sleep(LOCK_RETRY_MS);
    }
  }
  // Stale lock — remove it and proceed rather than deadlocking.
  try {
    unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

function releaseLock(stateFilePath: string): void {
  try {
    unlinkSync(lockPath(stateFilePath));
  } catch {
    /* ignore */
  }
}

/**
 * Atomically read state, apply `fn`, and write the result back.
 * A file lock prevents concurrent hooks from clobbering each other.
 */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    writeFileSync(stateFilePath, JSON.stringify(fn(state), null, 2));
  } finally {
    releaseLock(stateFilePath);
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
