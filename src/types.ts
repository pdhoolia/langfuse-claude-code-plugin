/**
 * Types for Claude Code hook inputs and JSONL transcript messages.
 */

// ─── Hook Input Types ───────────────────────────────────────────────���───────

/** Common fields present in all hook inputs (delivered via stdin JSON). */
export interface HookInputBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
}

/** Input for the Stop hook. */
export interface StopHookInput extends HookInputBase {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** Input for the SubagentStop hook. */
export interface SubagentStopHookInput extends HookInputBase {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_id: string;
  agent_type: string;
  agent_transcript_path: string;
  last_assistant_message: string;
}

// ─── Transcript Message Types ────────────────────────────────────────���──────

/** A text content block in an assistant message. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A thinking content block in an assistant message. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

/** A tool_use content block in an assistant message. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool_result content block in a tool result message. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

/** Token usage data from an assistant message. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A user message (human input) in the transcript. */
export interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  timestamp: string;
  promptId?: string;
}

/** A tool result message in the transcript (also role: "user"). */
export interface ToolResultMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultBlock[];
  };
  timestamp: string;
  promptId?: string;
  /** Present on Agent tool results — links to subagent transcript. */
  toolUseResult?: {
    agentId: string;
    durationMs?: number;
  };
}

/** An assistant message in the transcript. */
export interface AssistantMessage {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    model: string;
    content: ContentBlock[];
    usage: Usage;
    stop_reason?: string | null;
  };
  timestamp: string;
  promptId?: string;
}

export type TranscriptMessage = UserMessage | ToolResultMessage | AssistantMessage;

// ─── Parsed Turn (grouped messages) ────────────────────────────────────────

/** A tool invocation paired with its result. */
export interface ToolCall {
  tool_use: ToolUseBlock;
  result?: {
    content: string;
    timestamp: string;
    durationMs?: number;
  };
  /** If this was an Agent tool, the agent ID for subagent tracing. */
  agentId?: string;
}

/** A single LLM response, possibly with tool calls. */
export interface LLMCall {
  /** Merged content from all streaming chunks. */
  content: ContentBlock[];
  /** Model name (date suffix stripped). */
  model: string;
  /** Final cumulative usage. */
  usage: Usage;
  /** Timestamp of first chunk (start time). */
  startTime: string;
  /** Timestamp of last chunk (end time). */
  endTime: string;
  /** Tool calls made in this response. */
  toolCalls: ToolCall[];
  /** Stop reason from the LLM. */
  stopReason?: string | null;
  /** True if this LLM call was synthesized (not from the transcript). */
  synthetic?: boolean;
}

/** A complete turn: one user prompt → one or more LLM calls. */
export interface Turn {
  userContent: string | Array<Record<string, unknown>>;
  userTimestamp: string;
  llmCalls: LLMCall[];
  /** Whether the turn is complete (has stop_reason: "end_turn"). */
  isComplete: boolean;
}

// ─── Tracing State ─────────────────────────────────────────────────────────

export interface SessionState {
  last_line: number;
  turn_count: number;
  updated: string;
  /** Current turn's Langfuse trace ID, set by UserPromptSubmit hook */
  current_trace_id?: string;
  /**
   * Most recent COMPLETED substantive turn's trace ID.
   * - Written by Stop after a successful, non-feedback emission (ADR-002, ADR-003).
   * - Written by closeInterruptedTurn (interrupted turns count as substantive — ADR-008).
   * - Read by /feedback (target) and used as the gate for both /feedback and /journey (ADR-007).
   * - Never points to a feedback-command turn (those skip trace allocation — ADR-002).
   */
  last_substantive_trace_id?: string;
  /** Current turn number (1-based), set by UserPromptSubmit for Stop to use */
  current_turn_number?: number;
  /** Current turn start time for duration calculation */
  current_turn_start?: number;
  /** Wall-clock time (ms) when the last tool finished, set by PostToolUse */
  last_tool_end_time?: number;
  /** Maps tool_use_id -> wall-clock start time (ms), set by PreToolUse */
  tool_start_times?: Record<string, number>;
  /** Maps agent_id -> deferred Agent tool creation info for subagent linking */
  task_run_map?: Record<
    string,
    {
      observation_id: string;
      deferred: {
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_output: Record<string, unknown>;
        start_time: number;
        end_time: number;
      };
    }
  >;
  /** Wall-clock time (ms) when the last PreCompact hook fired */
  compaction_start_time?: number;
  /** Pending subagent traces to process (set by SubagentStop, processed by Stop) */
  pending_subagent_traces?: Array<{
    agent_id: string;
    agent_type: string;
    agent_transcript_path: string;
    session_id: string;
  }>;
}

/**
 * Top-level state shape (persisted to ~/.claude/state/langfuse_state.json).
 *
 * Session entries are keyed by session_id (UUID-shaped strings).
 *
 * Reserved underscore-prefixed keys hold non-session data:
 *   - _active_by_cwd: maps absolute, realpath-resolved cwd → session_id
 *     of the most recent UserPromptSubmit invocation in that cwd.
 *     Read by slash command CLIs (/feedback, /journey) to find the active session.
 *
 * Direct indexing outside `state.ts` is unsafe — use the helper functions in
 * `state.ts` (getSessionState, getActiveByCwd, setActiveByCwd, removeActiveByCwd)
 * which handle the discrimination between session entries and reserved keys.
 */
export interface TracingState {
  _active_by_cwd?: Record<string, string>;
  [sessionId: string]: SessionState | Record<string, string> | undefined;
}
