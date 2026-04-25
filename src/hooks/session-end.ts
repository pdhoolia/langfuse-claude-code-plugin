#!/usr/bin/env node
/**
 * SessionEnd hook entry point.
 *
 * Fires when a Claude Code session ends (user exits, /clear, /resume, etc.).
 * If the session was interrupted (Stop never fired for the last turn), closes
 * the open trace so it isn't left hanging in Langfuse.
 */

import { realpathSync } from "node:fs";
import { debug, error } from "../logger.js";
import { initClient, closeInterruptedTurn, setMaxChars } from "../langfuse.js";
import { loadState, atomicUpdateState, getSessionState, removeActiveByCwd } from "../state.js";
import { initHook, expandHome } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface SessionEndHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "SessionEnd";
  reason: string;
}

async function main(): Promise<void> {
  const input: SessionEndHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`SessionEnd hook: session=${input.session_id}, reason=${input.reason}`);

  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  // Always release this session's claim on _active_by_cwd[cwd] (FR-4 / ADR-006).
  // Done up-front so it happens even if there's no open trace to close.
  const realCwd = safeRealpath(input.cwd);
  await atomicUpdateState(config.stateFilePath, (s) =>
    removeActiveByCwd(s, realCwd, input.session_id),
  );

  if (!sessionState.current_trace_id) {
    debug("No open trace — nothing to close");
    return;
  }

  initClient(config.publicKey, config.secretKey, config.baseUrl);
  setMaxChars(config.maxChars);

  debug(`Closing interrupted turn (trace ${sessionState.current_trace_id}) on session end`);

  try {
    const { lastLine, turnsTraced, finalizedTraceId } = await closeInterruptedTurn({
      sessionId: input.session_id,
      sessionState,
      transcriptPath: expandHome(input.transcript_path),
      config: { maxChars: config.maxChars },
    });

    await atomicUpdateState(config.stateFilePath, (s) => {
      const ss = getSessionState(s, input.session_id);
      return {
        ...s,
        [input.session_id]: {
          ...ss,
          last_line: lastLine,
          turn_count: ss.turn_count + turnsTraced,
          current_trace_id: undefined,
          // ADR-008: interrupted turn counts as substantive — promote so
          // /feedback can still target it after session end.
          last_substantive_trace_id:
            turnsTraced > 0 && finalizedTraceId ? finalizedTraceId : ss.last_substantive_trace_id,
          task_run_map: {},
          tool_start_times: {},
          pending_subagent_traces: [],
        },
      };
    });

    debug(`Closed interrupted turn on session end (reason=${input.reason})`);
  } catch (err) {
    error(`Failed to close interrupted turn on session end: ${err}`);
  }
}

/** realpathSync but never throws — falls back to the input on failure. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

main().catch((err) => {
  try {
    error(`SessionEnd hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
