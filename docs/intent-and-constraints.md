# Intent and Constraints — User Feedback Capture

## 1. Problem Statement

The plugin already streams full-fidelity Claude Code session traces to Langfuse (`Trace → Generation → Tool span` per turn, with subagent and compaction sub-trees). What the traces currently lack is **the user's qualitative judgement** about what they observed:

- Was a particular _turn_ (Claude's response to one user prompt) helpful, harmful, or off-target?
- Was an entire _session_ (a multi-turn journey toward a goal) ultimately successful?

Without this signal, downstream analytics can describe _what happened_ but not _whether it was good_. We need a frictionless, in-CLI mechanism for the user to express thumbs-up / thumbs-down feedback at two scopes (turn and journey), captured into Langfuse as scores attached to the correct entity.

## 2. Goals

1. Let the user attach approval/disapproval to the **most recent completed turn** without leaving the Claude Code CLI.
2. Let the user attach approval/disapproval to the **entire current session** (their journey), again without leaving the CLI.
3. Make the resulting signal queryable and chartable in Langfuse such that:
   - Turn-level approval rate and net sentiment trend over time.
   - Session-level success rate is a **separate** metric from turn quality (a session can have shaky steps but still succeed, or perfect steps but miss the goal).
4. Keep the feature opt-in and silent by default — never block, never prompt, never error visibly to the user.

## 3. Functional Requirements

### FR-1 — Two slash commands, positional arg

- `/feedback up` and `/feedback down` — emit a turn-scope score for the most recent completed turn in the current session.
- `/journey up` and `/journey down` — emit a session-scope score for the current session.
- The argument is a positional `up`/`down` token. Invalid or missing arg results in a friendly usage hint, not an error trace.

### FR-2 — Score schema

| Score Name         | Attached Entity               | Data Type | Value     | Semantics       |
| ------------------ | ----------------------------- | --------- | --------- | --------------- |
| `turn_feedback`    | Trace (latest completed turn) | NUMERIC   | `+1`/`-1` | step quality    |
| `session_feedback` | Session (current session)     | NUMERIC   | `+1`/`-1` | journey success |

- **Numeric, not boolean or categorical** — so Langfuse charts mean/sum natively.
- **`+1` / `-1`, not `1` / `0`** — so the absence of a score is implicitly neutral (zero-contribution to net-sentiment aggregations across all turns/sessions, including unscored ones).
- Score `name` is the same string per scope across the entire deployment (one `turn_feedback` series, one `session_feedback` series), enabling clean aggregation.

### FR-3 — Targeting the right entity

- `/feedback` must target the **most recent completed turn's trace ID** in the current session. If a turn is currently in flight (Stop hasn't fired), it must target the previous completed turn.
- `/journey` must target the **current session's session ID** (the same value used in trace `sessionId` fields by the existing tracing hooks).
- If no active session is found for the current working directory, both commands must emit a friendly "no traced session found" message and exit zero.

### FR-4 — Session lookup mechanism

Slash commands run as new processes outside the Claude Code session, so they do not inherit the session ID. They must look it up via:

- A new `_active_by_cwd: { [absoluteCwd]: sessionId }` top-level map in the existing `~/.claude/state/langfuse_state.json`.
- Maintained by the existing tracing hooks: `UserPromptSubmit` writes the entry; `SessionEnd` removes it.
- Read by the slash command implementations under the same `atomicUpdateState` lock convention.

### FR-5 — Optional comment

- Any text after the `up`/`down` token is captured as the score's `comment` field.
- Example: `/feedback down tool result was truncated mid-output`.
- Quoting is not required; everything after the first whitespace following `up`/`down` is the comment.

### FR-6 — Idempotent scoring (upsert via deterministic ID)

- Each score is written with a **deterministic, idempotent score ID** derived from the score name and the target entity ID. Repeated invocations on the same target _upsert_ the existing row rather than appending a new one.
- ID derivation: **SHA-256 of `"${target_id}:${score_name}"`, take the first 16 bytes, format as a UUID string** (8-4-4-4-12 hex). Matches the existing scorer convention in `context-gateway/src/core/observability/session_scoring.py::_deterministic_score_id`, which means an offline scorer in either codebase can compute the same ID and upsert the same row for free.
  - Turn-level: `sha256_uuid(traceId, "turn_feedback")`
  - Session-level: `sha256_uuid(sessionId, "session_feedback")`
  - Implementation lives in `src/scoring/id.ts` (~10 lines using `node:crypto`'s `createHash('sha256')`).
- Consequence — **last-write-wins semantics**:
  - User mistakenly runs `/feedback down` then immediately `/feedback up` → the row flips to `+1` (no orphaned `-1`).
  - The `comment` field also overwrites; latest comment is the truth.
  - At any moment, there is at most one `turn_feedback` row per trace and one `session_feedback` row per session.
- Consequence — **offline scorers can target the same rows.** A batch evaluator that reads transcripts and computes the same UUIDv5 will overwrite or be overwritten by manual feedback. (Future feature: if the team wants offline-scorer signal to coexist _separately_ from manual feedback rather than competing for the same row, they can use a distinct score name like `turn_feedback_auto` — same ID scheme, different namespace key. Out of scope for v1.)
- Analytics impact (vs. an append-only design):
  - Mean across rows is still the approval rate, now strictly one row per scored target.
  - Sum is net sentiment with no double-counting from repeat clicks.
  - We lose "engagement-weighted enthusiasm" (a turn the user thumbed-up three times no longer scores higher than one they thumbed-up once) — accepted as the price of correctability and offline-scorer support.

## 4. Non-Functional Constraints

### NFC-1 — Kill switch parity with existing hooks

- Both commands must early-exit silently when `TRACE_TO_LANGFUSE !== "true"` or when Langfuse credentials are missing — same behaviour as every existing hook in [src/utils/hook-init.ts](../src/utils/hook-init.ts).

### NFC-2 — Never block or fail noisily

- All errors (lookup miss, network failure, malformed state file) must be logged to `~/.claude/state/langfuse_hook.log` (gated by `CC_LANGFUSE_DEBUG`) and exit zero. No stack traces in the user's terminal.

### NFC-3 — State file concurrency

- All reads/writes to `langfuse_state.json` from the slash command implementations must go through the existing `atomicUpdateState` API in [src/state.ts](../src/state.ts). The new `_active_by_cwd` map must not race against concurrent hook writes.

### NFC-4 — Build pipeline parity

- Slash commands ship as bundled JS under `bundle/commands/<name>.js`, registered in `.claude-plugin/plugin.json` via the standard plugin commands convention. Source lives under `src/commands/<name>.ts` and is added to `esbuild.config.mjs` `entryPoints`.

### NFC-5 — No new top-level dependencies

- Use the already-installed `langfuse` (3.38.x) SDK. The `score()` method has been verified (via static analysis of `langfuse-core` 3.38.20 `.d.ts` line 1722 and the server schema in `packages/shared/src/features/scores/interfaces/shared.ts` line 14) to support both `traceId` and `sessionId` attachment in a single call.

### NFC-6 — Latency

- A slash command invocation must complete in under 2 seconds end-to-end on a warm network. The Langfuse client should `flushAsync()` (not block waiting for `flush()`) where possible; if the user's terminal is going to wait on us anyway, we should still cap the wait.

## 5. Boundaries and Limitations

### B-1 — Out of scope: free-text reviews

- This feature does **not** introduce a long-form review mechanism. The `comment` field is a one-liner only. A separate richer-feedback workflow can be designed later if needed.

### B-2 — Out of scope: per-tool-call feedback

- Feedback resolution is turn or session, not individual tool spans within a turn. Scoring an individual tool call is not in scope for v1.

### B-3 — Out of scope: backfill

- Existing untraced or pre-feature sessions cannot be retroactively scored. Feedback only applies to sessions already being traced by this plugin.

### B-4 — Out of scope: UI confirmation

- The slash commands do not pop up an `AskUserQuestion`-style confirmation. The whole point is one keystroke. Misclicks are addressed by NFC-2 (no visible failure) plus FR-6 (just run the opposite command).

### B-5 — Coupling to the existing tracing path

- The feature only works when tracing is enabled and the session has at least one completed turn. Without a trace, there is nothing to attach a score to.

### B-6 — Single-machine assumption

- The lookup mechanism assumes the slash command and the traced session run on the same machine, sharing `~/.claude/state/langfuse_state.json`. Remote / SSH cases inherit whatever the underlying Claude Code CLI does about home directory.

## 6. Success Criteria

A reviewer should be able to:

1. Open a Claude Code session with `TRACE_TO_LANGFUSE=true`, complete a turn, run `/feedback up`, and within seconds see a `turn_feedback=1` score on the latest trace in the Langfuse UI.
2. Run `/journey down low signal-to-noise this session`, end the session, and see a `session_feedback=-1` score with that comment attached to the session in the Langfuse UI.
3. Verify that running `/feedback up` outside a traced session prints a friendly message and exits zero, with a debug entry in the log file but no terminal noise.
4. Confirm that running both commands many times across many sessions produces a `turn_feedback` time series (mean = approval rate over scored turns, sum = net sentiment) and a separate `session_feedback` time series, queryable in the Langfuse dashboard. Each scored turn/session contributes exactly one row to its respective series; corrections (running `up` then `down` on the same turn) leave a single up-to-date row.
