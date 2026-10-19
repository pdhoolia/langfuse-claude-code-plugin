/**
 * Tests for the state-file lock behind `atomicUpdateState`.
 *
 * Nine hooks write `langfuse_state.json`, some of them concurrently, so the
 * lock has to hold under contention, recover from a lock left behind by a
 * process that died, and refuse to steal a lock that is still live. When it
 * cannot take the lock it skips the update — a hook must never block or fail
 * the session.
 *
 * Uses real temp directories and real lock files (no mocks): the thing under
 * test is filesystem behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicUpdateState, loadState } from "../src/state.js";
import type { TracingState } from "../src/types.js";

let tmpDir: string;
let stateFilePath: string;
let lockFilePath: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "state-test-")));
  stateFilePath = join(tmpDir, "langfuse_state.json");
  lockFilePath = `${stateFilePath}.lock`;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal session entry, so state files look like real ones. */
function session(lastLine: number): TracingState[string] {
  return { last_line: lastLine, turn_count: 0, updated: "" };
}

/** Write a lock file as if another process held it, with a given age. */
function plantLock(ageMs: number, owner = "99999:planted"): void {
  writeFileSync(lockFilePath, owner);
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(lockFilePath, when, when);
}

describe("atomicUpdateState — contention", () => {
  it("loses no write when many updates run concurrently", async () => {
    writeFileSync(stateFilePath, JSON.stringify({}));

    const count = 25;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        atomicUpdateState(stateFilePath, (state) => ({ ...state, [`s${i}`]: session(i) })),
      ),
    );

    expect(results.every(Boolean)).toBe(true);
    const state = loadState(stateFilePath);
    for (let i = 0; i < count; i++) {
      expect(state[`s${i}`]).toEqual(session(i));
    }
  });

  it("serialises read-modify-write, so an accumulating counter is exact", async () => {
    writeFileSync(stateFilePath, JSON.stringify({ s: session(0) }));

    await Promise.all(
      Array.from({ length: 20 }, () =>
        atomicUpdateState(stateFilePath, (state) => {
          const current = (state.s as { last_line: number }).last_line;
          return { ...state, s: session(current + 1) };
        }),
      ),
    );

    expect((loadState(stateFilePath).s as { last_line: number }).last_line).toBe(20);
  });

  it("releases the lock after a successful update", async () => {
    await atomicUpdateState(stateFilePath, (state) => ({ ...state, s: session(1) }));
    expect(existsSync(lockFilePath)).toBe(false);
  });
});

describe("atomicUpdateState — stale lock", () => {
  it("recovers a lock left behind by a process that died", async () => {
    plantLock(60_000);
    writeFileSync(stateFilePath, JSON.stringify({}));

    const written = await atomicUpdateState(stateFilePath, (state) => ({
      ...state,
      s: session(7),
    }));

    expect(written).toBe(true);
    expect(loadState(stateFilePath).s).toEqual(session(7));
    // The stale lock is gone, and so is the file it was moved aside to.
    expect(existsSync(lockFilePath)).toBe(false);
    expect(readdirSync(tmpDir).filter((f) => f.includes(".stale."))).toEqual([]);
  });

  it("re-acquires after dropping it, rather than entering the section unlocked", async () => {
    plantLock(60_000);

    // The old failure mode: remove the stale lock and proceed holding nothing,
    // while whoever created it is still in its own critical section.
    let heldDuringSection = "";
    await atomicUpdateState(stateFilePath, (state) => {
      heldDuringSection = existsSync(lockFilePath) ? readFileSync(lockFilePath, "utf-8") : "";
      return { ...state, s: session(1) };
    });

    expect(heldDuringSection.startsWith(`${process.pid}:`)).toBe(true);
  });

  it("keeps waiting when another caller wins the re-acquisition", async () => {
    plantLock(60_000);

    // Two callers both judge the planted lock stale. Only one can take it, and
    // neither may write while the other is inside.
    const results = await Promise.all([
      atomicUpdateState(stateFilePath, (state) => ({ ...state, a: session(1) })),
      atomicUpdateState(stateFilePath, (state) => ({ ...state, b: session(2) })),
    ]);

    expect(results).toEqual([true, true]);
    const state = loadState(stateFilePath);
    expect(state.a).toEqual(session(1));
    expect(state.b).toEqual(session(2));
  });
});

describe("atomicUpdateState — live lock", () => {
  it("does not steal a lock that is still live, and proceeds once it frees up", async () => {
    plantLock(0);
    writeFileSync(stateFilePath, JSON.stringify({}));

    const pending = atomicUpdateState(stateFilePath, (state) => ({ ...state, s: session(3) }));

    // Still waiting: the state file is untouched and the lock is intact.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(loadState(stateFilePath)).toEqual({});
    expect(readFileSync(lockFilePath, "utf-8")).toBe("99999:planted");

    rmSync(lockFilePath);
    expect(await pending).toBe(true);
    expect(loadState(stateFilePath).s).toEqual(session(3));
  });

  it(
    "skips quietly when the lock never frees up, leaving state and lock untouched",
    async () => {
      plantLock(0);
      writeFileSync(stateFilePath, JSON.stringify({ s: session(1) }));

      // The lock is fresh, so it is never judged stale; the caller waits out
      // its 5s budget and gives up.
      const written = await atomicUpdateState(stateFilePath, (state) => ({
        ...state,
        s: session(2),
      }));

      expect(written).toBe(false);
      expect(loadState(stateFilePath).s).toEqual(session(1));
      // A caller that never held the lock must not delete the holder's.
      expect(readFileSync(lockFilePath, "utf-8")).toBe("99999:planted");
    },
    15_000,
  );
});

describe("atomicUpdateState — lock file contents", () => {
  it("stamps the owning pid into the lock, so an abandoned lock is identifiable", async () => {
    let stamp = "";
    await atomicUpdateState(stateFilePath, (state) => {
      stamp = readFileSync(lockFilePath, "utf-8");
      return state;
    });

    expect(stamp.startsWith(`${process.pid}:`)).toBe(true);
  });
});
