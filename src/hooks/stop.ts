#!/usr/bin/env node
/**
 * Stop hook entry point.
 *
 * Invoked by Claude Code when the main agent finishes responding.
 * Reads the transcript, identifies new messages since last run,
 * groups them into turns, and sends traces to Langfuse.
 *
 * Produces nested traces: Trace → Generation(s) → Tool span(s),
 * preserving the causal relationship between LLM calls and tool use.
 */

import { readTranscript, groupIntoTurns, extractText } from "../transcript.js";
import { log, warn, debug, error } from "../logger.js";
import { loadState, atomicUpdateState, getSessionState, pruneOldSessions } from "../state.js";
import {
  initClient,
  setMaxChars,
  emitTurn,
  tracePendingSubagents,
  flushTraces,
  shutdownClient,
} from "../langfuse.js";
import { initHook, expandHome } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";
import type { StopHookInput } from "../types.js";

async function main(): Promise<void> {
  const startTime = Date.now();

  const input: StopHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`Stop hook started, session=${input.session_id}`);

  // Skip recursive hook calls.
  if (input.stop_hook_active) {
    debug("stop_hook_active=true, skipping");
    return;
  }

  // Validate input.
  const transcriptPath = expandHome(input.transcript_path);
  if (!input.session_id || !transcriptPath) {
    warn(`Invalid input: session=${input.session_id}, transcript=${transcriptPath}`);
    return;
  }

  initClient(config.publicKey, config.secretKey, config.baseUrl);
  setMaxChars(config.maxChars);

  // Load state and read new messages.
  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  debug(`Last line: ${sessionState.last_line}, turn count: ${sessionState.turn_count}`);

  // Wait briefly for the transcript writer to flush.
  await new Promise((r) => setTimeout(r, 200));

  const { messages, lastLine } = readTranscript(transcriptPath, sessionState.last_line);
  if (messages.length === 0) {
    debug("No new messages");
    if (sessionState.current_trace_id) {
      await atomicUpdateState(config.stateFilePath, (s) => {
        const ss = getSessionState(s, input.session_id);
        return { ...s, [input.session_id]: { ...ss, current_trace_id: undefined } };
      });
    }
    return;
  }

  log(`Found ${messages.length} new messages`);

  // Group into turns and trace each one.
  const turns = groupIntoTurns(messages);

  // Patch the last turn if the final LLM response is missing from transcript.
  if (turns.length > 0 && input.last_assistant_message) {
    const lastTurn = turns[turns.length - 1];
    const lastLlm = lastTurn.llmCalls[lastTurn.llmCalls.length - 1];
    if (lastLlm && lastLlm.toolCalls.length > 0) {
      debug("Final LLM response missing from transcript, synthesizing from last_assistant_message");
      const syntheticStart = sessionState.last_tool_end_time
        ? new Date(sessionState.last_tool_end_time).toISOString()
        : (lastLlm.toolCalls[lastLlm.toolCalls.length - 1].result?.timestamp ?? lastLlm.endTime);
      const syntheticEnd = new Date(startTime).toISOString();
      lastTurn.llmCalls.push({
        content: [{ type: "text", text: input.last_assistant_message }],
        model: lastLlm.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        startTime: syntheticStart,
        endTime: syntheticEnd,
        toolCalls: [],
        synthetic: true,
      });
    }
  }

  let tracedTurns = 0;
  const currentTraceId = sessionState.current_trace_id;
  const transcriptName = transcriptPath.split("/").pop() ?? "";

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLastTurn = i === turns.length - 1;
    const turnNum = sessionState.turn_count + tracedTurns + 1;

    // Only the last turn gets the pre-allocated trace from UserPromptSubmit
    const traceId = isLastTurn ? currentTraceId : undefined;

    try {
      emitTurn({
        sessionId: input.session_id,
        turnNum,
        turn,
        transcriptName,
        traceId,
        toolStartTimes: isLastTurn ? sessionState.tool_start_times : undefined,
      });
      tracedTurns++;
    } catch (err) {
      error(`Failed to trace turn ${turnNum}: ${err}`);
    }
  }

  // Re-read state for pending subagent traces
  const freshState = loadState(config.stateFilePath);
  const freshSession = getSessionState(freshState, input.session_id);
  const mergedTaskRunMap = { ...freshSession.task_run_map };

  const pendingSubagents = freshSession.pending_subagent_traces || [];
  if (pendingSubagents.length > 0) {
    debug(`Processing ${pendingSubagents.length} pending subagent trace(s)`);
    tracePendingSubagents({
      sessionId: input.session_id,
      pendingSubagents,
      taskRunMap: mergedTaskRunMap,
      parentTraceId: freshSession.current_trace_id,
    });
  }

  // Save updated state
  const savedLastLine = tracedTurns > 0 ? lastLine : sessionState.last_line;
  await atomicUpdateState(config.stateFilePath, (latestState) => {
    const latestSession = getSessionState(latestState, input.session_id);
    const updatedState = {
      ...latestState,
      [input.session_id]: {
        ...latestSession,
        last_line: savedLastLine,
        turn_count: latestSession.turn_count + tracedTurns,
        updated: new Date().toISOString(),
        current_trace_id: undefined,
        pending_subagent_traces: [],
        tool_start_times: {},
        task_run_map: {},
      },
    };
    return pruneOldSessions(updatedState);
  });

  // Flush outside the lock
  await flushTraces();
  await shutdownClient();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Processed ${tracedTurns} turns in ${duration}s`);

  if (Date.now() - startTime > 180_000) {
    warn(`Hook took ${duration}s (>3min), consider optimizing`);
  }
}

main().catch((err) => {
  try {
    error(`Stop hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0); // Always exit 0 so Claude Code isn't affected.
});
