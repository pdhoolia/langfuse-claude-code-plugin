/**
 * Shared lookup for `/feedback` and `/journey` slash commands.
 * Resolves the active session ID and the most recent substantive trace ID
 * for the current cwd, and applies the unified scorability gate (ADR-007).
 *
 * See EIS §3.4.
 */

import { realpathSync } from "node:fs";
import { loadState, getActiveByCwd, getSessionState } from "../state.js";

export interface FeedbackTarget {
  /** Active session ID for this cwd (the value stored in _active_by_cwd). */
  sessionId: string;
  /** Most recent substantive turn's trace ID (always set when this is returned). */
  lastSubstantiveTraceId: string;
}

export type LookupFailure =
  | { kind: "no_session"; cwd: string }
  | { kind: "no_substantive_turn"; sessionId: string };

/** Type guard for callers. */
export function isLookupFailure(result: FeedbackTarget | LookupFailure): result is LookupFailure {
  return "kind" in result;
}

/**
 * Resolve the feedback target for the current cwd.
 *
 * Reads state directly (no lock — this is a read-only path; acquiring the lock
 * for a read would needlessly serialize against concurrent hook writes that
 * preserve invariants we read here).
 *
 * @param stateFilePath  Absolute path to langfuse_state.json (from config).
 * @param cwd            Process cwd at invocation time. Realpath-resolved internally.
 */
export function resolveFeedbackTarget(
  stateFilePath: string,
  cwd: string,
): FeedbackTarget | LookupFailure {
  const realCwd = safeRealpath(cwd);
  const state = loadState(stateFilePath);

  const sessionId = getActiveByCwd(state, realCwd);
  if (!sessionId) {
    return { kind: "no_session", cwd: realCwd };
  }

  const sessionState = getSessionState(state, sessionId);
  const lastSubstantiveTraceId = sessionState.last_substantive_trace_id;
  if (!lastSubstantiveTraceId) {
    return { kind: "no_substantive_turn", sessionId };
  }

  return { sessionId, lastSubstantiveTraceId };
}

/** realpathSync but never throws — falls back to the input on failure. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
