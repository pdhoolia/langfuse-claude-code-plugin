/**
 * Langfuse run construction and submission.
 *
 * Converts parsed Turns into Langfuse trace hierarchies:
 *   Trace (Turn)
 *   ├── Generation: "LLM Call 1/3"  (model, usage, thinking)
 *   │    ├── Span: "Tool: Glob"     (input, output, duration)
 *   │    └── Span: "Tool: Read"
 *   ├── Generation: "LLM Call 2/3"
 *   │    └── Span: "Tool: Edit"
 *   └── Generation: "LLM Call 3/3"  (final response)
 *
 * Tools are nested under their parent generation (not siblings),
 * preserving the causal relationship between LLM calls and tool use.
 */

import Langfuse from "langfuse";
import { randomUUID } from "node:crypto";
import type { Turn, LLMCall, ToolCall, Usage, SessionState } from "./types.js";
import { readTranscript, groupIntoTurns, extractText, extractThinking } from "./transcript.js";
import * as logger from "./logger.js";

// ─── Client setup ───────────────────────────────────────────────────────────

let client: Langfuse | null = null;

export function initClient(publicKey: string, secretKey: string, baseUrl: string): Langfuse {
  client = new Langfuse({ publicKey, secretKey, baseUrl });
  return client;
}

/** Flush all pending events to ensure traces are sent before hook exits. */
export async function flushTraces(): Promise<void> {
  if (!client) {
    logger.warn("Cannot flush: client not initialized");
    return;
  }
  logger.debug("Flushing Langfuse traces...");
  await client.flushAsync();
  logger.debug("Langfuse traces flushed");
}

/** Shut down the Langfuse client (flushes remaining events). */
export async function shutdownClient(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdownAsync();
  } catch {
    // Best-effort shutdown
  }
}

// ─── Score posting (for /feedback and /journey CLIs) ────────────────────────

export interface PostScoreOptions {
  /** Deterministic, idempotent score ID — Langfuse upserts on this key. */
  id: string;
  /** Score name (e.g. "turn_feedback" or "session_feedback"). */
  name: string;
  /** Numeric value (e.g. +1 / -1). */
  value: number;
  /** Optional comment shown in the Langfuse score detail. */
  comment?: string;
  /** Attach to a trace (turn-scope). Mutually exclusive with sessionId in practice. */
  traceId?: string;
  /** Attach to a session (session-scope). */
  sessionId?: string;
}

/**
 * Post a score to Langfuse. Idempotent on `id` — same id with new value/comment
 * upserts the existing row.
 */
export function postScore(options: PostScoreOptions): void {
  if (!client) {
    logger.warn("Cannot post score: client not initialized");
    return;
  }
  client.score({
    id: options.id,
    name: options.name,
    value: options.value,
    comment: options.comment,
    traceId: options.traceId,
    sessionId: options.sessionId,
  });
}

// ─── Truncation ─────────────────────────────────────────────────────────────

let maxChars = 50000;

export function setMaxChars(max: number): void {
  maxChars = max;
}

function truncate(text: string): string {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[...truncated, ${text.length - maxChars} more chars]`;
}

function truncateValue(v: unknown): unknown {
  if (typeof v === "string") return truncate(v);
  if (Array.isArray(v)) return v.map(truncateValue);
  if (v && typeof v === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) {
      result[key] = truncateValue(val);
    }
    return result;
  }
  return v;
}

// ─── Usage formatting ───────────────────────────────────────────────────────

/** Build usage object for Langfuse generation. */
function buildUsage(usage: Usage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  if (usage.input_tokens > 0) details.input = usage.input_tokens;
  if (usage.output_tokens > 0) details.output = usage.output_tokens;
  if (usage.input_tokens > 0 || usage.output_tokens > 0) {
    details.total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

// ─── Turn emission ──────────────────────────────────────────────────────────

export interface EmitTurnOptions {
  sessionId: string;
  turnNum: number;
  turn: Turn;
  transcriptName: string;
  /** Pre-allocated trace ID from UserPromptSubmit. */
  traceId?: string;
  /** Tool start times from PreToolUse (tool_use_id -> wall-clock ms). */
  toolStartTimes?: Record<string, number>;
}

/**
 * Emit one turn as a Langfuse trace with nested generation and tool observations.
 * Returns the trace ID used.
 */
export function emitTurn(options: EmitTurnOptions): string {
  const { sessionId, turnNum, turn, transcriptName, traceId, toolStartTimes } = options;

  if (!client) throw new Error("Langfuse client not initialized — call initClient() first");

  const traceName = `Claude Code - Turn ${turnNum}`;
  const userText =
    typeof turn.userContent === "string"
      ? truncate(turn.userContent)
      : JSON.stringify(turn.userContent);
  const finalText =
    turn.llmCalls.length > 0
      ? truncate(extractText(turn.llmCalls[turn.llmCalls.length - 1].content))
      : "";

  // Create or update the trace (upsert if traceId provided)
  const trace = client.trace({
    id: traceId || randomUUID(),
    name: traceName,
    sessionId,
    input: { role: "user", content: userText },
    output: { role: "assistant", content: finalText },
    tags: ["claude-code"],
    metadata: {
      source: "claude-code",
      turn_number: turnNum,
      transcript: transcriptName,
      is_complete: turn.isComplete,
    },
  });

  for (let i = 0; i < turn.llmCalls.length; i++) {
    emitLLMCall(trace, i + 1, turn.llmCalls.length, turn.llmCalls[i], userText, toolStartTimes);
  }

  return trace.id;
}

/** Emit one LLM call as a generation with child tool spans. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitLLMCall(
  trace: any,
  index: number,
  total: number,
  llm: LLMCall,
  userText: string,
  toolStartTimes?: Record<string, number>,
): void {
  const genName = total > 1 ? `LLM Call ${index}/${total}` : "Claude Response";

  // Build output preserving thinking blocks
  const text = truncate(extractText(llm.content));
  const thinking = extractThinking(llm.content);
  const output: Record<string, unknown> = { role: "assistant", text };
  if (thinking) output.thinking = truncate(thinking);
  if (llm.toolCalls.length > 0) {
    output.tool_calls = llm.toolCalls.map((tc) => ({
      name: tc.tool_use.name,
      id: tc.tool_use.id,
    }));
  }

  const usage = buildUsage(llm.usage);

  const gen = trace.generation({
    name: genName,
    model: llm.model,
    input: { role: "user", content: userText },
    output,
    usage,
    metadata: {
      stop_reason: llm.stopReason ?? "",
      timestamp: llm.endTime,
      has_thinking: String(!!thinking),
      ...(llm.usage.cache_read_input_tokens
        ? { cache_read_input_tokens: llm.usage.cache_read_input_tokens }
        : {}),
      ...(llm.usage.cache_creation_input_tokens
        ? { cache_creation_input_tokens: llm.usage.cache_creation_input_tokens }
        : {}),
      ...(llm.synthetic ? { synthetic: true } : {}),
    },
    startTime: new Date(llm.startTime),
    endTime: new Date(llm.endTime),
  });

  // Tool observations nested under this generation
  for (const tc of llm.toolCalls) {
    emitTool(gen, tc, toolStartTimes);
  }

  gen.end();
}

/** Emit one tool call as a span under its parent generation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitTool(parent: any, tc: ToolCall, toolStartTimes?: Record<string, number>): void {
  const toolInput = truncateValue(tc.tool_use.input);
  const toolOutput = tc.result ? truncateValue(tc.result.content) : undefined;

  const meta: Record<string, unknown> = { tool_id: tc.tool_use.id };
  if (tc.result?.durationMs !== undefined) {
    meta.duration_ms = tc.result.durationMs;
  }
  if (tc.result?.timestamp) {
    meta.timestamp = tc.result.timestamp;
  }
  if (tc.agentId) {
    meta.agent_id = tc.agentId;
  }

  // Use wall-clock start time from PreToolUse if available
  const wallClockStart = toolStartTimes?.[tc.tool_use.id];
  const startTime = wallClockStart ? new Date(wallClockStart) : undefined;
  const endTime = tc.result?.timestamp ? new Date(tc.result.timestamp) : undefined;

  const span = parent.span({
    name: `Tool: ${tc.tool_use.name}`,
    input: toolInput,
    output: toolOutput,
    metadata: meta,
    startTime,
    endTime,
  });

  span.end();
}

// ─── Interrupted turn recovery ──────────────────────────────────────────────

/**
 * Close an interrupted turn (Stop never fired for it).
 * Traces any LLM calls from the transcript, updates the trace with error status.
 *
 * Used by UserPromptSubmit (on next prompt in same session) and SessionEnd.
 */
export async function closeInterruptedTurn(options: {
  sessionId: string;
  sessionState: SessionState;
  transcriptPath: string | undefined;
  config: { maxChars: number };
}): Promise<{ lastLine: number; turnsTraced: number; finalizedTraceId?: string }> {
  const { sessionId, sessionState, transcriptPath, config } = options;

  if (!client) throw new Error("Langfuse client not initialized");

  let lastLine = sessionState.last_line;
  let turnsTraced = 0;

  // Trace LLM calls from the transcript if available
  if (transcriptPath) {
    try {
      const { messages, lastLine: newLastLine } = readTranscript(
        transcriptPath,
        sessionState.last_line,
      );
      if (messages.length > 0) {
        const turns = groupIntoTurns(messages);
        if (turns.length > 0) {
          setMaxChars(config.maxChars);
          emitTurn({
            sessionId,
            turnNum: sessionState.turn_count + 1,
            turn: turns[turns.length - 1],
            transcriptName: transcriptPath.split("/").pop() ?? "",
            traceId: sessionState.current_trace_id,
            toolStartTimes: sessionState.tool_start_times,
          });
          lastLine = newLastLine;
          turnsTraced = 1;
        }
      }
    } catch (err) {
      logger.error(`Failed to trace interrupted turn transcript: ${err}`);
    }
  }

  // Update the trace with interrupt status
  if (sessionState.current_trace_id) {
    try {
      client.trace({
        id: sessionState.current_trace_id,
        metadata: { interrupted: true, error: "User interrupt" },
        tags: ["claude-code", "interrupted"],
      });
    } catch (err) {
      logger.error(`Failed to update interrupted trace: ${err}`);
    }
  }

  await flushTraces();

  // ADR-008: interrupted turns count as substantive — caller writes this into
  // last_substantive_trace_id so /feedback can target them.
  return {
    lastLine,
    turnsTraced,
    finalizedTraceId: turnsTraced > 0 ? sessionState.current_trace_id : undefined,
  };
}

// ─── Subagent tracing ────────────────────────────────────────────────────────

export interface PendingSubagent {
  agent_id: string;
  agent_type: string;
  agent_transcript_path: string;
  session_id: string;
}

/**
 * Trace pending subagents queued by SubagentStop.
 * Creates observations for each subagent's transcript under the parent trace.
 */
export function tracePendingSubagents(options: {
  sessionId: string;
  pendingSubagents: PendingSubagent[];
  taskRunMap: Record<string, { observation_id: string; deferred: Record<string, unknown> }>;
  parentTraceId: string | undefined;
}): void {
  const { pendingSubagents, taskRunMap, parentTraceId } = options;

  if (!client) {
    throw new Error("Langfuse client not initialized");
  }

  if (!parentTraceId) {
    logger.warn("Cannot trace subagents: no parent trace ID");
    return;
  }

  const parentTrace = client.trace({ id: parentTraceId });

  for (const subagent of pendingSubagents) {
    try {
      const taskRunInfo = taskRunMap[subagent.agent_id];
      const toolName = subagent.agent_type || "Agent";

      logger.debug(`Processing subagent ${toolName} (${subagent.agent_id})`);

      // If PostToolUse deferred an Agent tool span, create it now
      if (taskRunInfo?.deferred) {
        const def = taskRunInfo.deferred;
        parentTrace.span({
          id: taskRunInfo.observation_id,
          name: `Tool: Agent (${toolName})`,
          input: def.tool_input as Record<string, unknown>,
          output: def.tool_output as Record<string, unknown>,
          startTime: new Date(def.start_time as number),
          endTime: new Date(def.end_time as number),
          metadata: { agent_id: subagent.agent_id, agent_type: toolName },
        });
      }

      // Read subagent transcript and trace its turns
      const { messages: subagentMessages } = readTranscript(subagent.agent_transcript_path, -1);
      if (subagentMessages.length === 0) {
        logger.debug(`Empty subagent transcript: ${subagent.agent_transcript_path}`);
        continue;
      }

      const subagentTurns = groupIntoTurns(subagentMessages);

      // Create a grouping span for all subagent turns
      const subagentSpan = parentTrace.span({
        name: `${toolName} Subagent`,
        metadata: {
          agent_id: subagent.agent_id,
          agent_type: toolName,
          turns: subagentTurns.length,
        },
      });

      for (let i = 0; i < subagentTurns.length; i++) {
        const turn = subagentTurns[i];
        const userText =
          typeof turn.userContent === "string"
            ? truncate(turn.userContent)
            : JSON.stringify(turn.userContent);
        const finalText =
          turn.llmCalls.length > 0
            ? truncate(extractText(turn.llmCalls[turn.llmCalls.length - 1].content))
            : "";

        const turnSpan = subagentSpan.span({
          name: `Subagent Turn ${i + 1}`,
          input: { role: "user", content: userText },
          output: { role: "assistant", content: finalText },
          metadata: { turn_number: i + 1 },
        });

        for (let j = 0; j < turn.llmCalls.length; j++) {
          emitLLMCall(turnSpan, j + 1, turn.llmCalls.length, turn.llmCalls[j], userText);
        }

        turnSpan.end();
      }

      subagentSpan.end();
      logger.log(
        `Traced subagent ${toolName} (${subagent.agent_id}): ${subagentTurns.length} turn(s)`,
      );
    } catch (err) {
      logger.error(`Failed to trace subagent ${subagent.agent_id}: ${err}`);
    }
  }
}
