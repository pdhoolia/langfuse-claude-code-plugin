# Implementation Specification: User Feedback Capture

**Version:** 1.0
**Date:** 2026-04-25
**Based on:** HLD v1.1, ADR-Lite (ADR-001 through ADR-008)

This is the contract for code generation. Every interface, file path, schema change, and test fixture below is binding. Discoveries during code that warrant deviation must be reflected back here before merging.

---

## 1. New & Modified Files (Inventory)

| Path                                                     | Status   | Purpose                                                                                                                                                                       |
| -------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/scoring/id.ts`                                      | **NEW**  | `computeScoreId(targetId, name)` — SHA-256 + UUID-format. ADR-004/005.                                                                                                        |
| `src/scoring/parse.ts`                                   | **NEW**  | Argv parser for `up\|down [comment]`. Shared by both commands.                                                                                                                |
| `src/scoring/lookup.ts`                                  | **NEW**  | Resolve `(cwd) → (sessionId, last_substantive_trace_id)` from state. Shared gate.                                                                                             |
| `src/scoring/match.ts`                                   | **NEW**  | `isFeedbackCommand(prompt)` — used by UserPromptSubmit and Stop hooks.                                                                                                        |
| `src/commands/feedback.ts`                               | **NEW**  | Turn-feedback CLI entry point.                                                                                                                                                |
| `src/commands/journey.ts`                                | **NEW**  | Session-feedback CLI entry point.                                                                                                                                             |
| `commands/feedback.md`                                   | **NEW**  | Slash-command surface for `/feedback`.                                                                                                                                        |
| `commands/journey.md`                                    | **NEW**  | Slash-command surface for `/journey`.                                                                                                                                         |
| `src/types.ts`                                           | MODIFIED | Add `last_substantive_trace_id?` to `SessionState`; add `_active_by_cwd` to top-level state shape.                                                                            |
| `src/state.ts`                                           | MODIFIED | `getSessionState` unchanged; `pruneOldSessions` extended to garbage-collect `_active_by_cwd` entries pointing at pruned sessions; helpers for `_active_by_cwd` upsert/remove. |
| `src/hooks/user-prompt-submit.ts`                        | MODIFIED | Detect feedback commands → skip trace allocation; always upsert `_active_by_cwd[realpath(cwd)] = sessionId`.                                                                  |
| `src/hooks/stop.ts`                                      | MODIFIED | Promote `current_trace_id` → `last_substantive_trace_id` after successful emission of a non-feedback turn; gracefully handle missing trace (advance `last_line`, no emit).    |
| `src/hooks/session-end.ts`                               | MODIFIED | After existing logic, also write `last_substantive_trace_id` (if interrupted turn was traced) and remove `_active_by_cwd[realpath(cwd)]` if it points at this session.        |
| `src/langfuse.ts`                                        | MODIFIED | `closeInterruptedTurn` returns the trace ID it finalized so the caller can write `last_substantive_trace_id`.                                                                 |
| `esbuild.config.mjs`                                     | MODIFIED | Add command entry points; switch to `outbase: "dist"` so output mirrors source tree (`bundle/hooks/*.js` and `bundle/commands/*.js`).                                         |
| `hooks/hooks.json`                                       | MODIFIED | All 9 hook command paths change from `bundle/<name>.js` to `bundle/hooks/<name>.js`. Companion change to `outbase` (§3.12).                                                   |
| `bundle/<old hook bundles>`                              | DELETED  | 9 stale flat-layout hook bundles removed in the migration commit. Regenerated under `bundle/hooks/` by `pnpm build`.                                                          |
| `tests/scoring/id.test.ts`                               | **NEW**  | Parity test against Python reference (4+ fixed input/output pairs).                                                                                                           |
| `tests/scoring/parse.test.ts`                            | **NEW**  | Argv parser cases.                                                                                                                                                            |
| `tests/scoring/match.test.ts`                            | **NEW**  | `isFeedbackCommand` matrix.                                                                                                                                                   |
| `tests/commands/feedback.integration.test.ts`            | **NEW**  | End-to-end CLI test against a mocked langfuse client + fake state.                                                                                                            |
| `tests/commands/journey.integration.test.ts`             | **NEW**  | Same shape, session scope.                                                                                                                                                    |
| `tests/hooks/user-prompt-submit.feedback-filter.test.ts` | **NEW**  | Verifies feedback prompts skip trace allocation.                                                                                                                              |
| `tests/hooks/stop.no-trace.test.ts`                      | **NEW**  | Verifies Stop hook handles missing `current_trace_id` gracefully.                                                                                                             |

---

## 2. Persistence (State Schema Delta)

### 2.1 Updated `src/types.ts`

**Additions only — no removals or breaking changes.**

```typescript
// ─── Tracing State ─────────────────────────────────────────────────────────

export interface SessionState {
  last_line: number;
  turn_count: number;
  updated: string;
  /** Current turn's Langfuse trace ID, set by UserPromptSubmit hook */
  current_trace_id?: string;
  /**
   * Most recent COMPLETED substantive turn's trace ID.
   * - Written by Stop after a successful, non-feedback emission.
   * - Written by closeInterruptedTurn (interrupted turns count as substantive — ADR-008).
   * - Read by /feedback (target) and used as the gate for both /feedback and /journey (ADR-007).
   * - Never points to a feedback-command turn (those skip trace allocation — ADR-002).
   */
  last_substantive_trace_id?: string;
  current_turn_number?: number;
  current_turn_start?: number;
  last_tool_end_time?: number;
  tool_start_times?: Record<string, number>;
  task_run_map?: Record<
    string,
    {
      /* unchanged */
    }
  >;
  compaction_start_time?: number;
  pending_subagent_traces?: Array<{
    /* unchanged */
  }>;
}

/**
 * Top-level state shape.
 * Session entries are keyed by session_id (UUID-shaped strings).
 * Reserved underscore-prefixed keys hold non-session data:
 *   - _active_by_cwd: maps absolute, realpath-resolved cwd → session_id
 *     of the most recent UserPromptSubmit invocation in that cwd.
 *     Read by slash command CLIs to find the active session.
 */
export interface TracingState {
  _active_by_cwd?: Record<string, string>;
  [sessionId: string]: SessionState | Record<string, string> | undefined;
}
```

> **Note on type unsafety.** The index signature on `TracingState` widens to `SessionState | Record<string,string>` because TypeScript can't express "session-shaped values for UUID keys, lookup map for the reserved key." All consumers MUST go through helper functions (`getActiveByCwd`, `setActiveByCwd`, `removeActiveByCwd`, `getSessionState`) that handle the discrimination internally — never index `state[someKey]` directly outside `state.ts`.

### 2.2 Backward compatibility

Old state files (no `_active_by_cwd`, no `last_substantive_trace_id`) are valid. New optional fields are simply absent until first written. The first feedback command after upgrade will see "no completed turn yet" until the next non-feedback turn finishes; this is correct behavior.

### 2.3 Pruning

`pruneOldSessions(state)` is extended:

1. Apply existing 24h-old-session prune (unchanged).
2. After pruning sessions, walk `_active_by_cwd`: for each `(cwd, sessionId)` entry, if `state[sessionId]` is no longer present, delete the entry.

```typescript
export function pruneOldSessions(state: TracingState, now: number = Date.now()): TracingState {
  const cutoff = now - SESSION_MAX_AGE_MS;
  const pruned: TracingState = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "_active_by_cwd") continue; // handle below
    const session = value as SessionState;
    const updatedMs = session.updated ? new Date(session.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      pruned[key] = session;
    }
  }
  // Re-attach _active_by_cwd, dropping entries pointing at pruned sessions.
  const oldMap = state._active_by_cwd ?? {};
  const newMap: Record<string, string> = {};
  for (const [cwd, sid] of Object.entries(oldMap)) {
    if (sid in pruned) newMap[cwd] = sid;
  }
  if (Object.keys(newMap).length > 0) {
    pruned._active_by_cwd = newMap;
  }
  return pruned;
}
```

### 2.4 New state.ts helpers

```typescript
/** Get the active session ID for a cwd, or undefined. Caller must pre-realpath cwd. */
export function getActiveByCwd(state: TracingState, cwd: string): string | undefined {
  return state._active_by_cwd?.[cwd];
}

/** Upsert the active session ID for a cwd. Caller must pre-realpath cwd. */
export function setActiveByCwd(state: TracingState, cwd: string, sessionId: string): TracingState {
  return { ...state, _active_by_cwd: { ...(state._active_by_cwd ?? {}), [cwd]: sessionId } };
}

/** Remove the cwd entry only if it points at the given sessionId (no-op otherwise). */
export function removeActiveByCwd(
  state: TracingState,
  cwd: string,
  sessionId: string,
): TracingState {
  const map = state._active_by_cwd;
  if (!map || map[cwd] !== sessionId) return state;
  const { [cwd]: _drop, ...rest } = map;
  return { ...state, _active_by_cwd: rest };
}
```

---

## 3. Module Interfaces

### 3.1 `src/scoring/id.ts`

**Responsibility:** Compute deterministic, idempotent score IDs that match the `context-gateway` Python reference byte-for-byte.

```typescript
import { createHash } from "node:crypto";

/**
 * Generate a deterministic UUID-formatted ID for a (target, score-name) pair.
 *
 * Algorithm (matches `context-gateway/src/core/observability/session_scoring.py::_deterministic_score_id`):
 *   1. UTF-8 encode `${targetId}:${name}`.
 *   2. SHA-256.
 *   3. Take the first 16 bytes.
 *   4. Format as UUID string (8-4-4-4-12 hex digits, lowercase).
 *
 * @param targetId  The trace ID (turn-scope) or session ID (session-scope).
 * @param name      The score name, e.g. "turn_feedback" or "session_feedback".
 * @returns A UUID-formatted string suitable as a Langfuse score ID.
 */
export function computeScoreId(targetId: string, name: string): string {
  const digest = createHash("sha256").update(`${targetId}:${name}`).digest();
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
```

**Contract:**

- Pure function. No I/O, no env access.
- Deterministic across runs and across language implementations of the same algorithm.
- Lowercase hex output.

**Parity test fixtures** (these MUST be cross-validated against the Python reference before merge — see §6.1):

| `targetId`                             | `name`             | Expected ID                       |
| -------------------------------------- | ------------------ | --------------------------------- |
| `00000000-0000-0000-0000-000000000000` | `turn_feedback`    | (compute via Python; pin in test) |
| `abc123def456`                         | `session_feedback` | (compute via Python; pin in test) |
| `7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a` | `turn_feedback`    | (compute via Python; pin in test) |
| `7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a` | `session_feedback` | (compute via Python; pin in test) |

### 3.2 `src/scoring/parse.ts`

**Responsibility:** Parse the slash command argument string into `direction` and optional `comment`.

```typescript
export interface ParsedFeedbackArgs {
  direction: "up" | "down";
  comment?: string;
}

export interface ParseError {
  error: string;
  hint: string;
}

/**
 * Parse the raw argument string from a slash command invocation.
 *
 * Grammar:
 *   args := DIRECTION [WHITESPACE COMMENT]
 *   DIRECTION := "up" | "down"
 *   COMMENT := <any text including whitespace, trimmed>
 *
 * Examples:
 *   ""                          → error: "missing direction"
 *   "up"                        → {direction: "up"}
 *   "down"                      → {direction: "down"}
 *   "up great answer"           → {direction: "up", comment: "great answer"}
 *   "down  too verbose  "       → {direction: "down", comment: "too verbose"}
 *   "maybe"                     → error: "unknown direction 'maybe'"
 *   "UP"                        → {direction: "up"} (case-insensitive)
 *
 * @param argv  The raw argument string (everything after the slash command name).
 */
export function parseArgs(argv: string): ParsedFeedbackArgs | ParseError;
```

**Contract:**

- Direction matching is case-insensitive but the returned `direction` is always lowercase.
- Comment is trimmed of leading/trailing whitespace; empty comment is omitted (not `""`).
- Unknown direction → `ParseError` with command-specific `hint` injected by the caller.

### 3.3 `src/scoring/match.ts`

**Responsibility:** Detect whether a user prompt is a feedback slash command, used by both UserPromptSubmit (for filtering) and Stop (defensive double-check per HLD §8 risk row 6).

```typescript
/**
 * Returns true if the prompt is an invocation of /feedback or /journey
 * (in any of the recognized forms: bare or plugin-namespaced).
 *
 * Recognized forms (case-sensitive on the command name, leading/trailing whitespace tolerated):
 *   /feedback ...
 *   /journey ...
 *   /langfuse-tracing:feedback ...
 *   /langfuse-tracing:journey ...
 *
 * The comparison is on the FIRST WORD only (everything up to the first whitespace).
 * Bare command without arguments (e.g. just "/feedback") also matches.
 */
export function isFeedbackCommand(prompt: string): boolean;
```

**Contract:**

- Pattern: `^\s*/(?:langfuse-tracing:)?(feedback|journey)(\s|$)`.
- Case-sensitive on the command name (`/Feedback` does NOT match — Claude Code itself is case-sensitive on slash command names).
- The plugin-namespaced form is recognized whether or not Q-OPEN-6 ends up using it; safer to accept both.

### 3.4 `src/scoring/lookup.ts`

**Responsibility:** Shared resolver for slash-command CLIs — find the active session ID and the scorable trace ID for the current cwd.

```typescript
import { realpathSync } from "node:fs";

export interface FeedbackTarget {
  /** The active session ID for this cwd. */
  sessionId: string;
  /** The most recent substantive turn's trace ID (always set when this is returned). */
  lastSubstantiveTraceId: string;
}

export type LookupFailure =
  | { kind: "no_session"; cwd: string } // _active_by_cwd[cwd] missing
  | { kind: "no_substantive_turn"; sessionId: string }; // last_substantive_trace_id missing

/**
 * Resolve the feedback target for the current cwd.
 * Reads state under the existing atomicUpdateState lock convention (read-only).
 *
 * @param stateFilePath  Path to langfuse_state.json (from config).
 * @param cwd            Process cwd at invocation time. Will be realpath-resolved internally.
 */
export async function resolveFeedbackTarget(
  stateFilePath: string,
  cwd: string,
): Promise<FeedbackTarget | LookupFailure>;
```

**Contract:**

- Internally calls `realpathSync(cwd)` — symlink normalization (HLD §8 risk row 3).
- Uses `loadState()` directly (no write needed for read; the lock is for write-write correctness).
- Returns the failure variant for both gate cases (ADR-007).

### 3.5 `src/commands/feedback.ts` (CLI entry point)

```typescript
#!/usr/bin/env node
/**
 * /feedback up|down [comment] — turn-scope thumbs feedback.
 *
 * argv[2] is the raw argument string from Claude Code's $ARGUMENTS substitution
 * (a single string, possibly containing whitespace).
 *
 * Exit codes: always 0. (NFC-2: never block, never noisy.)
 */
async function main(): Promise<void>;
```

**Behavior (in order):**

1. `initHook()` — kill switch + credentials. If null, exit 0 silently.
2. `parseArgs(process.argv.slice(2).join(" "))` — handle ParseError by printing `Usage: /feedback up|down [optional comment]` and exit 0.
3. `resolveFeedbackTarget(config.stateFilePath, process.cwd())` —
   - `no_session` → print `No traced session found for this directory. Is TRACE_TO_LANGFUSE=true?` and exit 0.
   - `no_substantive_turn` → print `No completed turn yet to score. Try /feedback after Claude has responded.` and exit 0.
4. Compute `scoreId = computeScoreId(target.lastSubstantiveTraceId, "turn_feedback")`.
5. Initialize Langfuse client (`initClient(...)`).
6. Call `langfuse.score({ id: scoreId, name: "turn_feedback", traceId: target.lastSubstantiveTraceId, value: parsed.direction === "up" ? 1 : -1, comment: parsed.comment })`.
7. Flush with timeout: `Promise.race([flushAsync(), timeout(2000)])`.
8. Print `✓ turn_feedback ${value > 0 ? "+1" : "-1"} recorded for trace ${target.lastSubstantiveTraceId.slice(0, 8)}…`.
9. Exit 0.

All errors (network, score throw, etc.) caught and logged via existing `error()`. On error, print `Feedback recorded locally; sync may be delayed.` to stdout. Still exit 0.

### 3.6 `src/commands/journey.ts` (CLI entry point)

Same shape as §3.5 with these substitutions:

- Score name: `session_feedback`
- Target field on score: `sessionId` (set to `target.sessionId`), and `traceId` is **omitted**.
- Compute `scoreId = computeScoreId(target.sessionId, "session_feedback")`.
- "no_substantive_turn" message: `No conversation yet to score. Try /journey after Claude has responded at least once.`
- Confirmation: `✓ session_feedback ${±1} recorded for session ${target.sessionId.slice(0, 8)}…`.

The lookup gate is identical (both commands require `last_substantive_trace_id` to be present per ADR-007), even though `/journey` only uses `sessionId` in the score body.

### 3.7 Slash command markdown files

#### `commands/feedback.md`

```markdown
---
description: Record thumbs-up/down feedback on the most recent completed turn
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: up|down [optional comment]
---

!`node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/feedback.js" $ARGUMENTS`
```

#### `commands/journey.md`

```markdown
---
description: Record thumbs-up/down feedback on the entire current session
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: up|down [optional comment]
---

!`node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/journey.js" $ARGUMENTS`
```

**Notes:**

- `disable-model-invocation: true` — Claude must never auto-invoke these. They have side effects (write to Langfuse).
- `allowed-tools: Bash(node:*)` — narrowest possible permission scope; only `node` invocations allowed without prompt.
- `$ARGUMENTS` substitution carries the full argument string.
- The bash injection's stdout becomes the rendered prompt content. Claude will see one line and reply briefly — that turn is _not_ traced (ADR-002).

### 3.8 Modified `src/hooks/user-prompt-submit.ts`

**Two changes** to the existing `main()`:

**(a) Always upsert `_active_by_cwd` (early in the function, before any other state mutation):**

```typescript
const realCwd = realpathSync(input.cwd); // import { realpathSync } from "node:fs"
await atomicUpdateState(config.stateFilePath, (s) => setActiveByCwd(s, realCwd, input.session_id));
```

This must happen even for feedback commands and even for subagent invocations — the `_active_by_cwd` map is purely a cwd→session lookup and doesn't care about turn type.

**(b) Skip trace allocation for feedback commands** — wrap the existing trace creation block in:

```typescript
if (isFeedbackCommand(input.prompt)) {
  debug(`Feedback command detected (${input.prompt.split(/\s/)[0]}); skipping trace allocation`);
  // Do NOT call langfuse.trace(...).
  // Do NOT set current_trace_id.
  // Do NOT increment turn_count (Stop will see no current_trace_id and gracefully no-op).
  // _active_by_cwd is already updated above.
  return;
}
// … existing trace allocation logic continues unchanged …
```

**Subagent guard.** The existing `if (input.agent_id || input.agent_type) return;` early-exit must come BEFORE the `_active_by_cwd` upsert (subagent turns shouldn't claim cwd ownership). Put the upsert just AFTER the subagent guard.

### 3.9 Modified `src/hooks/stop.ts`

**Two changes:**

**(a) Defensive no-op when no trace was allocated.** Insert AFTER the existing `if (messages.length === 0)` block, before turn grouping:

```typescript
// Feedback turns skip trace allocation in UserPromptSubmit (ADR-002).
// If we reach Stop with no current_trace_id, advance last_line and exit.
if (!sessionState.current_trace_id) {
  debug("No current_trace_id (likely a feedback turn) — advancing last_line and exiting");
  await atomicUpdateState(config.stateFilePath, (s) => {
    const ss = getSessionState(s, input.session_id);
    return {
      ...s,
      [input.session_id]: { ...ss, last_line: lastLine, updated: new Date().toISOString() },
    };
  });
  return;
}
```

**(b) Promote `current_trace_id` → `last_substantive_trace_id` after successful emission.** In the existing state-write block (currently around lines 147–163), add the field, BUT only if at least one turn was traced AND that turn's input is not a feedback command (defensive double-check per HLD §8 risk row 6):

```typescript
// Determine whether the last traced turn was substantive.
let promoteTraceId: string | undefined = undefined;
if (tracedTurns > 0 && currentTraceId) {
  const lastTurn = turns[turns.length - 1];
  const userText =
    typeof lastTurn.userContent === "string"
      ? lastTurn.userContent
      : extractText(lastTurn.userContent as ContentBlock[]);
  if (!isFeedbackCommand(userText)) {
    promoteTraceId = currentTraceId;
  }
}

// In the existing atomicUpdateState block:
return pruneOldSessions({
  ...latestState,
  [input.session_id]: {
    ...latestSession,
    last_line: savedLastLine,
    turn_count: latestSession.turn_count + tracedTurns,
    updated: new Date().toISOString(),
    current_trace_id: undefined,
    // NEW:
    last_substantive_trace_id: promoteTraceId ?? latestSession.last_substantive_trace_id,
    pending_subagent_traces: [],
    tool_start_times: {},
    task_run_map: {},
  },
});
```

The `?? latestSession.last_substantive_trace_id` keeps the previous value when this turn was a feedback turn that somehow slipped through (paranoid; should never trigger in practice).

### 3.10 Modified `src/hooks/session-end.ts`

**Two changes:**

**(a) Capture `closeInterruptedTurn`'s trace ID** for the `last_substantive_trace_id` promotion.

The existing call to `closeInterruptedTurn` already runs and uses `sessionState.current_trace_id` as the trace ID for the interrupted turn. We extend the function (§3.11) to return that ID, then write it.

**(b) Remove the `_active_by_cwd` entry** for this session.

```typescript
const realCwd = realpathSync(input.cwd);
await atomicUpdateState(config.stateFilePath, (s) => {
  const cleaned = removeActiveByCwd(s, realCwd, input.session_id);
  const ss = getSessionState(cleaned, input.session_id);
  return {
    ...cleaned,
    [input.session_id]: {
      ...ss,
      last_line: lastLine,
      turn_count: ss.turn_count + turnsTraced,
      current_trace_id: undefined,
      // NEW: promote interrupted trace as substantive (ADR-008)
      last_substantive_trace_id:
        turnsTraced > 0 && finalizedTraceId ? finalizedTraceId : ss.last_substantive_trace_id,
      task_run_map: {},
      tool_start_times: {},
      pending_subagent_traces: [],
    },
  };
});
```

### 3.11 Modified `src/langfuse.ts::closeInterruptedTurn`

Change the return type to include the finalized trace ID:

```typescript
export async function closeInterruptedTurn(options: {
  sessionId: string;
  sessionState: SessionState;
  transcriptPath: string | undefined;
  config: { maxChars: number };
}): Promise<{ lastLine: number; turnsTraced: number; finalizedTraceId?: string }> {
  // ... existing logic ...
  return {
    lastLine,
    turnsTraced,
    finalizedTraceId: turnsTraced > 0 ? sessionState.current_trace_id : undefined,
  };
}
```

The existing call site in `user-prompt-submit.ts` ignores the new field — backward-compatible.

### 3.12 Modified `esbuild.config.mjs` — restructured `bundle/` layout

**Decision (locked).** Use `outbase: "dist"` so the bundled output mirrors the source tree: `bundle/hooks/<name>.js` for hook bundles and `bundle/commands/<name>.js` for command bundles. The flat `bundle/<name>.js` layout is retired — keeping hooks at the top level alongside `bundle/commands/` would have been visually confusing and inconsistent with the source structure.

```javascript
import { build } from "esbuild";
import { chmodSync } from "node:fs";

const hookEntries = [
  "dist/hooks/user-prompt-submit.js",
  "dist/hooks/pre-tool-use.js",
  "dist/hooks/post-tool-use.js",
  "dist/hooks/stop.js",
  "dist/hooks/stop-failure.js",
  "dist/hooks/subagent-stop.js",
  "dist/hooks/pre-compact.js",
  "dist/hooks/post-compact.js",
  "dist/hooks/session-end.js",
];

const commandEntries = ["dist/commands/feedback.js", "dist/commands/journey.js"];

await build({
  entryPoints: [...hookEntries, ...commandEntries],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  outbase: "dist", // preserves dist/hooks → bundle/hooks, dist/commands → bundle/commands
  external: ["node:*"],
});

for (const entry of [...hookEntries, ...commandEntries]) {
  // entry "dist/hooks/stop.js" → "bundle/hooks/stop.js"
  chmodSync(entry.replace(/^dist\//, "bundle/"), 0o755);
}

console.log(`Bundled ${hookEntries.length} hooks + ${commandEntries.length} commands into bundle/`);
```

**Required companion change to `hooks/hooks.json`.** Every one of the nine hook entries must update its `command` string from `bundle/<name>.js` to `bundle/hooks/<name>.js`. No other field changes; no timeout, no async, no event-name change.

Concretely, all nine of these substitutions:

| Hook event       | Before                         | After                                |
| ---------------- | ------------------------------ | ------------------------------------ |
| UserPromptSubmit | `bundle/user-prompt-submit.js` | `bundle/hooks/user-prompt-submit.js` |
| PreToolUse       | `bundle/pre-tool-use.js`       | `bundle/hooks/pre-tool-use.js`       |
| PostToolUse      | `bundle/post-tool-use.js`      | `bundle/hooks/post-tool-use.js`      |
| Stop             | `bundle/stop.js`               | `bundle/hooks/stop.js`               |
| StopFailure      | `bundle/stop-failure.js`       | `bundle/hooks/stop-failure.js`       |
| SubagentStop     | `bundle/subagent-stop.js`      | `bundle/hooks/subagent-stop.js`      |
| PreCompact       | `bundle/pre-compact.js`        | `bundle/hooks/pre-compact.js`        |
| PostCompact      | `bundle/post-compact.js`       | `bundle/hooks/post-compact.js`       |
| SessionEnd       | `bundle/session-end.js`        | `bundle/hooks/session-end.js`        |

**Cleanup of old flat-layout files (one-shot, in the migration commit):**

```bash
git rm bundle/user-prompt-submit.js bundle/pre-tool-use.js bundle/post-tool-use.js \
       bundle/stop.js bundle/stop-failure.js bundle/subagent-stop.js \
       bundle/pre-compact.js bundle/post-compact.js bundle/session-end.js
```

Then `pnpm build` regenerates them under the new `bundle/hooks/` path. Commit both the deletions and the new files together so `git pull` performs the migration atomically for users.

User-facing impact and migration steps are documented in §9.

---

## 4. Score Lifecycle (Quasi State Machine)

### 4.1 Per-(target, score-name) row

```
[no row]  --first /feedback or /journey--> [row: ±1, comment?]
                                                |
                                +---------------+--------------+
                                |                              |
                       --same command,--                --same command,--
                       --opposite direction--          --same direction--
                                |                              |
                                v                              v
                       [row: ∓1, comment?]            [row: ±1, comment?']
                       (correction)                   (idempotent re-write,
                                                       comment may change)
```

- Score ID is `computeScoreId(target, name)` — same for every transition; Langfuse upserts.
- `comment` is overwritten on every write (last comment wins, per Intent FR-6).
- No deletion path in v1. (User can correct a mis-click but cannot "unscored" a target. If this matters in practice, future work.)

### 4.2 Per-session `last_substantive_trace_id`

```
[absent]  --first non-feedback Stop emission--> [trace_id_T1]
[absent]  --closeInterruptedTurn finalizes turn--> [trace_id_T1]
[trace_id_TN]  --next non-feedback Stop emission--> [trace_id_TN+1]
[trace_id_TN]  --feedback turn Stop fires--> [trace_id_TN]   (unchanged; defensive)
[trace_id_TN]  --closeInterruptedTurn--> [trace_id_TN+1]     (interrupted IS substantive — ADR-008)
[trace_id_TN]  --SessionEnd--> (entry remains; pruned in 24h via pruneOldSessions)
```

### 4.3 Per-cwd `_active_by_cwd[cwd]`

```
[absent]  --any UserPromptSubmit (non-subagent)--> [session_id_S1]
[session_id_SN]  --new session in same cwd--> [session_id_SN+1]   (last writer wins)
[session_id_SN]  --SessionEnd for SN--> [absent]   (entry removed)
[session_id_SN]  --SN pruned (24h old, no SessionEnd ever fired)--> [absent]   (gc)
```

---

## 5. Failure Mode Contract Reference

(Reproduced from HLD §4.4 with concrete stdout strings — these are the user-facing strings the implementation must use verbatim.)

| Failure                                           | stdout                                                                                 | Debug log                                                              | Exit |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| `TRACE_TO_LANGFUSE != "true"`                     | (none)                                                                                 | `kill switch off — TRACE_TO_LANGFUSE not set to "true"`                | 0    |
| Credentials missing                               | (none)                                                                                 | `No Langfuse credentials set (...)`                                    | 0    |
| Empty argv                                        | `Usage: /feedback up\|down [optional comment]`                                         | `parseArgs: missing direction`                                         | 0    |
| Unknown direction (e.g., `maybe`)                 | `Usage: /feedback up\|down [optional comment]\n(received: 'maybe')`                    | `parseArgs: unknown direction 'maybe'`                                 | 0    |
| `_active_by_cwd[cwd]` missing                     | `No traced session found for this directory. Is TRACE_TO_LANGFUSE=true?`               | `lookup: no_session for cwd=<cwd>`                                     | 0    |
| `last_substantive_trace_id` missing — `/feedback` | `No completed turn yet to score. Try /feedback after Claude has responded.`            | `lookup: no_substantive_turn for session=<sid>`                        | 0    |
| `last_substantive_trace_id` missing — `/journey`  | `No conversation yet to score. Try /journey after Claude has responded at least once.` | (same)                                                                 | 0    |
| `langfuse.score()` throws                         | `Feedback recorded locally; sync may be delayed.`                                      | `score() failed: <err>` (full stack)                                   | 0    |
| Flush timeout (2s)                                | `Feedback recorded locally; sync may be delayed.`                                      | `flush timeout`                                                        | 0    |
| Happy path — turn                                 | `✓ turn_feedback +1 recorded for trace abcd1234…`                                      | `score posted: id=<id> name=turn_feedback value=+1 traceId=<tid>`      | 0    |
| Happy path — journey                              | `✓ session_feedback -1 recorded for session 7f3c1e8d…`                                 | `score posted: id=<id> name=session_feedback value=-1 sessionId=<sid>` | 0    |

Substitute `/feedback` → `/journey` in messages where applicable. The trailing `…` in the trace/session display is a literal Unicode horizontal ellipsis (U+2026); `slice(0, 8)` gives 8 hex chars.

---

## 6. Test Plan

### 6.1 `tests/scoring/id.test.ts` — parity test (HIGHEST PRIORITY)

Before writing the test, generate the expected outputs by running the Python reference:

```bash
cd /Users/pdhoolia/ghe/opendata/context-gateway
python3 -c "
from src.core.observability.session_scoring import _deterministic_score_id
for tid, name in [
    ('00000000-0000-0000-0000-000000000000', 'turn_feedback'),
    ('abc123def456', 'session_feedback'),
    ('7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a', 'turn_feedback'),
    ('7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a', 'session_feedback'),
]:
    print(f'{tid!r}, {name!r}: {_deterministic_score_id(tid, name)}')
"
```

Pin those exact outputs as `expected` strings in the Vitest test:

```typescript
import { describe, it, expect } from "vitest";
import { computeScoreId } from "../../src/scoring/id";

describe("computeScoreId — parity with context-gateway Python reference", () => {
  const cases: Array<[string, string, string]> = [
    ["00000000-0000-0000-0000-000000000000", "turn_feedback", "<from-python>"],
    ["abc123def456", "session_feedback", "<from-python>"],
    ["7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a", "turn_feedback", "<from-python>"],
    ["7f3c1e8d-2b4a-4d9e-9a1c-5e8f2b7d3c1a", "session_feedback", "<from-python>"],
  ];
  for (const [tid, name, expected] of cases) {
    it(`(${tid}, ${name}) → ${expected}`, () => {
      expect(computeScoreId(tid, name)).toBe(expected);
    });
  }

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
```

### 6.2 `tests/scoring/parse.test.ts` — argv parser

Cases as listed in §3.2 docstring (positive + negative + edge: empty, whitespace, unknown direction, mixed case, embedded whitespace in comment).

### 6.3 `tests/scoring/match.test.ts` — feedback command detector

```typescript
const cases: Array<[string, boolean]> = [
  ["/feedback up", true],
  ["/feedback down great answer", true],
  ["/journey up", true],
  ["/feedback", true], // bare command
  ["  /feedback up", true], // leading whitespace
  ["/langfuse-tracing:feedback up", true], // namespaced form
  ["/langfuse-tracing:journey down", true],
  ["/feedbackish", false], // similar prefix
  ["/feedback-something", false],
  ["I want to give /feedback up", false], // not at start
  ["", false],
  ["/help", false],
  ["/Feedback up", false], // case-sensitive on cmd name
];
```

### 6.4 Integration: `tests/commands/feedback.integration.test.ts`

Strategy: in-process invocation of the CLI's `main()` with:

- A fake `Langfuse` mock (capture `score()` calls).
- A temp state file pre-populated with `_active_by_cwd[cwd] = "S1"` and `state.S1.last_substantive_trace_id = "T1"`.
- `process.cwd()` and `process.argv` patched.

Cases:

1. `argv = "up"` → score posted with `id=<computed>, name=turn_feedback, traceId=T1, value=+1, comment=undefined`. Stdout matches happy-path string.
2. `argv = "down user clicked wrong button"` → score posted with `value=-1, comment="user clicked wrong button"`.
3. `argv = "down"` then `argv = "up"` (sequential calls) → both invocations use the SAME score ID. (Verifies idempotency at the call-site level — Langfuse upsert behaviour itself is its concern, not ours to test here.)
4. State has no `_active_by_cwd[cwd]` → no score posted; stdout matches "no traced session" string.
5. `_active_by_cwd[cwd] = "S1"` exists but `state.S1.last_substantive_trace_id` is undefined → no score posted; stdout matches "no completed turn yet" string.
6. `argv = "maybe"` → no score posted; stdout matches usage hint string.
7. `TRACE_TO_LANGFUSE` unset → no score posted; no stdout.
8. Langfuse `score()` throws → graceful "delayed sync" stdout; exit 0.

### 6.5 Integration: `tests/commands/journey.integration.test.ts`

Same case matrix as §6.4 with `name=session_feedback`, score body uses `sessionId` not `traceId`, computed ID uses `target.sessionId`. Even though `/journey` only writes `sessionId`, the lookup gate STILL requires `last_substantive_trace_id` to be present (ADR-007).

### 6.6 `tests/hooks/user-prompt-submit.feedback-filter.test.ts`

Mock the langfuse client and assert:

1. Prompt `"Hello, claude"` → `langfuse.trace()` called once; state has new `current_trace_id`; `_active_by_cwd[realpath(cwd)] = sessionId`.
2. Prompt `"/feedback up"` → `langfuse.trace()` NOT called; `current_trace_id` NOT set; `_active_by_cwd` IS still updated.
3. Prompt `"/journey down"` → same as #2.
4. Subagent invocation (`agent_id` set) → early-exit; `_active_by_cwd` NOT updated.

### 6.7 `tests/hooks/stop.no-trace.test.ts`

Pre-populate state with `current_trace_id = undefined` (simulating a feedback turn). Run Stop with a transcript containing one user turn. Assert:

1. No `langfuse.trace()` or `langfuse.generation()` calls.
2. `last_line` advances past the new content.
3. `last_substantive_trace_id` is unchanged (was undefined; remains undefined).
4. Exit code 0.

---

## 7. Build & Wiring Checklist (for code phase)

- [ ] `package.json` — no new deps. (Confirm before adding `uuid` or anything else.)
- [ ] `tsconfig.json` — verify `src/commands/` and `src/scoring/` are in the include glob (currently `"src/**/*.ts"` per existing config — should be fine).
- [ ] `esbuild.config.mjs` — `outbase: "dist"` added; new command entry points added; chmod paths updated.
- [ ] `hooks/hooks.json` — all 9 command strings updated to `bundle/hooks/<name>.js` (per §3.12 table).
- [ ] `git rm` of the 9 stale flat-layout bundles (per §3.12 cleanup snippet); `pnpm build` regenerates them under `bundle/hooks/`.
- [ ] `commands/feedback.md` and `commands/journey.md` exist at repo root (Claude Code's plugin loader auto-discovers `commands/` per the docs).
- [ ] `bundle/hooks/*.js` (9 files) and `bundle/commands/*.js` (2 files) are committed to git after `pnpm build` (per project convention — `bundle/` is tracked).
- [ ] `README.md` — add a "Migration from v0.1.x" section (per §9), a usage section for the new commands, and a brief note about Q-OPEN-6 (plugin namespace verbose form).
- [ ] `package.json` version bump from `0.1.0` to `0.2.0` (per §9 reasoning — bundle restructure + new feature warrants a minor bump under semver-pre-1.0 conventions).
- [ ] Run `pnpm lint`, `pnpm format`, `pnpm test` before pushing.

---

## 8. Traceability Matrix

| Intent                                         | HLD §              | ADR              | EIS §                       | Test                          |
| ---------------------------------------------- | ------------------ | ---------------- | --------------------------- | ----------------------------- |
| FR-1 (slash commands, positional arg)          | §3, §3.2           | ADR-001          | §3.5–3.7, §3.2              | §6.4, §6.5                    |
| FR-2 (NUMERIC ±1, two distinct names)          | §4.1, §4.3         | —                | §3.5 step 6, §3.6           | §6.4 case 1/2, §6.5           |
| FR-3 (target last completed turn / session ID) | §4.1c, §4.3, §6 #3 | ADR-003, ADR-008 | §3.4, §3.10, §3.11          | §6.4 case 5, §6.7             |
| FR-4 (lookup via `_active_by_cwd`)             | §3.2, §4.1c        | ADR-006          | §2.1, §2.4, §3.4, §3.8(a)   | §6.4 case 4, §6.6             |
| FR-5 (optional comment)                        | §4.1b/e            | —                | §3.2, §3.5 step 6           | §6.4 case 2                   |
| FR-6 (idempotent upsert via deterministic ID)  | §4.2, §6 #4/5      | ADR-004, ADR-005 | §3.1                        | §6.1 (full parity)            |
| NFC-1 (kill switch parity)                     | §4.1a, §4.4        | —                | §3.5 step 1                 | §6.4 case 7                   |
| NFC-2 (never block, never noisy)               | §4.4               | —                | §3.5 step 9, §5             | All §6.4–6.5                  |
| NFC-3 (atomicUpdateState)                      | §3.2, §4.1c, §6 #6 | ADR-006          | §2.4, §3.4                  | (covered by integration)      |
| NFC-4 (build pipeline parity)                  | §3.3               | —                | §3.12                       | (manual: pnpm build)          |
| NFC-5 (no new top-level deps)                  | §3.3, §5 row 4     | ADR-005          | §3.1 (uses node:crypto), §7 | (manual: package.json review) |
| NFC-6 (≤2s latency, flushAsync)                | §4.1f, §8 row 5    | —                | §3.5 step 7                 | §6.4 (mock flush slow)        |
| Trace-stream cleanliness                       | §6 #2              | ADR-002          | §3.3, §3.8(b), §3.9(a)      | §6.6, §6.7                    |
| B-5 (scorability requires ≥1 turn)             | §4.4 row 5, §6 #7  | ADR-007          | §3.4, §3.5 step 3, §3.6     | §6.4 case 5, §6.5             |

---

## 9. User Migration (v0.1.x → v0.2.0)

This release introduces two user-visible changes:

1. **New feature** — two new slash commands (`/feedback`, `/journey`) for thumbs-up/down on turns and sessions.
2. **Bundle restructure** — every `bundle/<name>.js` for hooks now lives at `bundle/hooks/<name>.js`. New `bundle/commands/<name>.js` paths exist for the slash commands.

The restructure is the only thing that _might_ require user action. The feature is purely additive.

### 9.1 Impact by install method

| How user installed the plugin                                                                      | What happens on update                                                                                                                                                                                                              | User action required                                                                             |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **A. Via Claude Code marketplace** (`/plugin install langfuse-tracing` or equivalent)              | Plugin manager pulls the new commit atomically: `hooks/hooks.json` and `bundle/hooks/*.js` and `bundle/commands/*.js` all arrive in sync.                                                                                           | **None.** Restart Claude Code to pick up new hook paths.                                         |
| **B. Manual `git clone` + Claude Code pointed at the local checkout**                              | `git pull origin main` deletes the 9 stale flat-layout bundles and adds the new `bundle/hooks/` + `bundle/commands/` files. `hooks/hooks.json` updates in the same pull.                                                            | **`git pull` only.** Restart Claude Code.                                                        |
| **C. Manually pinned to a fork or older commit, then cherry-picking**                              | If they cherry-pick only the new feature commits without the bundle-restructure commit, hook paths in `hooks/hooks.json` will not match bundle file locations → hooks will silently fail with `MODULE_NOT_FOUND` in their hook log. | Either pull the full release, or reproduce the §3.12 path changes in their fork.                 |
| **D. Using the legacy Python `langfuse_hook.py` (pre-plugin)**                                     | Unaffected by this release; the Python hook is independent.                                                                                                                                                                         | None — but consider migrating to the plugin per the README's existing migration section.         |
| **E. Custom user `~/.claude/settings.json` with explicit hook paths bypassing `hooks/hooks.json`** | The user has hardcoded paths like `node /path/to/bundle/stop.js` in their own settings. Those paths now break.                                                                                                                      | **Update each path** from `bundle/<name>.js` to `bundle/hooks/<name>.js` per the table in §3.12. |

The vast majority of users (cases A and B) experience zero friction beyond a Claude Code restart.

### 9.2 State file: backward compatible — no migration

The `~/.claude/state/langfuse_state.json` schema gains two optional fields (`_active_by_cwd` at the top level, `last_substantive_trace_id` per session). Both are optional and absent in old state files. The plugin reads them as `undefined` until first written, which produces the correct "no traced session" / "no completed turn yet" friendly-reject behaviour for `/feedback` and `/journey` until the next non-feedback turn finishes.

**No state file deletion or rewriting is required.** Active sessions continue to be traced uninterrupted across the upgrade.

### 9.3 README migration note (verbatim text to include)

A new section to add to `README.md` under a top-level "Migration" or "Changelog" heading:

```markdown
## Migrating from v0.1.x to v0.2.0

**What's new:** Two slash commands — `/feedback up|down [comment]` and
`/journey up|down [comment]` — write idempotent ±1 scores to Langfuse
attached to the current turn or session.

**Breaking change:** Hook bundle paths moved from `bundle/<name>.js` to
`bundle/hooks/<name>.js` so the new `bundle/commands/<name>.js` files
have a clean home. The plugin's own `hooks/hooks.json` is updated in
lockstep, so:

- If you installed via the Claude Code marketplace or a `git pull`,
  no action is needed beyond restarting Claude Code.
- If your personal `~/.claude/settings.json` hardcodes hook paths
  (most users do not), update each `bundle/<name>.js` reference to
  `bundle/hooks/<name>.js`.

State files (`~/.claude/state/langfuse_state.json`) carry over without
modification. Two new optional fields are added on demand; the next
turn after upgrade populates them automatically.
```

### 9.4 Verification steps for the maintainer post-merge

After the migration commit lands and `bundle/` is regenerated:

1. **No stale flat-layout files committed.** Run `ls bundle/*.js` — should be empty (only `bundle/hooks/` and `bundle/commands/` should exist).
2. **`hooks/hooks.json` paths match actual bundle paths.** Run for each:
   ```bash
   jq -r '.. | .command? // empty' hooks/hooks.json | while read cmd; do
     path=$(echo "$cmd" | sed 's|.*"\${CLAUDE_PLUGIN_ROOT}/||; s|".*||')
     test -f "$path" && echo "OK: $path" || echo "MISSING: $path"
   done
   ```
3. **End-to-end smoke test in a scratch Claude Code session.** Set `TRACE_TO_LANGFUSE=true`, complete one turn, run `/feedback up`, verify the score appears in the Langfuse UI on the latest trace.

### 9.5 Versioning

Bump `package.json` from `0.1.0` to `0.2.0`. Pre-1.0 semver is informal; the bundle-path restructure is conceptually breaking but the user-visible impact is near zero (cases A and B), so a minor bump (not a major) is appropriate.
