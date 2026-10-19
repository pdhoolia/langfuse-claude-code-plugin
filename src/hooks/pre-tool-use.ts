#!/usr/bin/env node
/**
 * PreToolUse hook entry point.
 *
 * Fires before a tool executes. Records the wall-clock start time so
 * the Stop hook can use accurate timing for tool observations.
 *
 * Wired with `"async": true` (hooks/hooks.json): the tool call does not wait
 * for this process. The hook still receives its stdin payload and still writes
 * the timestamp — it only gives up the ability to block or deny the tool call,
 * which this hook never used.
 */

import { debug, error } from "../logger.js";
import { atomicUpdateState, getSessionState } from "../state.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface PreToolUseHookInput {
  session_id: string;
  hook_event_name: "PreToolUse";
  tool_use_id: string;
  tool_name: string;
}

async function main(): Promise<void> {
  const input: PreToolUseHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  const startTime = Date.now();

  debug(`PreToolUse hook: tool=${input.tool_name}, id=${input.tool_use_id}`);

  const written = await atomicUpdateState(config.stateFilePath, (state) => {
    const ss = getSessionState(state, input.session_id);
    return {
      ...state,
      [input.session_id]: {
        ...ss,
        tool_start_times: {
          ...ss.tool_start_times,
          [input.tool_use_id]: startTime,
        },
      },
    };
  });

  if (!written) {
    // The state file stayed locked; skipping keeps the tool call moving.
    // The cost is one tool span emitted without its wall-clock start time.
    debug(`PreToolUse hook: state locked, skipped start time for ${input.tool_use_id}`);
  }
}

main().catch((err) => {
  try {
    error(`PreToolUse hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
