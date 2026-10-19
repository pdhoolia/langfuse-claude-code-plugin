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
import type {
  Turn,
  LLMCall,
  ToolCall,
  Usage,
  SessionState,
  ChatMessage,
  ChatToolResult,
} from "./types.js";
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

/**
 * Map cache-write tokens onto the price key for each cache lifetime.
 *
 * The flat total says nothing about the lifetime, so Langfuse prices it at the
 * cheaper rate. It is used only when the message omits the split.
 */
function buildCacheWriteDetails(usage: Usage): Record<string, number> {
  const details: Record<string, number> = {};
  const split = usage.cache_creation;
  if (split) {
    if (
      typeof split.ephemeral_5m_input_tokens === "number" &&
      split.ephemeral_5m_input_tokens > 0
    ) {
      details.input_cache_creation_5m = split.ephemeral_5m_input_tokens;
    }
    if (
      typeof split.ephemeral_1h_input_tokens === "number" &&
      split.ephemeral_1h_input_tokens > 0
    ) {
      details.input_cache_creation_1h = split.ephemeral_1h_input_tokens;
    }
  }
  if (Object.keys(details).length > 0) return details;

  const flat = usage.cache_creation_input_tokens;
  if (typeof flat === "number" && flat > 0) {
    return { cache_creation_input_tokens: flat };
  }
  return {};
}

/**
 * Build the usage details Langfuse prices a generation from.
 *
 * The key names are the ones the Anthropic model definitions carry, so cache
 * reads and cache writes are billed at their own rates instead of being lost.
 * `total` is left out on purpose — Langfuse sums the other metrics itself, and
 * a total of input + output alone would hide every cached token.
 */
export function buildUsageDetails(usage: Usage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  if (usage.input_tokens > 0) details.input = usage.input_tokens;
  if (usage.output_tokens > 0) details.output = usage.output_tokens;
  if (usage.cache_read_input_tokens && usage.cache_read_input_tokens > 0) {
    details.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  Object.assign(details, buildCacheWriteDetails(usage));
  return Object.keys(details).length > 0 ? details : undefined;
}

// ─── ChatML history ─────────────────────────────────────────────────────────

/**
 * The ChatML assistant message for one LLM call. It is both the generation's
 * output and the message the next generation of the turn sees in its input.
 */
function buildAssistantMessage(llm: LLMCall): ChatMessage {
  const message: ChatMessage = { role: "assistant", content: truncate(extractText(llm.content)) };
  const thinking = extractThinking(llm.content);
  if (thinking) message.thinking = truncate(thinking);
  if (llm.toolCalls.length > 0) {
    // Langfuse renders tool calls only in this nested shape. A flat id and
    // name pair stays raw JSON in the trace UI.
    message.tool_calls = llm.toolCalls.map((tc) => ({
      id: tc.tool_use.id,
      type: "function" as const,
      function: { name: tc.tool_use.name },
    }));
  }
  return message;
}

/**
 * The ChatML tool message carrying the results of one LLM call, or undefined
 * when that call ran no tools (or none of them returned).
 */
function buildToolResultMessage(llm: LLMCall): ChatMessage | undefined {
  const results: ChatToolResult[] = [];
  for (const tc of llm.toolCalls) {
    if (!tc.result) continue;
    results.push({
      tool_use_id: tc.tool_use.id,
      tool_name: tc.tool_use.name,
      output: truncateValue(tc.result.content),
    });
  }
  return results.length > 0 ? { role: "tool", tool_results: results } : undefined;
}

/** The user prompt of a turn, as text. */
function turnUserText(turn: Turn): string {
  return typeof turn.userContent === "string"
    ? truncate(turn.userContent)
    : JSON.stringify(turn.userContent);
}

/**
 * The ChatML view of one turn: the user message, then per LLM call the
 * assistant message and one tool message with that call's results.
 */
export function buildTurnHistoryMessages(turn: Turn): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: turnUserText(turn) }];
  for (const llm of turn.llmCalls) {
    messages.push(buildAssistantMessage(llm));
    const toolMessage = buildToolResultMessage(llm);
    if (toolMessage) messages.push(toolMessage);
  }
  return messages;
}

/** The ChatML history of a whole transcript, with the start of each turn. */
export interface SessionHistory {
  messages: ChatMessage[];
  /** Turn key → index of that turn's first message. */
  startIndexByTurnKey: Map<string, number>;
}

/**
 * Identify a turn within one transcript. The user row's uuid is unique; the
 * timestamp is the fallback for a transcript that carries none, where two
 * turns stamped the same second would share a prefix.
 */
function turnKey(turn: Turn): string {
  return turn.userUuid ?? turn.userTimestamp;
}

/**
 * Rebuild the conversation of a whole transcript file as ChatML.
 *
 * Reads from byte 0 on purpose: the incremental cursor only tracks what was
 * exported, while a generation input needs every earlier message. One extra
 * full read per hook firing is the accepted cost.
 */
export function buildSessionHistory(transcriptPath: string): SessionHistory | undefined {
  try {
    const { messages } = readTranscript(transcriptPath, -1);
    if (messages.length === 0) return undefined;

    const history: SessionHistory = { messages: [], startIndexByTurnKey: new Map() };
    for (const turn of groupIntoTurns(messages)) {
      const key = turnKey(turn);
      if (!history.startIndexByTurnKey.has(key)) {
        history.startIndexByTurnKey.set(key, history.messages.length);
      }
      history.messages.push(...buildTurnHistoryMessages(turn));
    }
    return history;
  } catch (err) {
    logger.debug(`Could not build session history from ${transcriptPath}: ${err}`);
    return undefined;
  }
}

/**
 * Everything said before the given turn, or an empty prefix when the turn is
 * not in the history (a fresh session, or a transcript that moved on).
 */
export function historyPrefixForTurn(
  history: SessionHistory | undefined,
  turn: Turn,
): ChatMessage[] {
  if (!history) return [];
  const startIndex = history.startIndexByTurnKey.get(turnKey(turn));
  if (startIndex === undefined) return [];
  return history.messages.slice(0, startIndex);
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
  /**
   * The conversation before this turn, prepended to every generation input so
   * a call in turn N sees turns 1..N-1. Empty when unavailable.
   */
  historyPrefix?: ChatMessage[];
}

/**
 * Emit one turn as a Langfuse trace with nested generation and tool observations.
 * Returns the trace ID used.
 */
export function emitTurn(options: EmitTurnOptions): string {
  const { sessionId, turnNum, turn, transcriptName, traceId, toolStartTimes, historyPrefix } =
    options;

  if (!client) throw new Error("Langfuse client not initialized — call initClient() first");

  const traceName = `Claude Code - Turn ${turnNum}`;
  const userText = turnUserText(turn);
  const finalText =
    turn.llmCalls.length > 0
      ? truncate(extractText(turn.llmCalls[turn.llmCalls.length - 1].content))
      : "";

  // Create or update the trace (upsert if traceId provided). The trace input
  // stays the turn's own prompt — the history belongs on the generations, and
  // a scannable trace list is worth more here.
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

  emitLLMCalls(trace, turn, historyPrefix, toolStartTimes);

  return trace.id;
}

/**
 * Emit every LLM call of a turn, growing the conversation as it goes: each
 * generation's input is everything said before it — the earlier turns, this
 * turn's prompt, and the assistant and tool messages of the earlier calls.
 */
function emitLLMCalls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parent: any,
  turn: Turn,
  historyPrefix: ChatMessage[] | undefined,
  toolStartTimes?: Record<string, number>,
): void {
  const history: ChatMessage[] = [...(historyPrefix ?? [])];
  history.push({ role: "user", content: turnUserText(turn) });

  for (let i = 0; i < turn.llmCalls.length; i++) {
    const llm = turn.llmCalls[i];
    const assistantMessage = emitLLMCall(
      parent,
      i + 1,
      turn.llmCalls.length,
      llm,
      [...history],
      toolStartTimes,
    );
    history.push(assistantMessage);
    const toolMessage = buildToolResultMessage(llm);
    if (toolMessage) history.push(toolMessage);
  }
}

/**
 * Emit one LLM call as a generation with child tool spans.
 * Returns the assistant message it emitted, for the caller's history.
 */
function emitLLMCall(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace: any,
  index: number,
  total: number,
  llm: LLMCall,
  input: ChatMessage[],
  toolStartTimes?: Record<string, number>,
): ChatMessage {
  const genName = total > 1 ? `LLM Call ${index}/${total}` : "Claude Response";

  // The output doubles as this call's message in the conversation history.
  const output = buildAssistantMessage(llm);
  const thinking = output.thinking;
  const usageDetails = buildUsageDetails(llm.usage);

  const gen = trace.generation({
    name: genName,
    model: llm.model,
    input,
    output,
    usageDetails,
    metadata: {
      history_messages: input.length,
      stop_reason: llm.stopReason ?? "",
      timestamp: llm.endTime,
      has_thinking: String(!!thinking),
      ...(llm.usage.cache_read_input_tokens
        ? { cache_read_input_tokens: llm.usage.cache_read_input_tokens }
        : {}),
      ...(llm.usage.cache_creation_input_tokens
        ? { cache_creation_input_tokens: llm.usage.cache_creation_input_tokens }
        : {}),
      ...(llm.usage.cache_creation ? { cache_creation: llm.usage.cache_creation } : {}),
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

  return output;
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
          const turn = turns[turns.length - 1];
          const sessionHistory = buildSessionHistory(transcriptPath);
          emitTurn({
            sessionId,
            turnNum: sessionState.turn_count + 1,
            turn,
            transcriptName: transcriptPath.split("/").pop() ?? "",
            traceId: sessionState.current_trace_id,
            toolStartTimes: sessionState.tool_start_times,
            historyPrefix: historyPrefixForTurn(sessionHistory, turn),
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

      // A subagent transcript is complete on disk, so its history accumulates
      // across turns the same way the main session's does.
      const subagentHistory: ChatMessage[] = [];

      for (let i = 0; i < subagentTurns.length; i++) {
        const turn = subagentTurns[i];
        const userText = turnUserText(turn);
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

        emitLLMCalls(turnSpan, turn, [...subagentHistory]);
        subagentHistory.push(...buildTurnHistoryMessages(turn));

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
