#!/usr/bin/env node
/**
 * StopFailure hook entry point.
 *
 * Invoked when a turn ends due to an API error (rate limit, auth failure, etc.).
 * Updates the Langfuse trace with error status so the trace is visible
 * rather than hanging open indefinitely.
 */

import { error, debug } from "../logger.js";
import { initClient, flushTraces, shutdownClient } from "../langfuse.js";
import { loadState, atomicUpdateState, getSessionState } from "../state.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface StopFailureHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "StopFailure";
  error: string;
  error_details?: string;
  last_assistant_message?: string;
}

async function main(): Promise<void> {
  const input: StopFailureHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`StopFailure hook: session=${input.session_id}, error=${input.error}`);

  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  if (!sessionState.current_trace_id) {
    debug("No open trace to update");
    return;
  }

  const langfuse = initClient(config.publicKey, config.secretKey, config.baseUrl);
  const errorMessage = input.error_details ? `${input.error}: ${input.error_details}` : input.error;

  try {
    langfuse.trace({
      id: sessionState.current_trace_id,
      output: { error: errorMessage },
      metadata: {
        error: errorMessage,
        turn_number: sessionState.current_turn_number,
      },
      tags: ["claude-code", "error"],
    });
    debug(`Updated trace ${sessionState.current_trace_id} with error: ${errorMessage}`);
  } catch (err) {
    error(`Failed to update trace on StopFailure: ${err}`);
  }

  await atomicUpdateState(config.stateFilePath, (s) => {
    const ss = getSessionState(s, input.session_id);
    return {
      ...s,
      [input.session_id]: {
        ...ss,
        current_trace_id: undefined,
      },
    };
  });

  await flushTraces();
  await shutdownClient();
}

main().catch((err) => {
  try {
    error(`StopFailure hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
