#!/usr/bin/env node
/**
 * PostCompact hook entry point.
 *
 * Fires after Claude Code completes a compact operation.
 * Creates a Langfuse span capturing the compaction event and summary.
 */

import { debug, error } from "../logger.js";
import { initClient, flushTraces, shutdownClient } from "../langfuse.js";
import { loadState, atomicUpdateState, getSessionState } from "../state.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface PostCompactHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
}

async function main(): Promise<void> {
  const input: PostCompactHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`PostCompact hook started, session=${input.session_id}, trigger=${input.trigger}`);

  const langfuse = initClient(config.publicKey, config.secretKey, config.baseUrl);

  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  const endTime = Date.now();
  const startTime = sessionState.compaction_start_time ?? endTime;

  // If there's an active trace, add compaction as a child span.
  // Otherwise, create a standalone trace for the compaction event.
  if (sessionState.current_trace_id) {
    try {
      const trace = langfuse.trace({ id: sessionState.current_trace_id });
      const span = trace.span({
        name: `Context Compaction (${input.trigger})`,
        input: {},
        output: { compact_summary: input.compact_summary },
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        metadata: {
          trigger: input.trigger,
          session_id: input.session_id,
        },
      });
      span.end();
      debug(`Created compaction span under trace ${sessionState.current_trace_id}`);
    } catch (err) {
      error(`Failed to create compaction span: ${err}`);
    }
  } else {
    try {
      langfuse.trace({
        name: `Context Compaction (${input.trigger})`,
        sessionId: input.session_id,
        input: {},
        output: { compact_summary: input.compact_summary },
        tags: ["claude-code", "compaction"],
        metadata: {
          source: "claude-code",
          trigger: input.trigger,
        },
      });
      debug(`Created standalone compaction trace`);
    } catch (err) {
      error(`Failed to create compaction trace: ${err}`);
    }
  }

  // Clear compaction_start_time from state
  await atomicUpdateState(config.stateFilePath, (s) => {
    const ss = getSessionState(s, input.session_id);
    return {
      ...s,
      [input.session_id]: { ...ss, compaction_start_time: undefined },
    };
  });

  await flushTraces();
  await shutdownClient();
}

main().catch((err) => {
  try {
    error(`PostCompact hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
