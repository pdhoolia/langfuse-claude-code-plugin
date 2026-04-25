# High-Level Design: User Feedback Capture

**Version:** 1.1
**Date:** 2026-04-25
**Status:** Revised — incorporates ADR-001 through ADR-008

## 1. Overview

Two new slash commands (`/feedback up|down [comment]` and `/journey up|down [comment]`) let the user attach idempotent ±1 scores to either the most recent completed turn or the entire current session. Scores are written directly to Langfuse via the existing SDK, with deterministic SHA-256-derived score IDs (formatted as UUIDs, matching the convention in `context-gateway/.../session_scoring.py`) that allow corrections — and future offline scorers in either codebase — to upsert the same row (ADR-004).

## 2. Goals and Non-Goals

### Goals

- Frictionless in-CLI thumbs feedback at two scopes (turn, journey).
- Idempotent score IDs so corrections and offline scorers safely overwrite.
- Zero pollution of the existing trace stream — feedback commands must not appear as their own Langfuse traces.
- Reuse the existing state file, lock semantics, kill switch, and credential resolution.

### Non-Goals

- Per-tool-span scoring (B-2).
- Free-text reviews beyond a one-line `comment` (B-1).
- Backfilling pre-feature sessions (B-3).
- Confirmation prompts before recording (B-4).
- Differentiating manual vs. offline-scorer rows in v1 (deferred — offline scorers can use a distinct score name later).

## 3. System Architecture

### 3.1 Component Diagram

```
                      ┌──────────────────────────────────┐
                      │     Claude Code CLI (user)       │
                      └──────┬───────────────────────────┘
                             │ types `/feedback up great`
                             ▼
                      ┌──────────────────────────────────┐
                      │ commands/feedback.md             │  (NEW)
                      │   ─ disable-model-invocation     │
                      │   ─ allowed-tools: Bash(node:*)  │
                      │   ─ body: !`node bundle/...`     │
                      └──────┬───────────────────────────┘
                             │ shell injection
                             ▼
              ┌──────────────────────────────────────────────┐
              │  bundle/commands/feedback.js (NEW CLI)       │
              │   1. Parse argv: up|down + optional comment  │
              │   2. Read state via atomicUpdateState        │
              │   3. Resolve target trace ID (last completed)│
              │   4. Compute UUIDv5(name + ":" + targetId)   │
              │   5. langfuse.score({...})                   │
              │   6. flushAsync() with timeout               │
              │   7. console.log("✓ ...") and exit 0         │
              └──────┬─────────────────┬─────────────────────┘
                     │                 │
                     ▼                 ▼
        ┌────────────────────┐  ┌──────────────────────┐
        │ langfuse_state.json│  │   Langfuse server    │
        │  ─ _active_by_cwd  │  │   POST /scores       │
        │  ─ sessions[sid]   │  │                      │
        │     • last_substan │  │                      │
        │       tive_trace_id│  │                      │
        └────────────────────┘  └──────────────────────┘
                ▲
                │ writes
                │
   ┌─────────────────────────────────────────────────────┐
   │  Existing hooks (MODIFIED)                          │
   │   ─ user-prompt-submit.ts                           │
   │       • populate _active_by_cwd[cwd] = sessionId    │
   │       • detect feedback prompt → skip trace alloc   │
   │   ─ stop.ts                                         │
   │       • after emitTurn, set last_substantive_trace  │
   │         (only if turn was a real user turn)         │
   │       • gracefully no-op when no current_trace_id   │
   │   ─ session-end.ts                                  │
   │       • prune _active_by_cwd[cwd] for this session  │
   └─────────────────────────────────────────────────────┘
```

The journey command (`commands/journey.md` → `bundle/commands/journey.js`) follows the identical shape; only the score name and target field (`sessionId` instead of `traceId`) differ.

### 3.2 Component Descriptions

| Component                                    | Responsibility                                                                                                        | Key Interfaces                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `commands/feedback.md`                       | Slash-command surface; declares args, restricts tools, runs the bundled CLI via shell injection.                      | Reads `$ARGUMENTS`; spawns `node ${CLAUDE_PLUGIN_ROOT}/bundle/commands/feedback.js`.                   |
| `commands/journey.md`                        | Same as above, scoped to session.                                                                                     | Same.                                                                                                  |
| `src/commands/feedback.ts`                   | Turn-feedback CLI: parse argv, resolve last-substantive trace, compute idempotent ID, call `langfuse.score()`.        | Reads state via `atomicUpdateState`; uses `langfuse.score({id, name, traceId, value, comment})`.       |
| `src/commands/journey.ts`                    | Session-feedback CLI: same shape, attaches to `sessionId`.                                                            | Same; uses `sessionId` instead of `traceId`.                                                           |
| `src/scoring/id.ts`                          | Deterministic ID generator: SHA-256 of `${targetId}:${name}`, first 16 bytes formatted as UUID string. Pure function. | `computeScoreId(targetId: string, name: string): string`. Matches `context-gateway` scorer convention. |
| `src/scoring/parse.ts`                       | Shared CLI argv parser: extracts `direction ∈ {up,down}` and trailing `comment`.                                      | `parseArgs(argv: string[]): {direction, comment, error?}`.                                             |
| `src/state.ts` (extended)                    | Adds `_active_by_cwd: Record<string,string>` to root state schema and `last_substantive_trace_id` to per-session.     | Same `atomicUpdateState` API.                                                                          |
| `src/hooks/user-prompt-submit.ts` (modified) | Writes `_active_by_cwd[cwd] = sessionId` on every invocation; skips trace allocation when prompt is a feedback cmd.   | New shared helper `isFeedbackCommand(prompt)`.                                                         |
| `src/hooks/stop.ts` (modified)               | After emitting a non-feedback turn, copies `current_trace_id` into `last_substantive_trace_id`. No-op for missing.    | Same emission pipeline.                                                                                |
| `src/hooks/session-end.ts` (modified)        | Removes `_active_by_cwd[cwd]` if it points to this session.                                                           | Same as today, plus state prune.                                                                       |

### 3.3 Build & Distribution

- `src/commands/*.ts` are added as new entry points in `esbuild.config.mjs`, producing `bundle/commands/feedback.js` and `bundle/commands/journey.js` (mode 755).
- `commands/feedback.md` and `commands/journey.md` are new top-level files (mirroring the existing `hooks/` directory). Auto-discovered by Claude Code's plugin loader without further wiring.
- No new npm dependencies. UUIDv5 is implemented in ~25 lines of `src/scoring/id.ts` using `node:crypto` (SHA-1 over namespace bytes + name bytes per RFC 4122 §4.3).

## 4. Data Flow

### 4.1 Happy path: `/feedback up great answer`

```
1. User types "/feedback up great answer" in Claude Code.
2. UserPromptSubmit hook fires (existing flow).
   ─ input.prompt starts with "/feedback " → isFeedbackCommand() returns true.
   ─ Skip langfuse.trace() call; do NOT set current_trace_id.
   ─ Still write _active_by_cwd[cwd] = sessionId (idempotent).
   ─ Exit 0.
3. Claude Code resolves commands/feedback.md.
   ─ Bash injection runs: `node bundle/commands/feedback.js "up great answer"`.
4. feedback.js executes:
   a. initHook() (kill switch + creds — same helper as hooks).
      ─ If TRACE_TO_LANGFUSE != "true" or creds missing → console.log nothing, exit 0.
   b. parseArgs(argv) → {direction: "up", comment: "great answer"}.
      ─ Invalid → print friendly hint to stdout, exit 0.
   c. atomicUpdateState read-only:
      ─ sessionId = state._active_by_cwd[process.cwd()].
      ─ traceId = state.sessions[sessionId].last_substantive_trace_id.
      ─ If either missing → "no traced turn yet, nothing to score" → exit 0.
   d. scoreId = computeScoreId(traceId, "turn_feedback")  // sha256-derived, UUID-formatted
   e. langfuse.score({id: scoreId, name: "turn_feedback", traceId, value: +1, comment: "great answer"}).
   f. await flushAsync() with 2s timeout (Promise.race against setTimeout).
   g. console.log("✓ turn_feedback +1 recorded for trace " + traceId.slice(0,8) + "…").
   h. exit 0.
5. Claude Code receives the bash output as the rendered prompt and presents it to Claude.
   ─ Because UserPromptSubmit skipped trace allocation, Stop will produce no Langfuse trace for this turn.
   ─ Claude responds briefly (single short reply, e.g. "Done."). No score is emitted for this turn (no current_trace_id).
6. Stop hook fires:
   ─ current_trace_id is undefined → emission pipeline no-ops for this turn.
   ─ last_line still advances past the feedback turn (otherwise next turn would re-process it).
```

### 4.2 Correction flow: `/feedback down` then immediately `/feedback up`

```
First invocation: writes score row with id=computeScoreId(T, "turn_feedback"), value=-1.
Second invocation: same id (deterministic), value=+1 → Langfuse upserts.
Final state in Langfuse: one turn_feedback row, value=+1, comment from second call.
```

### 4.3 Journey scoring at session end

```
User types "/journey up wrapped up cleanly" mid-session or just before exit.
Same pipeline; targetId = sessionId; scoreId = computeScoreId(sessionId, "session_feedback").
Langfuse score posts with sessionId attachment (verified: SDK ScoreBody.sessionId, server PostScoreBodyFoundationSchema).
```

### 4.4 Failure modes (all silent to user, logged to debug log)

| Failure                                                                                                                | User-visible                                                                                                                | Debug log         | Exit |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---- |
| `TRACE_TO_LANGFUSE != "true"`                                                                                          | Nothing                                                                                                                     | "kill switch off" | 0    |
| Credentials missing                                                                                                    | Nothing                                                                                                                     | "no credentials"  | 0    |
| Invalid argv (missing/unknown direction)                                                                               | Usage hint                                                                                                                  | "bad args: …"     | 0    |
| `_active_by_cwd[cwd]` missing                                                                                          | "no traced session found"                                                                                                   | warn              | 0    |
| `last_substantive_trace_id` missing — applies to **both** commands (no completed substantive turn in this session yet) | `/feedback`: "no completed turn yet to score" — `/journey`: "no conversation yet to score; come back after Claude responds" | warn              | 0    |
| `langfuse.score()` throws                                                                                              | "feedback recorded locally; sync may be delayed"                                                                            | full stack        | 0    |
| `flushAsync` times out (>2s)                                                                                           | Same as above                                                                                                               | "flush timeout"   | 0    |

## 5. Technology Choices

| Layer                 | Choice                                                                      | Rationale                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash command surface | Markdown frontmatter with `!`bash`` injection                               | Native plugin loader; `disable-model-invocation: true` keeps it manual-only; `allowed-tools` scopes Bash to `node:*`.                                                                                                                                                           |
| CLI runtime           | Node + bundled ESM (matches existing hooks)                                 | Same `tsc → esbuild → bundle/` pipeline; no new build steps; consumers already trust `bundle/`.                                                                                                                                                                                 |
| Langfuse client       | Existing `langfuse` 3.38.x                                                  | Already a dep; `score()` API supports both `traceId` and `sessionId` (verified in Intent doc NFC-5).                                                                                                                                                                            |
| Score ID derivation   | SHA-256 over `${targetId}:${name}`, first 16 bytes formatted as UUID string | Matches the existing scorer convention in `context-gateway/.../session_scoring.py`. Cross-codebase compatibility for free if/when an offline scorer also writes Claude Code scores. SHA-256 (not SHA-1 as in UUIDv5) is the current standard. ~10 lines, no namespace constant. |
| State storage         | Existing `langfuse_state.json` with new top-level + per-session keys        | Single lock, single prune cycle, no new file to coordinate. Schema additions are backward-compatible (optional fields).                                                                                                                                                         |
| Concurrency           | Existing `atomicUpdateState`                                                | Already handles file-lock + 5s timeout + stale-lock cleanup.                                                                                                                                                                                                                    |
| Confirmation output   | One-line ASCII prefix `✓` (Unicode, not emoji)                              | Visible without a custom font; matches existing logger style; project convention is "no emoji unless requested" (CLAUDE.md).                                                                                                                                                    |

## 6. Key Design Decisions

Each decision is documented in full in [`adr-lite.md`](adr-lite.md). Summary:

1. **Slash commands as the trigger mechanism** ([ADR-001](adr-lite.md#adr-001)). The only Claude-Code-native way to invoke action on demand from within the CLI; hooks are for lifecycle events.
2. **Filter feedback turns out of the trace pipeline** ([ADR-002](adr-lite.md#adr-002)). Skip trace allocation in `UserPromptSubmit` when the prompt is a feedback command; gracefully no-op in `Stop` when no `current_trace_id`. Prevents both noise traces _and_ the targeting bug where `last_substantive_trace_id` would drift to the feedback turn.
3. **New `last_substantive_trace_id` field, distinct from `current_trace_id`** ([ADR-003](adr-lite.md#adr-003)). Stable handle to the most recent _completed_ substantive turn; `current_trace_id` represents the in-flight turn. The same field doubles as the gate condition for both commands (ADR-007).
4. **SHA-256-derived UUID-formatted score IDs** ([ADR-004](adr-lite.md#adr-004)). Matches the existing `context-gateway` scorer convention byte-for-byte, giving offline scorers in either codebase free upsert compatibility. SHA-256 is the current standard hash; no namespace constant to maintain.
5. **Self-implemented inline (~10 lines, no `uuid` npm package)** ([ADR-005](adr-lite.md#adr-005)). Zero new dependency; cross-validated against the Python reference via parity tests.
6. **One state file with new keys, not a separate lookup file** ([ADR-006](adr-lite.md#adr-006)). Reuses the existing lock, prune cycle, and config knob. New keys (`_active_by_cwd`, per-session `last_substantive_trace_id`) are backward-compatible.
7. **Unified scorability gate for both commands** ([ADR-007](adr-lite.md#adr-007)). Both `/feedback` and `/journey` require `last_substantive_trace_id` to be set; absent → friendly command-specific message and exit 0. Symmetric UX, no empty-session noise in dashboards.
8. **Score interrupted (Esc) turns the same as completed turns** ([ADR-008](adr-lite.md#adr-008)). When `closeInterruptedTurn` finalizes a trace, also write its ID into `last_substantive_trace_id`. Enables the natural Esc-then-`/feedback down` flow.

## 7. Open Questions

### Resolved during ADR-Lite review

| Q                                                                                                 | Resolution                                                                                                 | ADR                            |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Q-OPEN-1: How is "most recent completed turn" defined when the previous turn was Esc-interrupted? | Target the interrupted turn — `closeInterruptedTurn` writes its trace ID into `last_substantive_trace_id`. | [ADR-008](adr-lite.md#adr-008) |
| Q-OPEN-2: Filter feedback turns at UserPromptSubmit vs. trace as small noise traces?              | Filter.                                                                                                    | [ADR-002](adr-lite.md#adr-002) |
| Q-OPEN-3: Behavior when `/feedback` is invoked before any turn has completed?                     | Friendly "no completed turn yet to score" + exit 0.                                                        | [ADR-007](adr-lite.md#adr-007) |
| Q-OPEN-4: Should `/journey` be allowed before any turn has completed?                             | No — same gate as `/feedback`, friendly "no conversation yet to score" + exit 0.                           | [ADR-007](adr-lite.md#adr-007) |

### Still open

- [ ] **Q-OPEN-5: Confirmation message verbosity.**
  - **Working default:** `✓ turn_feedback +1 recorded for trace abcd1234…` (one line, ID prefix shown).
  - Low-stakes; resolve during EIS phase when the actual stdout message is finalised. Alternatives include silent (no stdout) or richer multi-line output.

- [ ] **Q-OPEN-6: Slash command namespace shows as `/langfuse-tracing:feedback up` (verbose) per Claude Code's plugin namespacing convention.**
  - Defer empirical check to EIS phase: install the built plugin in a scratch project and verify how `/help` and Tab-completion render the commands. Three mitigation options on the table: (1) accept the verbose form, (2) rename the plugin (user-hostile to existing installs — last resort), (3) document a personal-alias pattern in the README.
  - Non-blocking for implementation — the architecture is identical regardless of the chosen invocation string.

## 8. Risks and Mitigations

| Risk                                                                                                          | Impact | Mitigation                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop hook chokes when `current_trace_id` is undefined (because UserPromptSubmit skipped it for feedback turn) | H      | Audit Stop hook in EIS phase. Add explicit early-return branch with `last_line` advancement; cover by validation test (Phase 7).                                                              |
| Self-implemented SHA-256 ID has bug → IDs not stable across runs → upsert breaks                              | H      | Cross-validate against the Python reference (`context-gateway/.../session_scoring.py::_deterministic_score_id`) in unit tests — feed the same inputs, assert identical UUID-formatted output. |
| `cwd` from hook input doesn't match `process.cwd()` in slash command CLI (e.g., due to symlinks)              | M      | Normalize via `fs.realpathSync()` on both write side (hook) and read side (CLI). Document the convention in `_active_by_cwd` JSDoc.                                                           |
| Multiple Claude Code sessions in the same cwd race for `_active_by_cwd[cwd]`                                  | M      | Last-write-wins is acceptable; latest session "owns" the cwd. Document in HLD; revisit if users complain.                                                                                     |
| `flushAsync` doesn't actually flush before process.exit                                                       | M      | Explicit `await Promise.race([flushPromise, timeout(2000)])`. Worst case: score is queued but not flushed; Langfuse SDK has its own retry on next init.                                       |
| Feedback turn somehow does still get a trace ID (e.g., bug in filter), then becomes target of next /feedback  | M      | Stop hook double-checks: if turn input starts with `/feedback`/`/journey`, do not promote to `last_substantive_trace_id`.                                                                     |
| Slash command markdown body still triggers a Claude reply, costing tokens                                     | L      | Acceptable cost (1–2 lines of model output). Mitigate by keeping the bash injection's stdout terse so Claude has little to reply about.                                                       |
| Bundled CLI grows the `bundle/` directory (committed to git)                                                  | L      | Acceptable; new files are ~30KB each (matches existing hook bundles).                                                                                                                         |

## 9. Traceability

| Intent                                         | HLD Section                              | ADR                                                            |
| ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| FR-1 (two slash commands, positional arg)      | §3 component diagram, §3.2 commands rows | [ADR-001](adr-lite.md#adr-001)                                 |
| FR-2 (NUMERIC ±1, two distinct names)          | §4.1 step 4d, §4.3                       | —                                                              |
| FR-3 (target last completed turn / session ID) | §4.1 step 4c, §4.3, §6 #3                | [ADR-003](adr-lite.md#adr-003), [ADR-008](adr-lite.md#adr-008) |
| FR-4 (lookup via `_active_by_cwd`)             | §3.2, §4.1 step 4c                       | [ADR-006](adr-lite.md#adr-006)                                 |
| FR-5 (optional comment)                        | §4.1 step 4b/4e                          | —                                                              |
| FR-6 (idempotent upsert via deterministic ID)  | §4.2, §6 #4, §6 #5                       | [ADR-004](adr-lite.md#adr-004), [ADR-005](adr-lite.md#adr-005) |
| NFC-1 (kill switch parity)                     | §4.1 step 4a, §4.4                       | —                                                              |
| NFC-2 (never block, never noisy)               | §4.4 failure-mode table                  | —                                                              |
| NFC-3 (atomicUpdateState)                      | §3.2, §4.1 step 4c, §6 #6                | [ADR-006](adr-lite.md#adr-006)                                 |
| NFC-4 (build pipeline parity)                  | §3.3                                     | —                                                              |
| NFC-5 (no new top-level deps)                  | §3.3, §5 row 4                           | [ADR-005](adr-lite.md#adr-005)                                 |
| NFC-6 (≤2s latency, flushAsync)                | §4.1 step 4f, §8 row 5                   | —                                                              |
| Trace-stream cleanliness (implicit)            | §6 #2                                    | [ADR-002](adr-lite.md#adr-002)                                 |
| B-5 (only works with ≥1 completed turn)        | §4.4 failure-mode table, §6 #7           | [ADR-007](adr-lite.md#adr-007)                                 |
