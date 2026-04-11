#!/usr/bin/env node
/**
 * PostToolUse hook entry point.
 *
 * Fires after a tool executes. Records tool end time and, for Agent tools,
 * stores deferred creation info in state so the Stop hook can create the
 * observation with the real subagent name.
 *
 * Does NOT create Langfuse observations directly — tools are traced by the
 * Stop hook as children of their parent generation to preserve the nested
 * hierarchy (Generation → Tool spans).
 */

import { randomUUID } from "node:crypto";
import { debug, error } from "../logger.js";
import { atomicUpdateState, getSessionState } from "../state.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface PostToolUseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
  agent_id?: string;
  agent_type?: string;
}

async function main(): Promise<void> {
  const input: PostToolUseHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  // Skip subagent tool calls — traced by the Stop hook.
  if (input.agent_id || input.agent_type) {
    debug("Skipping PostToolUse for subagent tool — Stop hook handles tracing");
    return;
  }

  const toolEndTime = Date.now();
  const agentId = (input.tool_response as { agentId?: string }).agentId;

  if (agentId) {
    debug(`Agent tool detected, deferring observation creation for ${agentId}`);
  }

  const startTime = Date.now();

  await atomicUpdateState(config.stateFilePath, (freshState) => {
    const freshSession = getSessionState(freshState, input.session_id);
    const toolStartTime = freshSession.tool_start_times?.[input.tool_use_id] ?? startTime;

    return {
      ...freshState,
      [input.session_id]: {
        ...freshSession,
        last_tool_end_time: toolEndTime,
        ...(agentId
          ? {
              task_run_map: {
                ...freshSession.task_run_map,
                [agentId]: {
                  observation_id: randomUUID(),
                  deferred: {
                    tool_name: input.tool_name,
                    tool_input: input.tool_input,
                    tool_output: input.tool_response,
                    start_time: toolStartTime,
                    end_time: toolEndTime,
                  },
                },
              },
            }
          : {}),
      },
    };
  });
}

main().catch((err) => {
  try {
    error(`PostToolUse hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
