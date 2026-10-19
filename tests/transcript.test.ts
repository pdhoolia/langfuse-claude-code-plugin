/**
 * Tests for src/transcript.ts — the JSONL transcript parser.
 *
 * Covers the two read paths (whole-file readFileSync under 50 MB, streaming
 * chunks above it), the user/tool-result/assistant discrimination, and the
 * turn grouping that everything downstream is built on.
 *
 * Tests whose name starts with "documents current behaviour" pin down what the
 * parser does today, not what it arguably should do. They are flagged in the
 * test body and in the report that came with this file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTranscript,
  getTranscriptEndLine,
  isHumanMessage,
  isToolResult,
  isAssistantMessage,
  stripModelDateSuffix,
  extractText,
  extractThinking,
  groupIntoTurns,
} from "../src/transcript.js";
import type {
  AssistantMessage,
  ContentBlock,
  TranscriptMessage,
  ToolResultMessage,
  UserMessage,
} from "../src/types.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));

const SIMPLE = fixture("parse-simple-turn.jsonl");
const TOOL = fixture("parse-tool-turn.jsonl");
const MULTI = fixture("parse-multi-turn.jsonl");
const MALFORMED = fixture("parse-malformed.jsonl");
const NO_NEWLINE = fixture("parse-no-trailing-newline.jsonl");
const EMPTY = fixture("parse-empty.jsonl");
const MISSING = fixture("parse-does-not-exist.jsonl");

// ─── Inline message builders (for grouping cases too small to deserve a file) ─

let clock = 0;
const ts = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

function userMsg(content: UserMessage["message"]["content"], promptId?: string): UserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    timestamp: ts(),
    ...(promptId === undefined ? {} : { promptId }),
  } as UserMessage;
}

function assistantMsg(
  id: string,
  content: ContentBlock[],
  opts: { stopReason?: string | null; usage?: Record<string, number>; model?: string } = {},
): AssistantMessage {
  const message: Record<string, unknown> = {
    id,
    role: "assistant",
    model: opts.model ?? "claude-sonnet-4-5-20250929",
    content,
    usage: opts.usage ?? { input_tokens: 1, output_tokens: 1 },
  };
  if ("stopReason" in opts) message.stop_reason = opts.stopReason;
  return { type: "assistant", message, timestamp: ts() } as unknown as AssistantMessage;
}

function toolResultMsg(
  toolUseId: string,
  content: string | Array<{ type: "text"; text: string }>,
  toolUseResult?: { agentId: string; durationMs?: number },
): ToolResultMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    timestamp: ts(),
    ...(toolUseResult ? { toolUseResult } : {}),
  } as ToolResultMessage;
}

// ─── readTranscript — whole-file path ───────────────────────────────────────

describe("readTranscript — whole-file path", () => {
  it("returns every line of a well-formed file", () => {
    const { messages } = readTranscript(SIMPLE);
    expect(messages).toHaveLength(3);
  });

  it("reports the index of the last line as the new cursor", () => {
    const { lastLine } = readTranscript(SIMPLE);
    expect(lastLine).toBe(2);
  });

  it("returns only the lines after the afterLine cursor", () => {
    const { messages } = readTranscript(SIMPLE, 0);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.type === "assistant")).toBe(true);
  });

  it("advances the cursor to the end even when nothing new is returned", () => {
    const { messages, lastLine } = readTranscript(SIMPLE, 2);
    expect(messages).toHaveLength(0);
    expect(lastLine).toBe(2);
  });

  it("skips malformed lines instead of throwing", () => {
    const { messages } = readTranscript(MALFORMED);
    expect(messages.map((m) => m.type)).toEqual(["user", "file-history-snapshot", "assistant"]);
  });

  it("counts a malformed line in the cursor, so it is never re-read", () => {
    // Four non-empty lines: user, garbage, snapshot, assistant.
    expect(readTranscript(MALFORMED).lastLine).toBe(3);
  });

  it("does not count blank lines as lines", () => {
    // The fixture has a blank line between the garbage and the snapshot row;
    // the snapshot is still index 2.
    const { messages } = readTranscript(MALFORMED, 1);
    expect(messages.map((m) => m.type)).toEqual(["file-history-snapshot", "assistant"]);
  });

  it("parses the final line when the file does not end in a newline", () => {
    const { messages, lastLine } = readTranscript(NO_NEWLINE);
    expect(messages).toHaveLength(1);
    expect(lastLine).toBe(0);
  });

  it("returns nothing and keeps the cursor for an empty file", () => {
    expect(readTranscript(EMPTY, 7)).toEqual({ messages: [], lastLine: 7 });
  });

  it("returns nothing and keeps the cursor for a missing file", () => {
    expect(readTranscript(MISSING, 7)).toEqual({ messages: [], lastLine: 7 });
  });

  it("keeps a multi-byte character intact (contrast with the streaming path below)", () => {
    const dir = mkdtempSync(join(tmpdir(), "parse-small-"));
    const path = join(dir, "parse-utf8.jsonl");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          promptId: "p1",
          message: { role: "user", content: "hello \u{1F642} world" },
        }) + "\n",
      );
      const { messages } = readTranscript(path);
      expect((messages[0] as UserMessage).message.content).toBe("hello \u{1F642} world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── getTranscriptEndLine — whole-file path ─────────────────────────────────

describe("getTranscriptEndLine — whole-file path", () => {
  it("returns the index of the last non-empty line", () => {
    expect(getTranscriptEndLine(SIMPLE)).toBe(2);
  });

  it("counts malformed lines, matching readTranscript's line numbering", () => {
    expect(getTranscriptEndLine(MALFORMED)).toBe(readTranscript(MALFORMED).lastLine);
  });

  it("counts a final line with no trailing newline", () => {
    expect(getTranscriptEndLine(NO_NEWLINE)).toBe(0);
  });

  it("returns -1 for an empty file", () => {
    expect(getTranscriptEndLine(EMPTY)).toBe(-1);
  });

  it("returns -1 for a missing file", () => {
    expect(getTranscriptEndLine(MISSING)).toBe(-1);
  });
});

// ─── The streaming path (files over MAX_FULL_READ_BYTES = 50 MB) ────────────
//
// MAX_FULL_READ_BYTES is a module-private constant with no env override, so the
// only way to reach the streaming branch without mocking node:fs is a genuinely
// oversized file. One is built here, used by every test in the block, and
// deleted afterwards. It costs ~52 MB of temp space and about a second.

const CHUNK_SIZE = 2 * 1024 * 1024; // readTranscript's streaming chunk size.
const EMOJI = "\u{1F642}"; // 4 UTF-8 bytes — straddles the first chunk boundary.

let bigDir: string;
let bigPath: string;
/** Line indices inside the generated file. */
let bigIdx: { emoji: number; malformed: number; last: number };

function buildBigTranscript(): void {
  const line0 =
    '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","uuid":"u0","promptId":"p1",' +
    '"message":{"role":"user","content":"big file line zero"}}';

  // Line 1 carries a marker text whose emoji is placed so that two of its four
  // bytes land in the first 2 MB chunk and two in the second.
  const head =
    '{"type":"assistant","timestamp":"2026-01-01T00:00:01.000Z","uuid":"a0",' +
    '"message":{"id":"msg-big","role":"assistant","model":"claude-sonnet-4-5-20250929",' +
    '"content":[{"type":"text","text":"';
  const tail = 'END"}],"usage":{"input_tokens":1,"output_tokens":1},"stop_reason":"end_turn"}}';
  const beforeEmoji = Buffer.byteLength(line0 + "\n" + head);
  const padLen = CHUNK_SIZE - 2 - beforeEmoji; // emoji starts 2 bytes before the boundary
  const emojiLine = head + "x".repeat(padLen) + EMOJI + tail;

  // Padding lines to push the file past 50 MB.
  const padText = "y".repeat(1024 * 1024);
  const padLines: string[] = [];
  for (let i = 0; i < 52; i++) {
    padLines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:02.000Z",
        uuid: `pad-${i}`,
        message: {
          id: `msg-pad-${i}`,
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: padText }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        },
      }),
    );
  }

  const malformed = "this line is not json";
  const lastLine =
    '{"type":"user","timestamp":"2026-01-01T00:09:00.000Z","uuid":"uLast","promptId":"p2",' +
    '"message":{"role":"user","content":"final line, no trailing newline"}}';

  const all = [line0, emojiLine, ...padLines, malformed, lastLine];
  bigIdx = {
    emoji: 1,
    malformed: all.length - 2,
    last: all.length - 1,
  };
  // Deliberately no trailing newline — exercises the streaming tail handling.
  writeFileSync(bigPath, all.join("\n"));
}

describe("readTranscript / getTranscriptEndLine — streaming path (file over 50 MB)", () => {
  beforeAll(() => {
    bigDir = mkdtempSync(join(tmpdir(), "parse-big-"));
    bigPath = join(bigDir, "parse-big-transcript.jsonl");
    buildBigTranscript();
  }, 60_000);

  afterAll(() => {
    rmSync(bigDir, { recursive: true, force: true });
  });

  it("returns every parseable line of an oversized file", () => {
    const { messages } = readTranscript(bigPath);
    // Everything but the one malformed line.
    expect(messages).toHaveLength(bigIdx.last);
  });

  it("numbers lines the same way the whole-file path does", () => {
    expect(readTranscript(bigPath).lastLine).toBe(bigIdx.last);
  });

  it("honours the afterLine cursor", () => {
    const { messages, lastLine } = readTranscript(bigPath, bigIdx.malformed - 1);
    // Only the malformed line (skipped) and the final line remain.
    expect(messages).toHaveLength(1);
    expect(lastLine).toBe(bigIdx.last);
  });

  it("parses the final line when the file does not end in a newline", () => {
    const { messages } = readTranscript(bigPath, bigIdx.malformed);
    expect(messages).toHaveLength(1);
    expect((messages[0] as UserMessage).message.content).toBe("final line, no trailing newline");
  });

  it("getTranscriptEndLine agrees with readTranscript on the last index", () => {
    expect(getTranscriptEndLine(bigPath)).toBe(readTranscript(bigPath).lastLine);
  });

  it("keeps a multi-byte character split across a chunk boundary intact", () => {
    // Regression: decoding each 2 MB chunk with buf.toString("utf-8") turned a
    // UTF-8 sequence straddling the boundary into U+FFFD replacement characters
    // on both sides. The JSON still parsed, so the damage was silent — emitted
    // text differed from what the model produced. StringDecoder holds the
    // incomplete bytes back for the next chunk.
    const { messages } = readTranscript(bigPath, bigIdx.emoji - 1);
    const text = ((messages[0] as AssistantMessage).message.content[0] as { text: string }).text;
    expect(text).toContain(EMOJI);
    expect(text).not.toContain("�");
  });
});

// ─── Message discrimination ─────────────────────────────────────────────────

describe("isHumanMessage / isToolResult / isAssistantMessage", () => {
  it("treats a user message with string content as a human prompt", () => {
    expect(isHumanMessage(userMsg("hello"))).toBe(true);
  });

  it("treats a user message made of text blocks as a human prompt", () => {
    const msg = userMsg([{ type: "text", text: "hello" }] as unknown as string);
    expect(isHumanMessage(msg)).toBe(true);
  });

  it("does not treat a tool-result message as a human prompt", () => {
    expect(isHumanMessage(toolResultMsg("toolu_1", "ok"))).toBe(false);
  });

  it("does not treat an assistant message as a human prompt", () => {
    expect(isHumanMessage(assistantMsg("m1", [{ type: "text", text: "hi" }]))).toBe(false);
  });

  it("recognises a tool-result message by its tool_result block", () => {
    expect(isToolResult(toolResultMsg("toolu_1", "ok"))).toBe(true);
  });

  it("does not call a plain human prompt a tool result", () => {
    expect(isToolResult(userMsg("hello"))).toBe(false);
    expect(isToolResult(userMsg([{ type: "text", text: "hi" }] as unknown as string))).toBe(false);
  });

  it("classifies a mixed block array (text plus tool_result) as a tool result, not a prompt", () => {
    const mixed = {
      type: "user",
      timestamp: ts(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "here is the output" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    } as unknown as TranscriptMessage;
    expect(isHumanMessage(mixed)).toBe(false);
    expect(isToolResult(mixed)).toBe(true);
  });

  it("recognises an assistant message by its type", () => {
    expect(isAssistantMessage(assistantMsg("m1", [{ type: "text", text: "hi" }]))).toBe(true);
    expect(isAssistantMessage(userMsg("hello"))).toBe(false);
  });

  it("treats a type:\"user\" row with no message field as not a prompt", () => {
    // Real transcripts carry rows with no `message` (attachment, system,
    // file-history-snapshot, …) and none of them uses type "user" today, so
    // this is latent. Reading it unguarded threw a TypeError, which would take
    // the whole hook down if a future format added a bodyless user row.
    const bare = { type: "user", timestamp: ts() } as unknown as TranscriptMessage;
    expect(isHumanMessage(bare)).toBe(false);
    expect(isToolResult(bare)).toBe(false);
  });
});

// ─── stripModelDateSuffix / extractText / extractThinking ───────────────────

describe("stripModelDateSuffix", () => {
  it("strips a trailing eight-digit date", () => {
    expect(stripModelDateSuffix("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("leaves a model name that has no date suffix alone", () => {
    expect(stripModelDateSuffix("claude-opus-5")).toBe("claude-opus-5");
  });

  it("only strips at the end of the string", () => {
    expect(stripModelDateSuffix("claude-20250929-preview")).toBe("claude-20250929-preview");
  });

  it("documents current behaviour: any trailing eight digits are stripped, date or not", () => {
    // The regex is -\d{8}$ with no date validation, so a non-Anthropic model id
    // ending in eight digits loses them.
    expect(stripModelDateSuffix("vllm/qwen3-12345678")).toBe("vllm/qwen3");
  });
});

describe("extractText", () => {
  it("returns the text of a single text block", () => {
    expect(extractText([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("joins several text blocks with a newline", () => {
    expect(
      extractText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });

  it("ignores thinking and tool_use blocks", () => {
    expect(
      extractText([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ]),
    ).toBe("answer");
  });

  it("returns an empty string when there is no text block", () => {
    expect(extractText([{ type: "thinking", thinking: "hmm" }])).toBe("");
  });
});

describe("extractThinking", () => {
  it("returns the thinking of a single thinking block", () => {
    expect(extractThinking([{ type: "thinking", thinking: "hmm" }])).toBe("hmm");
  });

  it("joins thinking blocks interleaved with text, keeping only the thinking", () => {
    expect(
      extractThinking([
        { type: "thinking", thinking: "first" },
        { type: "text", text: "spoken" },
        { type: "thinking", thinking: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("returns an empty string when there is no thinking block", () => {
    expect(extractThinking([{ type: "text", text: "answer" }])).toBe("");
  });
});

// ─── groupIntoTurns ─────────────────────────────────────────────────────────

describe("groupIntoTurns — a simple prompt and response", () => {
  const turns = groupIntoTurns(readTranscript(SIMPLE).messages);

  it("produces exactly one turn", () => {
    expect(turns).toHaveLength(1);
  });

  it("keeps the user content and timestamp on the turn", () => {
    expect(turns[0].userContent).toBe("Say hello.");
    expect(turns[0].userTimestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("merges the streaming chunks that share a message.id into one LLM call", () => {
    expect(turns[0].llmCalls).toHaveLength(1);
  });

  it("concatenates the streamed text without a separator", () => {
    expect(extractText(turns[0].llmCalls[0].content)).toBe("Hello from Claude Code.");
  });

  it("takes usage from the final chunk", () => {
    expect(turns[0].llmCalls[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 900,
    });
  });

  it("takes startTime from the first chunk and endTime from the last", () => {
    expect(turns[0].llmCalls[0].startTime).toBe("2026-01-01T00:00:01.000Z");
    expect(turns[0].llmCalls[0].endTime).toBe("2026-01-01T00:00:02.000Z");
  });

  it("strips the model's date suffix", () => {
    expect(turns[0].llmCalls[0].model).toBe("claude-sonnet-4-5");
  });

  it("carries the final chunk's stop reason", () => {
    expect(turns[0].llmCalls[0].stopReason).toBe("end_turn");
  });

  it("marks the turn complete because a chunk ended with end_turn", () => {
    expect(turns[0].isComplete).toBe(true);
  });
});

describe("groupIntoTurns — a turn with several LLM calls and tool calls", () => {
  const turns = groupIntoTurns(readTranscript(TOOL).messages);

  it("produces one turn holding all three LLM calls", () => {
    expect(turns).toHaveLength(1);
    expect(turns[0].llmCalls).toHaveLength(3);
  });

  it("keeps the LLM calls in transcript order", () => {
    expect(turns[0].llmCalls.map((c) => c.startTime)).toEqual([
      "2026-01-01T00:01:01.000Z",
      "2026-01-01T00:01:03.000Z",
      "2026-01-01T00:01:05.000Z",
    ]);
  });

  it("keeps thinking, text and tool_use blocks side by side in one call", () => {
    expect(turns[0].llmCalls[0].content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
  });

  it("matches a tool result back to its tool_use by id", () => {
    const call = turns[0].llmCalls[0];
    expect(call.toolCalls).toHaveLength(1);
    expect(call.toolCalls[0].tool_use.id).toBe("toolu_read_1");
    expect(call.toolCalls[0].result?.content).toBe("# Example");
  });

  it("carries the tool result's timestamp and duration", () => {
    const result = turns[0].llmCalls[0].toolCalls[0].result;
    expect(result?.timestamp).toBe("2026-01-01T00:01:02.000Z");
    expect(result?.durationMs).toBe(42);
  });

  it("surfaces the agentId of an Agent tool result for subagent linking", () => {
    expect(turns[0].llmCalls[0].toolCalls[0].agentId).toBe("agent-7");
  });

  it("joins a block-shaped tool result's text blocks with a space", () => {
    expect(turns[0].llmCalls[1].toolCalls[0].result?.content).toBe("no matches exit 1");
  });

  it("leaves toolCalls empty for a call that used no tool", () => {
    expect(turns[0].llmCalls[2].toolCalls).toEqual([]);
  });

  it("marks the turn complete on the final call's end_turn", () => {
    expect(turns[0].isComplete).toBe(true);
  });
});

describe("groupIntoTurns — turn boundaries", () => {
  const turns = groupIntoTurns(readTranscript(MULTI).messages);

  it("starts a new turn when promptId changes", () => {
    expect(turns).toHaveLength(2);
    expect(turns[0].userContent).toBe("First question.");
    expect(turns[1].userContent).toBe("Second question.");
  });

  it("documents current behaviour: a second human message with the same promptId is dropped", () => {
    // "Second question, continued." shares promptId prompt-2 with the message
    // before it, so it neither starts a turn nor is appended to one — its text
    // never reaches the emitted trace.
    expect(JSON.stringify(turns)).not.toContain("continued");
  });

  it("starts a new turn for every human message that carries no promptId", () => {
    const msgs = [
      userMsg("one"),
      assistantMsg("m1", [{ type: "text", text: "a" }], { stopReason: "end_turn" }),
      userMsg("two"),
      assistantMsg("m2", [{ type: "text", text: "b" }], { stopReason: "end_turn" }),
    ];
    expect(groupIntoTurns(msgs).map((t) => t.userContent)).toEqual(["one", "two"]);
  });

  it("documents current behaviour: a prompt with no assistant reply produces no turn", () => {
    // finalizeTurn bails when the turn has no assistant chunks, so an abandoned
    // or still-running prompt is invisible rather than an empty turn.
    const msgs = [userMsg("no answer yet", "p1")];
    expect(groupIntoTurns(msgs)).toEqual([]);
  });

  it("ignores rows that are neither user nor assistant", () => {
    const msgs = readTranscript(MALFORMED).messages; // includes a file-history-snapshot row
    const turns2 = groupIntoTurns(msgs);
    expect(turns2).toHaveLength(1);
    expect(turns2[0].llmCalls).toHaveLength(1);
  });
});

describe("groupIntoTurns — the isComplete flag", () => {
  it("is true when any chunk of the turn reports stop_reason end_turn", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "text", text: "done" }], { stopReason: "end_turn" }),
    ];
    expect(groupIntoTurns(msgs)[0].isComplete).toBe(true);
  });

  it("is false for the trailing turn when the last stop_reason is not end_turn", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], {
        stopReason: "tool_use",
      }),
    ];
    expect(groupIntoTurns(msgs)[0].isComplete).toBe(false);
  });

  it("is false for the trailing turn when the only stop_reason seen is null", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "text", text: "partial" }], { stopReason: null }),
    ];
    expect(groupIntoTurns(msgs)[0].isComplete).toBe(false);
  });

  it("is true for a finished earlier turn whose messages carry no stop_reason field at all", () => {
    // Older transcript shapes omit stop_reason; a turn that was superseded by a
    // later prompt is then assumed complete.
    const msgs = [
      userMsg("first", "p1"),
      assistantMsg("m1", [{ type: "text", text: "a" }]),
      userMsg("second", "p2"),
      assistantMsg("m2", [{ type: "text", text: "b" }]),
    ];
    const turns = groupIntoTurns(msgs);
    expect(turns[0].isComplete).toBe(true);
  });

  it("is false for the trailing turn with no stop_reason field, because finalizeTurn forces it", () => {
    const msgs = [userMsg("first", "p1"), assistantMsg("m1", [{ type: "text", text: "a" }])];
    expect(groupIntoTurns(msgs)[0].isComplete).toBe(false);
  });

  it("documents current behaviour: one end_turn anywhere marks the whole turn complete", () => {
    // hasStopReasonEndTurn is turn-scoped, so an end_turn on an early call keeps
    // the turn "complete" even though a later call was cut off mid-flight.
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "text", text: "a" }], { stopReason: "end_turn" }),
      assistantMsg("m2", [{ type: "text", text: "b" }], { stopReason: null }),
    ];
    expect(groupIntoTurns(msgs)[0].isComplete).toBe(true);
  });
});

describe("groupIntoTurns — block merging inside a call", () => {
  it("merges adjacent text blocks into one", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg(
        "m1",
        [
          { type: "text", text: "one " },
          { type: "text", text: "two" },
        ],
        { stopReason: "end_turn" },
      ),
    ];
    const content = groupIntoTurns(msgs)[0].llmCalls[0].content;
    expect(content).toEqual([{ type: "text", text: "one two" }]);
  });

  it("does not merge text blocks separated by a non-text block", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg(
        "m1",
        [
          { type: "text", text: "before" },
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "after" },
        ],
        { stopReason: "end_turn" },
      ),
    ];
    const content = groupIntoTurns(msgs)[0].llmCalls[0].content;
    expect(content.map((b) => b.type)).toEqual(["text", "thinking", "text"]);
  });

  it("merges text across chunk boundaries of the same message.id", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "text", text: "Hel" }], { stopReason: null }),
      assistantMsg("m1", [{ type: "text", text: "lo" }], { stopReason: "end_turn" }),
    ];
    const calls = groupIntoTurns(msgs)[0].llmCalls;
    expect(calls).toHaveLength(1);
    expect(extractText(calls[0].content)).toBe("Hello");
  });

  it("keeps two different message.ids as two separate LLM calls", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "text", text: "a" }], { stopReason: null }),
      assistantMsg("m2", [{ type: "text", text: "b" }], { stopReason: "end_turn" }),
    ];
    expect(groupIntoTurns(msgs)[0].llmCalls).toHaveLength(2);
  });

  it("documents current behaviour: assistant rows with no message.id collapse into one call", () => {
    // They all land in the "__no_id__" bucket, so unrelated responses are merged
    // into a single LLM call with concatenated text and the last row's usage.
    const noId = (text: string, stopReason: string | null): AssistantMessage =>
      ({
        type: "assistant",
        timestamp: ts(),
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: stopReason,
        },
      }) as unknown as AssistantMessage;
    const msgs = [userMsg("hi", "p1"), noId("first", null), noId("second", "end_turn")];
    const calls = groupIntoTurns(msgs)[0].llmCalls;
    expect(calls).toHaveLength(1);
    expect(extractText(calls[0].content)).toBe("firstsecond");
  });
});

describe("groupIntoTurns — tool results", () => {
  it("leaves result undefined for a tool_use that never got a result", () => {
    const turns = groupIntoTurns(readTranscript(MULTI).messages);
    const call = turns[1].llmCalls[0];
    expect(call.toolCalls[0].tool_use.id).toBe("toolu_never_1");
    expect(call.toolCalls[0].result).toBeUndefined();
    expect(call.toolCalls[0].agentId).toBeUndefined();
  });

  it("matches a result that arrives later in the same turn", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg("m1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], {
        stopReason: "tool_use",
      }),
      toolResultMsg("toolu_1", "output"),
      assistantMsg("m2", [{ type: "text", text: "done" }], { stopReason: "end_turn" }),
    ];
    expect(groupIntoTurns(msgs)[0].llmCalls[0].toolCalls[0].result?.content).toBe("output");
  });

  it("documents current behaviour: a result arriving after the next prompt is lost", () => {
    // toolResults is reset when a new turn starts, so a late-landing result for
    // the previous turn's tool_use is never matched.
    const msgs = [
      userMsg("first", "p1"),
      assistantMsg("m1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], {
        stopReason: "tool_use",
      }),
      userMsg("second", "p2"),
      toolResultMsg("toolu_1", "late output"),
      assistantMsg("m2", [{ type: "text", text: "done" }], { stopReason: "end_turn" }),
    ];
    const turns = groupIntoTurns(msgs);
    expect(turns[0].llmCalls[0].toolCalls[0].result).toBeUndefined();
  });

  it("matches each tool_use of a multi-tool call to its own result", () => {
    const msgs = [
      userMsg("hi", "p1"),
      assistantMsg(
        "m1",
        [
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
          { type: "tool_use", id: "toolu_2", name: "Grep", input: {} },
        ],
        { stopReason: "tool_use" },
      ),
      toolResultMsg("toolu_2", "second result"),
      toolResultMsg("toolu_1", "first result"),
      assistantMsg("m2", [{ type: "text", text: "done" }], { stopReason: "end_turn" }),
    ];
    const toolCalls = groupIntoTurns(msgs)[0].llmCalls[0].toolCalls;
    expect(toolCalls.map((t) => t.result?.content)).toEqual(["first result", "second result"]);
  });
});
