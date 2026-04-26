/**
 * Tests for the tri-state tracing-decision matrix in `shouldTrace`.
 *
 * Decision rule (per src/utils/hook-init.ts):
 *   1. TRACE_TO_LANGFUSE explicitly "true"   → trace
 *   2. TRACE_TO_LANGFUSE explicitly "false"  → don't trace
 *   3. CC_LANGFUSE_TRACE_DEFAULT === "all"   → trace
 *   4. otherwise                             → don't trace
 */

import { describe, it, expect } from "vitest";
import { shouldTrace } from "../../src/utils/hook-init.js";

type Env = NodeJS.ProcessEnv;
const env = (overrides: Record<string, string | undefined>): Env => overrides as Env;

describe("shouldTrace — per-invocation override (TRACE_TO_LANGFUSE wins)", () => {
  it("explicit 'true' enables tracing regardless of default", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "true" }))).toBe(true);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "true", CC_LANGFUSE_TRACE_DEFAULT: "all" }))).toBe(
      true,
    );
    expect(
      shouldTrace(env({ TRACE_TO_LANGFUSE: "true", CC_LANGFUSE_TRACE_DEFAULT: "opt-in" })),
    ).toBe(true);
  });

  it("explicit 'false' disables tracing regardless of default", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "false" }))).toBe(false);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "false", CC_LANGFUSE_TRACE_DEFAULT: "all" }))).toBe(
      false,
    );
    expect(
      shouldTrace(env({ TRACE_TO_LANGFUSE: "false", CC_LANGFUSE_TRACE_DEFAULT: "opt-in" })),
    ).toBe(false);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "TRUE" }))).toBe(true);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "True" }))).toBe(true);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "  true  " }))).toBe(true);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "FALSE" }))).toBe(false);
  });
});

describe("shouldTrace — global default (CC_LANGFUSE_TRACE_DEFAULT applies when override absent)", () => {
  it("'all' enables tracing", () => {
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "all" }))).toBe(true);
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "ALL" }))).toBe(true);
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: " all " }))).toBe(true);
  });

  it("'opt-in' (and any other value) means don't trace by default", () => {
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "opt-in" }))).toBe(false);
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "off" }))).toBe(false);
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "yes" }))).toBe(false);
    expect(shouldTrace(env({ CC_LANGFUSE_TRACE_DEFAULT: "" }))).toBe(false);
  });
});

describe("shouldTrace — neither set", () => {
  it("returns false when both env vars are absent (opt-in default)", () => {
    expect(shouldTrace(env({}))).toBe(false);
  });

  it("treats explicit empty/whitespace TRACE_TO_LANGFUSE as 'not set' (falls through to default)", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "" }))).toBe(false);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "   " }))).toBe(false);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "", CC_LANGFUSE_TRACE_DEFAULT: "all" }))).toBe(
      true,
    );
  });

  it("non-true/false values for TRACE_TO_LANGFUSE fall through to default", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "yes" }))).toBe(false);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "1" }))).toBe(false);
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "yes", CC_LANGFUSE_TRACE_DEFAULT: "all" }))).toBe(
      true,
    );
  });
});

describe("shouldTrace — backward compatibility with v0.2.x", () => {
  it("v0.2.x users with TRACE_TO_LANGFUSE=true exported continue to trace", () => {
    expect(shouldTrace(env({ TRACE_TO_LANGFUSE: "true" }))).toBe(true);
  });

  it("v0.2.x users with no TRACE_TO_LANGFUSE continue to NOT trace", () => {
    expect(shouldTrace(env({}))).toBe(false);
  });
});
