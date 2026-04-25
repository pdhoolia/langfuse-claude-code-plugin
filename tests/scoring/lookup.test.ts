/**
 * Tests for resolveFeedbackTarget — the unified scorability gate (ADR-007).
 *
 * Uses real temp state files (no mocks) since the function is a thin
 * composition over loadState + getActiveByCwd + getSessionState.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFeedbackTarget, isLookupFailure } from "../../src/scoring/lookup.js";
import type { TracingState } from "../../src/types.js";

let tmpDir: string;
let stateFilePath: string;

beforeEach(() => {
  // realpath up-front: on macOS /tmp is a symlink, and resolveFeedbackTarget
  // realpath-resolves cwd internally, so the key we store in _active_by_cwd
  // must match.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "lookup-test-")));
  stateFilePath = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeState(state: TracingState): void {
  writeFileSync(stateFilePath, JSON.stringify(state));
}

describe("resolveFeedbackTarget", () => {
  it("returns no_session when _active_by_cwd is empty", () => {
    writeState({});
    const result = resolveFeedbackTarget(stateFilePath, tmpDir);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) expect(result.kind).toBe("no_session");
  });

  it("returns no_session when _active_by_cwd has no entry for this cwd", () => {
    writeState({
      _active_by_cwd: { "/some/other/path": "session-1" },
    });
    const result = resolveFeedbackTarget(stateFilePath, tmpDir);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) expect(result.kind).toBe("no_session");
  });

  it("returns no_substantive_turn when session exists but has no last_substantive_trace_id", () => {
    writeState({
      _active_by_cwd: { [tmpDir]: "session-1" },
      "session-1": {
        last_line: 0,
        turn_count: 0,
        updated: new Date().toISOString(),
      },
    });
    const result = resolveFeedbackTarget(stateFilePath, tmpDir);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) {
      expect(result.kind).toBe("no_substantive_turn");
      expect(result.sessionId).toBe("session-1");
    }
  });

  it("returns the target when both lookup keys are present", () => {
    writeState({
      _active_by_cwd: { [tmpDir]: "session-1" },
      "session-1": {
        last_line: 5,
        turn_count: 2,
        updated: new Date().toISOString(),
        last_substantive_trace_id: "trace-abc",
      },
    });
    const result = resolveFeedbackTarget(stateFilePath, tmpDir);
    expect(isLookupFailure(result)).toBe(false);
    if (!isLookupFailure(result)) {
      expect(result.sessionId).toBe("session-1");
      expect(result.lastSubstantiveTraceId).toBe("trace-abc");
    }
  });

  it("returns no_session when state file does not exist", () => {
    const result = resolveFeedbackTarget(join(tmpDir, "nonexistent.json"), tmpDir);
    expect(isLookupFailure(result)).toBe(true);
    if (isLookupFailure(result)) expect(result.kind).toBe("no_session");
  });
});
