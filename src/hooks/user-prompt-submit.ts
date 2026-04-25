#!/usr/bin/env node
/**
 * UserPromptSubmit hook entry point.
 *
 * Invoked when a user submits a prompt, before Claude processes it.
 * Creates the initial Langfuse trace for the turn and stores the trace ID
 * for the Stop hook to use as parent for all LLM and tool observations.
 *
 * Also handles interrupted turns: if Stop never fired for the previous turn,
 * traces the interrupted turn's content before closing it.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { debug, error } from "../logger.js";
import { initClient, closeInterruptedTurn, flushTraces, setMaxChars } from "../langfuse.js";
import { loadState, atomicUpdateState, getSessionState, setActiveByCwd } from "../state.js";
import { getTranscriptEndLine } from "../transcript.js";
import { initHook, expandHome } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";
import { isFeedbackCommand } from "../scoring/match.js";

interface UserPromptSubmitHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
  agent_id?: string;
  agent_type?: string;
}

async function main(): Promise<void> {
  const hookStartTime = Date.now();
  const input: UserPromptSubmitHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`UserPromptSubmit hook started, session=${input.session_id}`);

  // Subagent turns are traced entirely by the Stop hook from the transcript.
  if (input.agent_id || input.agent_type) {
    debug("Skipping UserPromptSubmit for subagent — Stop hook handles tracing");
    return;
  }

  // Always claim cwd → session ownership for slash-command lookup (FR-4 / ADR-006).
  // This must happen even for feedback commands; the lookup map is purely about
  // "which session is active in this cwd", not about turn type.
  const realCwd = safeRealpath(input.cwd);
  await atomicUpdateState(config.stateFilePath, (s) =>
    setActiveByCwd(s, realCwd, input.session_id),
  );

  // ADR-002: feedback turns (/feedback, /journey) skip trace allocation entirely.
  // Stop will see no current_trace_id and gracefully no-op (advancing last_line).
  // Without this, last_substantive_trace_id would drift to point at the feedback
  // turn itself, breaking the targeting semantics for the next /feedback.
  if (isFeedbackCommand(input.prompt)) {
    debug(
      `Feedback command detected (prompt prefix: ${input.prompt.split(/\s/)[0]}); ` +
        `skipping trace allocation`,
    );
    return;
  }

  const langfuse = initClient(config.publicKey, config.secretKey, config.baseUrl);
  setMaxChars(config.maxChars);

  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  // If state is fresh but transcript already has content, skip to the end.
  let interruptedLastLine = sessionState.last_line;
  if (interruptedLastLine === -1 && input.transcript_path) {
    const transcriptPath = expandHome(input.transcript_path)!;
    const endLine = getTranscriptEndLine(transcriptPath);
    if (endLine > 0) {
      debug(`Fresh state but transcript has ${endLine + 1} lines — skipping to end`);
      interruptedLastLine = endLine;
    }
  }

  // If there's a stale trace, the previous turn was interrupted.
  let interruptedTurnsTraced = 0;
  if (sessionState.current_trace_id) {
    debug(`Tracing interrupted turn (trace ${sessionState.current_trace_id})`);
    try {
      const { lastLine, turnsTraced } = await closeInterruptedTurn({
        sessionId: input.session_id,
        sessionState,
        transcriptPath: expandHome(input.transcript_path),
        config: { maxChars: config.maxChars },
      });
      interruptedLastLine = lastLine;
      interruptedTurnsTraced = turnsTraced;
    } catch (err) {
      error(`Failed to close interrupted turn: ${err}`);
    }
  }

  const turnNum = sessionState.turn_count + interruptedTurnsTraced + 1;
  const traceId = randomUUID();

  // Create the trace eagerly so it appears in Langfuse immediately
  langfuse.trace({
    id: traceId,
    name: `Claude Code - Turn ${turnNum}`,
    sessionId: input.session_id,
    input: { role: "user", content: input.prompt },
    tags: ["claude-code"],
    metadata: {
      source: "claude-code",
      turn_number: turnNum,
    },
  });

  debug(`Created trace ${traceId} for turn ${turnNum}`);

  await flushTraces();

  await atomicUpdateState(config.stateFilePath, (s) => {
    const ss = getSessionState(s, input.session_id);
    return {
      ...s,
      [input.session_id]: {
        ...ss,
        current_trace_id: traceId,
        current_turn_number: turnNum,
        current_turn_start: hookStartTime,
        last_line: interruptedLastLine,
        turn_count: ss.turn_count + interruptedTurnsTraced,
        // Clear interrupted turn's stale data
        task_run_map: {},
        tool_start_times: {},
        pending_subagent_traces: [],
      },
    };
  });

  const duration = ((Date.now() - hookStartTime) / 1000).toFixed(1);
  debug(`UserPromptSubmit hook completed in ${duration}s`);
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
    error(`UserPromptSubmit hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
