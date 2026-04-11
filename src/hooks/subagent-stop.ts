#!/usr/bin/env node
/**
 * SubagentStop hook entry point.
 *
 * Invoked when a Claude Code subagent finishes. Queues the subagent info
 * into `pending_subagent_traces` in the shared state file.
 *
 * The Stop hook picks these up and traces them.
 */

import { debug, error } from "../logger.js";
import { atomicUpdateState, getSessionState } from "../state.js";
import { initHook, expandHome } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";
import type { SubagentStopHookInput } from "../types.js";

async function main(): Promise<void> {
  const input: SubagentStopHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`SubagentStop hook: agent_id=${input.agent_id}, type=${input.agent_type}`);

  const agentTranscriptPath = expandHome(input.agent_transcript_path);

  if (!agentTranscriptPath) {
    debug("No agent_transcript_path provided, skipping");
    return;
  }

  await atomicUpdateState(config.stateFilePath, (state) => {
    const parentSessionState = getSessionState(state, input.session_id);
    return {
      ...state,
      [input.session_id]: {
        ...parentSessionState,
        pending_subagent_traces: [
          ...(parentSessionState.pending_subagent_traces || []),
          {
            agent_id: input.agent_id,
            agent_type: input.agent_type,
            agent_transcript_path: agentTranscriptPath,
            session_id: input.session_id,
          },
        ],
      },
    };
  });

  debug(
    `Queued subagent trace for ${input.agent_type} (${input.agent_id}) — will be processed by Stop hook`,
  );
}

main().catch((err) => {
  try {
    error(`SubagentStop hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
