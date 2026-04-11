/**
 * Transcript parsing — reads Claude Code JSONL transcripts and groups
 * messages into Turns (user prompt → LLM calls → tool results).
 *
 * Ported from the langsmith plugin's transcript module with identical
 * parsing logic for consistency.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type {
  TranscriptMessage,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
  Turn,
  LLMCall,
  ToolCall,
  ContentBlock,
  ToolUseBlock,
  Usage,
} from "./types.js";

// ─── Low-level parsing ─────────────────────────────────────────────────────

/**
 * Maximum transcript file size (in bytes) to read in full via readFileSync.
 * Larger files are read in streaming chunks to avoid OOM.
 */
const MAX_FULL_READ_BYTES = 50 * 1024 * 1024; // 50 MB

/** Read a JSONL file and return parsed lines starting after `afterLine`. */
export function readTranscript(
  filePath: string,
  afterLine: number = -1,
): { messages: TranscriptMessage[]; lastLine: number } {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { messages: [], lastLine: afterLine };
  }

  // For small-to-moderate files, read the whole thing (simple, fast).
  if (size <= MAX_FULL_READ_BYTES) {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");

    const messages: TranscriptMessage[] = [];
    let lastLine = afterLine;

    for (let i = 0; i < lines.length; i++) {
      lastLine = i;
      if (i <= afterLine) continue;
      try {
        messages.push(JSON.parse(lines[i]) as TranscriptMessage);
      } catch {
        // Skip malformed lines.
      }
    }
    return { messages, lastLine };
  }

  // Large file: stream through in chunks to avoid loading everything at once.
  const fd = openSync(filePath, "r");
  try {
    const chunkSize = 2 * 1024 * 1024; // 2 MB
    const buf = Buffer.alloc(chunkSize);
    const messages: TranscriptMessage[] = [];
    let lastLine = afterLine;
    let lineIndex = -1;
    let partial = "";
    let bytesRead: number;
    let pos = 0;

    while ((bytesRead = readSync(fd, buf, 0, chunkSize, pos)) > 0) {
      const chunk = partial + buf.toString("utf-8", 0, bytesRead);
      partial = "";
      const lines = chunk.split("\n");

      // Last element may be incomplete — save for next iteration.
      partial = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        lineIndex++;
        lastLine = lineIndex;
        if (lineIndex <= afterLine) continue;
        try {
          messages.push(JSON.parse(trimmed) as TranscriptMessage);
        } catch {
          // Skip malformed lines.
        }
      }
      pos += bytesRead;
    }

    // Handle final partial line (if file doesn't end with newline).
    if (partial.trim() !== "") {
      lineIndex++;
      lastLine = lineIndex;
      if (lineIndex > afterLine) {
        try {
          messages.push(JSON.parse(partial.trim()) as TranscriptMessage);
        } catch {
          // Skip malformed lines.
        }
      }
    }

    return { messages, lastLine };
  } finally {
    closeSync(fd);
  }
}

/**
 * Return the index of the last line in a transcript file, without parsing
 * all the content. Used by UserPromptSubmit to skip to the end of a
 * pre-existing transcript when state is fresh (last_line === -1).
 */
export function getTranscriptEndLine(filePath: string): number {
  try {
    const size = statSync(filePath).size;
    if (size === 0) return -1;

    if (size <= MAX_FULL_READ_BYTES) {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      return lines.length > 0 ? lines.length - 1 : -1;
    }

    // Large files: count non-empty lines by streaming chunks.
    const fd = openSync(filePath, "r");
    try {
      const chunkSize = 1024 * 1024;
      const buf = Buffer.alloc(chunkSize);
      let lineCount = 0;
      let bytesRead: number;
      let pos = 0;
      let partial = "";

      while ((bytesRead = readSync(fd, buf, 0, chunkSize, pos)) > 0) {
        const chunk = partial + buf.toString("utf-8", 0, bytesRead);
        partial = "";
        const lines = chunk.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() !== "") lineCount++;
        }
        pos += bytesRead;
      }
      if (partial.trim() !== "") lineCount++;

      return lineCount > 0 ? lineCount - 1 : -1;
    } finally {
      closeSync(fd);
    }
  } catch {
    return -1;
  }
}

/** Check if a message is a human user prompt. */
export function isHumanMessage(msg: TranscriptMessage): msg is UserMessage {
  if (msg.type !== "user") return false;
  if (typeof msg.message.content === "string") return true;
  if (Array.isArray(msg.message.content)) {
    return !msg.message.content.some((b: { type: string }) => b.type === "tool_result");
  }
  return false;
}

/** Check if a message is a tool result. */
export function isToolResult(msg: TranscriptMessage): msg is ToolResultMessage {
  if (msg.type !== "user" || !Array.isArray(msg.message.content)) return false;
  return msg.message.content.some((b: { type: string }) => b.type === "tool_result");
}

/** Check if a message is an assistant message. */
export function isAssistantMessage(msg: TranscriptMessage): msg is AssistantMessage {
  return msg.type === "assistant";
}

/** Strip the date suffix from a model name (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5"). */
export function stripModelDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

// ─── Content extraction ────────────────────────────────────────────────────

/** Extract text from content blocks. */
export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Extract thinking from content blocks. */
export function extractThinking(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");
}

// ─── Streaming merge ────────────────────────────────────────────────────────

/**
 * Merge streaming assistant chunks that share the same message.id
 * into a single LLM call with concatenated text and final-chunk usage.
 */
function mergeAssistantChunks(chunks: AssistantMessage[]): {
  content: ContentBlock[];
  model: string;
  usage: Usage;
  startTime: string;
  endTime: string;
  stopReason: string | null | undefined;
} {
  if (chunks.length === 0) {
    throw new Error("Cannot merge zero chunks");
  }

  const first = chunks[0];
  const last = chunks[chunks.length - 1];

  const allBlocks: ContentBlock[] = chunks.flatMap((c) => c.message.content);
  const merged = mergeAdjacentTextBlocks(allBlocks);

  return {
    content: merged,
    model: stripModelDateSuffix(first.message.model),
    usage: last.message.usage,
    startTime: first.timestamp,
    endTime: last.timestamp,
    stopReason: last.message.stop_reason,
  };
}

/** Merge adjacent text blocks into one (e.g. streaming token fragments). */
function mergeAdjacentTextBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  let textBuffer: string | null = null;

  for (const block of blocks) {
    if (block.type === "text") {
      textBuffer = (textBuffer ?? "") + block.text;
    } else {
      if (textBuffer !== null) {
        result.push({ type: "text", text: textBuffer });
        textBuffer = null;
      }
      result.push(block);
    }
  }
  if (textBuffer !== null) {
    result.push({ type: "text", text: textBuffer });
  }
  return result;
}

// ─── Tool result matching ───────────────────────────────────────────────────

function findToolResult(
  toolUseId: string,
  toolResults: ToolResultMessage[],
): { content: string; timestamp: string; agentId?: string; durationMs?: number } | undefined {
  for (const msg of toolResults) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        const content =
          typeof block.content === "string"
            ? block.content
            : (block.content as Array<{ type: string; text: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join(" ");

        return {
          content,
          timestamp: msg.timestamp,
          agentId: msg.toolUseResult?.agentId,
          durationMs: msg.toolUseResult?.durationMs,
        };
      }
    }
  }
  return undefined;
}

// ─── Turn grouping ──────────────────────────────────────────────────────────

/**
 * Group a flat list of transcript messages into Turns.
 *
 * A Turn starts with a human user message and includes all subsequent
 * assistant messages and tool results.
 */
export function groupIntoTurns(messages: TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];

  let currentPromptId: string | undefined | null = null;
  let currentUser: UserMessage | null = null;
  let assistantChunks: Map<string, AssistantMessage[]> = new Map();
  let assistantOrder: string[] = [];
  let toolResults: ToolResultMessage[] = [];
  let hasStopReasonEndTurn = false;

  function finalizeTurn(forceIncomplete = false): void {
    if (!currentUser) return;
    if (assistantChunks.size === 0) return;

    const assistantMessages = Array.from(assistantChunks.values()).flat();
    const hasStopReasonField = assistantMessages.some((m) => m.message.stop_reason !== undefined);
    const isComplete = hasStopReasonEndTurn || (!forceIncomplete && !hasStopReasonField);

    const llmCalls: LLMCall[] = [];

    for (const msgId of assistantOrder) {
      const chunks = assistantChunks.get(msgId);
      if (!chunks || chunks.length === 0) continue;

      const merged = mergeAssistantChunks(chunks);

      const toolUses = merged.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

      const toolCalls: ToolCall[] = toolUses.map((tu) => {
        const result = findToolResult(tu.id, toolResults);
        return {
          tool_use: tu,
          result: result
            ? {
                content: result.content,
                timestamp: result.timestamp,
                durationMs: result.durationMs,
              }
            : undefined,
          agentId: result?.agentId,
        };
      });

      llmCalls.push({
        content: merged.content,
        model: merged.model,
        usage: merged.usage,
        startTime: merged.startTime,
        endTime: merged.endTime,
        toolCalls,
        stopReason: merged.stopReason,
      });
    }

    turns.push({
      userContent: currentUser.message.content as string | Array<Record<string, unknown>>,
      userTimestamp: currentUser.timestamp,
      llmCalls,
      isComplete,
    });
  }

  for (const msg of messages) {
    if (isHumanMessage(msg)) {
      const isNewTurn =
        currentUser === null ||
        (msg.promptId !== undefined && msg.promptId !== currentPromptId) ||
        msg.promptId === undefined;

      if (isNewTurn) {
        finalizeTurn();
        currentPromptId = msg.promptId;
        currentUser = msg;
        assistantChunks = new Map();
        assistantOrder = [];
        toolResults = [];
        hasStopReasonEndTurn = false;
      }
    } else if (isToolResult(msg)) {
      toolResults.push(msg);
    } else if (isAssistantMessage(msg)) {
      const id = msg.message.id ?? "__no_id__";
      if (!assistantChunks.has(id)) {
        assistantChunks.set(id, []);
        assistantOrder.push(id);
      }
      assistantChunks.get(id)!.push(msg);

      if (msg.message.stop_reason === "end_turn") {
        hasStopReasonEndTurn = true;
      }
    }
  }

  finalizeTurn(true);

  return turns;
}
