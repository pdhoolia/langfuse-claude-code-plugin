/**
 * Tests for the Langfuse emitter: what is actually handed to trace(),
 * generation() and span().
 *
 * Two behaviours carry the weight here:
 *   - usage details carry the cache counters under the key names the Anthropic
 *     model definitions price, so a cached prefix is not billed at zero;
 *   - a generation's input is the conversation as the model saw it — earlier
 *     turns, this turn's prompt, and the earlier steps of this turn.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ChatMessage, LLMCall, ToolCall, Turn, Usage } from "../src/types.js";

// Recorded payloads, per Langfuse method. Hoisted so the vi.mock factory —
// which runs before the module body — can close over it.
const recorded = vi.hoisted(() => ({
  traces: [] as Record<string, any>[],
  generations: [] as Record<string, any>[],
  spans: [] as Record<string, any>[],
}));

vi.mock("langfuse", () => {
  class FakeObservation {
    constructor(public body: Record<string, any>) {}
    get id(): string {
      return (this.body.id as string) ?? "observation-id";
    }
    generation(body: Record<string, any>): FakeObservation {
      recorded.generations.push(body);
      return new FakeObservation(body);
    }
    span(body: Record<string, any>): FakeObservation {
      recorded.spans.push(body);
      return new FakeObservation(body);
    }
    end(): void {}
  }
  class FakeLangfuse {
    trace(body: Record<string, any>): FakeObservation {
      recorded.traces.push(body);
      return new FakeObservation(body);
    }
    score(): void {}
    async flushAsync(): Promise<void> {}
    async shutdownAsync(): Promise<void> {}
  }
  return { default: FakeLangfuse };
});

const {
  initClient,
  setMaxChars,
  emitTurn,
  buildUsageDetails,
  buildTurnHistoryMessages,
  buildSessionHistory,
  historyPrefixForTurn,
} = await import("../src/langfuse.js");
const { readTranscript, groupIntoTurns } = await import("../src/transcript.js");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// ─── Builders ───────────────────────────────────────────────────────────────

function llmCall(options: {
  text?: string;
  thinking?: string;
  tools?: Array<{ id: string; name: string; input?: Record<string, unknown>; result?: string }>;
  usage?: Usage;
}): LLMCall {
  const toolCalls: ToolCall[] = (options.tools ?? []).map((t) => ({
    tool_use: { type: "tool_use" as const, id: t.id, name: t.name, input: t.input ?? {} },
    result:
      t.result === undefined
        ? undefined
        : { content: t.result, timestamp: "2026-01-01T10:00:02.000Z" },
  }));
  return {
    content: [
      ...(options.thinking ? [{ type: "thinking" as const, thinking: options.thinking }] : []),
      ...(options.text ? [{ type: "text" as const, text: options.text }] : []),
      ...toolCalls.map((tc) => tc.tool_use),
    ],
    model: "claude-sonnet-4-5",
    usage: options.usage ?? { input_tokens: 1, output_tokens: 1 },
    startTime: "2026-01-01T10:00:01.000Z",
    endTime: "2026-01-01T10:00:03.000Z",
    toolCalls,
    stopReason: "end_turn",
  };
}

function turnOf(userContent: string, llmCalls: LLMCall[]): Turn {
  return {
    userContent,
    userTimestamp: "2026-01-01T10:00:00.000Z",
    llmCalls,
    isComplete: true,
  };
}

function emit(turn: Turn, historyPrefix?: ChatMessage[]): void {
  emitTurn({
    sessionId: "session-1",
    turnNum: 1,
    turn,
    transcriptName: "transcript.jsonl",
    traceId: "trace-1",
    historyPrefix,
  });
}

beforeEach(() => {
  recorded.traces.length = 0;
  recorded.generations.length = 0;
  recorded.spans.length = 0;
  setMaxChars(50000);
  initClient("pk", "sk", "https://cloud.langfuse.com");
});

// ─── Usage details ──────────────────────────────────────────────────────────

describe("buildUsageDetails", () => {
  it("carries cache reads and both cache-write lifetimes", () => {
    expect(
      buildUsageDetails({
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 900,
        cache_creation: {
          ephemeral_5m_input_tokens: 800,
          ephemeral_1h_input_tokens: 100,
        },
      }),
    ).toEqual({
      input: 12,
      output: 34,
      cache_read_input_tokens: 5000,
      input_cache_creation_5m: 800,
      input_cache_creation_1h: 100,
    });
  });

  it("falls back to the flat cache-write total when the split is absent", () => {
    expect(
      buildUsageDetails({
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 900,
      }),
    ).toEqual({
      input: 12,
      output: 34,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 900,
    });
  });

  it("ignores a split that is present but empty, and keeps the flat total", () => {
    expect(
      buildUsageDetails({
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 700,
        cache_creation: {},
      }),
    ).toMatchObject({ cache_creation_input_tokens: 700 });
  });

  it("sends no total — Langfuse sums the metrics, and input + output would hide the cache", () => {
    const details = buildUsageDetails({ input_tokens: 12, output_tokens: 34 });
    expect(details).toEqual({ input: 12, output: 34 });
    expect(details).not.toHaveProperty("total");
  });

  it("returns undefined when nothing was counted", () => {
    expect(buildUsageDetails({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });

  it("reaches the generation payload as usageDetails, and stays in metadata", () => {
    emit(
      turnOf("hello", [
        llmCall({
          text: "hi",
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 5000,
            cache_creation: { ephemeral_1h_input_tokens: 250 },
          },
        }),
      ]),
    );

    const gen = recorded.generations[0];
    expect(gen.usageDetails).toEqual({
      input: 12,
      output: 34,
      cache_read_input_tokens: 5000,
      input_cache_creation_1h: 250,
    });
    expect(gen.metadata.cache_read_input_tokens).toBe(5000);
    expect(gen.metadata.cache_creation).toEqual({ ephemeral_1h_input_tokens: 250 });
  });
});

// ─── Generation input history ───────────────────────────────────────────────

describe("generation input — history within a turn", () => {
  it("gives the first call the plain user message", () => {
    emit(turnOf("do the thing", [llmCall({ text: "done" })]));

    expect(recorded.generations).toHaveLength(1);
    expect(recorded.generations[0].input).toEqual([{ role: "user", content: "do the thing" }]);
  });

  it("gives the second call the user message, the first answer and its tool results", () => {
    emit(
      turnOf("find the config", [
        llmCall({ text: "searching", tools: [{ id: "t1", name: "Glob", result: "a.json" }] }),
        llmCall({ text: "found it" }),
      ]),
    );

    expect(recorded.generations[1].input).toEqual([
      { role: "user", content: "find the config" },
      {
        role: "assistant",
        content: "searching",
        tool_calls: [{ id: "t1", type: "function", function: { name: "Glob" } }],
      },
      {
        role: "tool",
        tool_results: [{ tool_use_id: "t1", tool_name: "Glob", output: "a.json" }],
      },
    ]);
  });

  it("gives the third call both earlier steps", () => {
    emit(
      turnOf("fix the bug", [
        llmCall({ text: "reading", tools: [{ id: "t1", name: "Read", result: "source" }] }),
        llmCall({ text: "editing", tools: [{ id: "t2", name: "Edit", result: "applied" }] }),
        llmCall({ text: "fixed" }),
      ]),
    );

    const input = recorded.generations[2].input as ChatMessage[];
    expect(input.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(input[3].content).toBe("editing");
    expect(input[4].tool_results).toEqual([
      { tool_use_id: "t2", tool_name: "Edit", output: "applied" },
    ]);
    expect(recorded.generations[2].metadata.history_messages).toBe(5);
  });

  it("leaves out a tool message for a call whose tools never returned", () => {
    emit(
      turnOf("run it", [
        llmCall({ text: "running", tools: [{ id: "t1", name: "Bash" }] }),
        llmCall({ text: "interrupted" }),
      ]),
    );

    const input = recorded.generations[1].input as ChatMessage[];
    expect(input.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps the root trace input on the turn's own prompt", () => {
    emit(turnOf("second question", [llmCall({ text: "answer" })]), [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);

    expect(recorded.traces[0].input).toEqual({ role: "user", content: "second question" });
    expect((recorded.generations[0].input as ChatMessage[])[0].content).toBe("first question");
  });
});

describe("generation output", () => {
  it("uses the nested function shape for tool calls", () => {
    emit(
      turnOf("go", [
        llmCall({
          text: "calling",
          thinking: "let me check",
          tools: [
            { id: "t1", name: "Read", result: "x" },
            { id: "t2", name: "Grep", result: "y" },
          ],
        }),
      ]),
    );

    const output = recorded.generations[0].output as ChatMessage;
    expect(output.role).toBe("assistant");
    expect(output.content).toBe("calling");
    expect(output.thinking).toBe("let me check");
    expect(output.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "Read" } },
      { id: "t2", type: "function", function: { name: "Grep" } },
    ]);
  });

  it("still nests the tool spans under their generation", () => {
    emit(
      turnOf("go", [
        llmCall({ text: "calling", tools: [{ id: "t1", name: "Read", result: "x" }] }),
      ]),
    );

    expect(recorded.spans).toHaveLength(1);
    expect(recorded.spans[0].name).toBe("Tool: Read");
  });
});

// ─── History across turns ───────────────────────────────────────────────────

describe("generation input — history across turns", () => {
  const transcript = join(FIXTURES, "emit-multi-turn.jsonl");

  it("builds one flat conversation for the whole transcript", () => {
    const history = buildSessionHistory(transcript);
    expect(history).toBeDefined();
    expect(history!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(history!.startIndexByTurnKey.get("2026-01-01T10:01:00.000Z")).toBe(4);
  });

  it("gives turn 2 the whole of turn 1 as its prefix", () => {
    const { messages } = readTranscript(transcript, -1);
    const turns = groupIntoTurns(messages);
    const history = buildSessionHistory(transcript);
    const prefix = historyPrefixForTurn(history, turns[1]);

    expect(prefix).toEqual(buildTurnHistoryMessages(turns[0]));

    emitTurn({
      sessionId: "session-1",
      turnNum: 2,
      turn: turns[1],
      transcriptName: "emit-multi-turn.jsonl",
      traceId: "trace-2",
      historyPrefix: prefix,
    });

    const firstInput = recorded.generations[0].input as ChatMessage[];
    expect(firstInput.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(firstInput[0].content).toBe("List the config files");
    expect(firstInput[1].tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "Glob" } },
    ]);
    expect(firstInput[4].content).toBe("Now read the first one");

    // The second call of turn 2 adds that turn's own step to the same prefix.
    const secondInput = recorded.generations[1].input as ChatMessage[];
    expect(secondInput.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
    ]);
    expect(secondInput[6].tool_results).toEqual([
      { tool_use_id: "toolu_2", tool_name: "Read", output: '{"name":"demo"}' },
    ]);
  });

  it("falls back to no prefix for a turn the transcript does not hold", () => {
    const history = buildSessionHistory(transcript);
    const stray = turnOf("never written to disk", [llmCall({ text: "hm" })]);
    expect(historyPrefixForTurn(history, stray)).toEqual([]);
  });

  it("returns undefined for a transcript that is missing or empty", () => {
    expect(buildSessionHistory(join(FIXTURES, "emit-does-not-exist.jsonl"))).toBeUndefined();
    expect(historyPrefixForTurn(undefined, turnOf("x", []))).toEqual([]);
  });
});

// ─── Truncation ─────────────────────────────────────────────────────────────

describe("truncation", () => {
  it("applies to the prompt, the answer and the tool results in the history", () => {
    setMaxChars(10);
    const long = "x".repeat(200);
    emit(
      turnOf(long, [
        llmCall({ text: long, tools: [{ id: "t1", name: "Read", result: long }] }),
        llmCall({ text: "short" }),
      ]),
    );

    const input = recorded.generations[1].input as ChatMessage[];
    expect(input[0].content).toMatch(/^x{10}\n\n\[\.\.\.truncated, 190 more chars\]$/);
    expect(input[1].content).toMatch(/^x{10}\n\n\[\.\.\.truncated, 190 more chars\]$/);
    expect(String(input[2].tool_results![0].output)).toMatch(
      /^x{10}\n\n\[\.\.\.truncated, 190 more chars\]$/,
    );
    expect(recorded.traces[0].input.content).toMatch(/\[\.\.\.truncated, 190 more chars\]$/);
  });
});
