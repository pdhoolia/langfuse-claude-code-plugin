/**
 * Parity test for `computeScoreId` against the Python reference in
 * `context-gateway/src/core/observability/session_scoring.py::_deterministic_score_id`.
 *
 * Expected values were generated with:
 *   python3 -c "from src.core.observability.session_scoring import _deterministic_score_id; print(_deterministic_score_id(<tid>, <name>))"
 *
 * If this test ever fails, EITHER:
 *   (a) the Node implementation diverged from the Python reference (bug — fix it), OR
 *   (b) the Python reference itself changed (intentional — regenerate fixtures and update both sides in lockstep).
 */

import { describe, it, expect } from "vitest";
import { computeScoreId } from "../../src/scoring/id.js";

describe("computeScoreId — parity with context-gateway Python reference", () => {
  // Fixtures pinned from running the Python reference on 2026-04-25.
  const cases: Array<[string, string, string]> = [
    [
      "00000000-0000-0000-0000-000000000000",
      "turn_feedback",
      "81316ef5-29d0-00f3-b123-1be447c83a57",
    ],
    ["abc123def456", "session_feedback", "f2aae6eb-fa2c-0d8e-4f3e-d6733c056074"],
    [
      "7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a",
      "turn_feedback",
      "41533bd4-5da1-8cea-c7b2-1a023a1b14dd",
    ],
    [
      "7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a",
      "session_feedback",
      "d680aa66-a707-0ad8-dbef-c2c3a6a8597e",
    ],
  ];

  for (const [tid, name, expected] of cases) {
    it(`(${tid}, ${name}) → ${expected}`, () => {
      expect(computeScoreId(tid, name)).toBe(expected);
    });
  }
});

describe("computeScoreId — properties", () => {
  it("is deterministic (same inputs → same output across calls)", () => {
    const id1 = computeScoreId("trace-X", "turn_feedback");
    const id2 = computeScoreId("trace-X", "turn_feedback");
    expect(id1).toBe(id2);
  });

  it("is sensitive to inputs (different (target, name) → different IDs)", () => {
    expect(computeScoreId("trace-X", "turn_feedback")).not.toBe(
      computeScoreId("trace-X", "session_feedback"),
    );
    expect(computeScoreId("trace-X", "turn_feedback")).not.toBe(
      computeScoreId("trace-Y", "turn_feedback"),
    );
  });

  it("output is a valid UUID-formatted string (8-4-4-4-12 lowercase hex)", () => {
    const id = computeScoreId("anything", "anything");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
