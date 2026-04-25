# Architecture Decisions: User Feedback Capture

**Last Updated:** 2026-04-25

These ADRs cover the eight significant decisions surfaced during HLD review. Each entry cites the constraints from `intent-and-constraints.md` (FR-N / NFC-N / B-N) that drove it, and the HLD open question it resolves (where applicable).

---

## ADR-001: Use slash commands as the trigger mechanism

**Status:** Accepted

**Context:**
The user needs to react to a turn or session from inside the running Claude Code CLI, on demand. The plugin's existing surface area is hooks (lifecycle events) and bundled binaries. We need a mechanism that fires _when the user wants it to_ — not on a lifecycle event.

**Decision:**
Implement two new slash commands (`/feedback` and `/journey`) as the trigger surface. Each is a markdown file in `commands/` with `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`, and a body consisting of a `!`bash`` injection that runs a bundled Node CLI.

**Alternatives Considered:**

| Option                                                    | Pros                                                                                      | Cons                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Slash commands (chosen)                                   | Native plugin loader; user-triggered on demand; argument support; standard Claude Code UX | Each invocation becomes a tiny "Claude turn" (must be filtered — see ADR-002); command name is plugin-namespaced (Q-OPEN-6) |
| New hook event (if one existed)                           | Cleanest separation from conversation flow                                                | No suitable user-triggered hook event exists in Claude Code; would require Claude Code itself to add one                    |
| External CLI run from another terminal                    | Zero CLI integration; runs anywhere                                                       | Defeats FR-1 ("without leaving the Claude Code CLI"); user has to alt-tab                                                   |
| Magic string in user's normal prompt (e.g., "👍" in chat) | No new commands                                                                           | Couples feedback to LLM message parsing; brittle; pollutes the trace as a real Claude turn                                  |

**Rationale:**

- FR-1 explicitly requires in-CLI invocation with positional `up`/`down` argument. Slash commands are Claude Code's first-class mechanism for that.
- NFC-4 requires build-pipeline parity with existing hooks; bundling the CLI under `bundle/commands/` reuses the existing `tsc → esbuild → bundle/` pipeline with one new entry-point per command.
- The bash-injection pattern (rather than asking Claude to call a tool) keeps latency near network-RTT (NFC-6) — the score is emitted by the CLI itself, not by waiting for Claude to interpret a prompt and decide to act.

**Consequences:**

- (+) Reuses existing build, distribution, and credential resolution paths.
- (+) Argument parsing handled by Claude Code's `$ARGUMENTS` substitution.
- (−) Each invocation still triggers a Claude turn (Claude sees the bash output and responds briefly). Mitigated by ADR-002.
- (−) Plugin-namespaced command names are verbose by default (`/langfuse-tracing:feedback up`). Q-OPEN-6 deferred to EIS for empirical autocomplete check.

**Resolves:** Foundational — prerequisite for ADR-002 onward.

---

## ADR-002: Filter feedback turns out of the trace pipeline

**Status:** Accepted

**Context:**
A slash command invocation is, from Claude Code's perspective, a normal user turn — Claude sees the rendered prompt and replies. Without intervention, every `/feedback up` would itself become a Langfuse trace ("Claude Code - Turn N", input "✓ turn_feedback +1 recorded…"). Beyond the noise, this creates a worse problem: `last_substantive_trace_id` (ADR-003) would drift to point to the _feedback turn_ immediately after the first invocation, so a subsequent `/feedback down` would score the previous feedback turn rather than the substantive turn the user actually meant to evaluate.

**Decision:**
At `UserPromptSubmit`, detect feedback commands by prompt-prefix (`/feedback ` or `/journey ` — also matching the plugin-namespaced forms), and skip trace allocation entirely for those turns. At `Stop`, gracefully no-op when `current_trace_id` is undefined and still advance `last_line` past the feedback turn (so it isn't reprocessed).

**Alternatives Considered:**

| Option                                                                     | Pros                                                                                                    | Cons                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Filter at `UserPromptSubmit` (chosen)                                      | Zero noise traces; `last_substantive_trace_id` never drifts to a feedback turn; cleanest dashboard data | Requires Stop hook to handle "turn with no allocated trace" gracefully (one new branch)                                      |
| Trace as small "command" turn with metadata tag (`kind: feedback_command`) | No hook changes; opt-in dashboard filtering                                                             | Pollutes trace stream with meaningless ~5-token traces; needs separate `last_substantive_trace_id` logic anyway to skip them |
| Don't filter at all; accept noise                                          | Simplest                                                                                                | Breaks the targeting semantics — `/feedback` would score itself on the second invocation. Not viable                         |

**Rationale:**

- FR-3 requires targeting the most recent _substantive_ turn — feedback turns must not become valid targets.
- NFC-2 (never noisy) and the implicit "trace stream cleanliness" goal both push toward filtering.
- The Stop-hook change is small and well-isolated: a single `if (!current_trace_id) { advance_last_line(); return; }` branch.

**Consequences:**

- (+) Langfuse data stays free of meaningless feedback-action traces.
- (+) `last_substantive_trace_id` semantics stay clean by construction.
- (−) Requires a defensive change in Stop (Risk row 1 in HLD §8).
- (−) Filter logic must match all forms of the command name (bare and plugin-namespaced — `isFeedbackCommand` should normalize).

**Resolves:** HLD Q-OPEN-2.

---

## ADR-003: Introduce `last_substantive_trace_id` (distinct from `current_trace_id`)

**Status:** Accepted

**Context:**
The existing state schema has `current_trace_id` per session, set in `UserPromptSubmit` and cleared by `Stop` after emission. It represents the _in-flight_ turn, not a stable handle on the most recent completed substantive turn. `/feedback` needs the latter — by the time the user types it, `current_trace_id` is almost always undefined (Stop has already cleared it).

**Decision:**
Add a new per-session field `last_substantive_trace_id?: string` to the state schema. The Stop hook copies `current_trace_id` into `last_substantive_trace_id` _only when_ the turn was substantive (i.e., not a feedback command — guarded by ADR-002's filter, which means feedback turns never had a `current_trace_id` to copy). The field is read by both `/feedback` (target) and as the gate condition for `/journey` (presence required, see ADR-007).

**Alternatives Considered:**

| Option                                         | Pros                                                                                       | Cons                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| New `last_substantive_trace_id` field (chosen) | Clean semantics; no overload of existing field; gate logic uses presence as a single check | One new field in state schema                                                                                                  |
| Reuse `current_trace_id` (don't clear in Stop) | No schema change                                                                           | Overloads the field — "in-flight" vs "last completed" become ambiguous; breaks the meaning relied on by `closeInterruptedTurn` |
| Re-derive from transcript on demand            | No state change                                                                            | Requires transcript parse on every `/feedback` invocation; slow; adds dependency on transcript file format                     |
| Use `turn_count` to look up the Nth turn       | No new field for this purpose                                                              | Doesn't give us a trace ID directly; would need a `turn_count → trace_id` index, which is a bigger schema addition             |

**Rationale:**

- FR-3 requires the most recent completed turn's trace ID. The existing `current_trace_id` semantics are the in-flight turn — distinct concept, distinct field.
- NFC-3 (atomicUpdateState) makes adding optional fields essentially free — backward-compatible with old state files.
- Lookup latency stays bounded by file-read time (NFC-6).

**Consequences:**

- (+) Clear, single-purpose field. Easy to reason about.
- (+) Doubles as the gate for "is anything scorable yet?" (ADR-007).
- (−) Stop hook gains one new write per turn (negligible).
- (−) On state file migration from older plugin versions, the field will be absent until the next completed turn — handled by treating absence as "not yet scorable" (the same friendly-reject path).

**Resolves:** HLD §6 #3, supports HLD Q-OPEN-3, Q-OPEN-4.

---

## ADR-004: Deterministic score IDs via SHA-256, formatted as UUID

**Status:** Accepted

**Context:**
FR-6 requires that repeated invocations on the same target upsert the existing score row (correctability + offline-scorer support). Langfuse's score API uses the supplied `id` as the upsert key, so the score ID must be deterministic from `(target_entity_id, score_name)`. A reference implementation already exists in a sibling Anthropic codebase (`context-gateway/src/core/observability/session_scoring.py::_deterministic_score_id`), which uses SHA-256 over `f"{trace_id}:{score_name}"` and wraps the first 16 bytes as a `uuid.UUID(bytes=…)`. Adopting that scheme means an offline scorer in either codebase can compute the same ID and upsert the same row at no coordination cost.

**Decision:**
Compute the score ID as the first 16 bytes of `SHA-256("${target_id}:${score_name}")`, formatted as a UUID string (8-4-4-4-12 hex). For `turn_feedback`, `target_id = traceId`; for `session_feedback`, `target_id = sessionId`. The concatenation order (`target` first, `name` second) and separator (`:`) match the Python reference exactly.

**Alternatives Considered:**

| Option                                            | Pros                                                                                                                                                              | Cons                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| SHA-256-derived, UUID-formatted (chosen)          | Cross-codebase compatibility with `context-gateway` scorer; SHA-256 is current standard; ~10 lines; no namespace constant; trivially reproducible in any language | Not a "real" RFC 4122 UUID — version/variant bits are arbitrary (purely cosmetic concern; Langfuse stores IDs as opaque strings) |
| UUIDv5 with plugin-owned namespace UUID           | Strictly RFC-compliant                                                                                                                                            | ~25 lines; requires a hardcoded namespace constant; uses SHA-1 (deprecating); incompatible with the existing Python scorer's IDs |
| UUIDv5 with DNS namespace and a domain-style name | Standard namespace constant in libraries                                                                                                                          | Risks collision with anyone else picking the same DNS name; still SHA-1                                                          |
| Plain SHA-256 hex string (no UUID formatting)     | Slightly simpler                                                                                                                                                  | Inconsistent with the Python reference's output shape; Langfuse dashboard UI conventionally shows UUID-shaped IDs                |
| Random UUID per invocation (append-only)          | Simplest                                                                                                                                                          | Violates FR-6 entirely (no upsert, no correctability)                                                                            |

**Rationale:**

- FR-6 requires last-write-wins on the same `(target, name)` pair. Determinism is the only way to make that work without a server-side dedup mechanism.
- The `context-gateway` codebase already ships and uses this exact scheme. Matching it byte-for-byte means a future offline scorer for Claude Code transcripts (potentially run from `context-gateway` or anywhere else) instinctively produces overlapping IDs and can upsert the same rows manual `/feedback` writes.
- SHA-256 is cryptographically stronger than SHA-1 (which UUIDv5 mandates) and is the current preferred hash across the rest of the stack.
- "Not a real UUID per RFC 4122" is irrelevant in practice — Langfuse's score `id` field is an opaque string. The dashboard renders UUID-shaped IDs neatly; that's all we need.

**Consequences:**

- (+) Same `/feedback up` → `/feedback down` → `/feedback up` sequence leaves exactly one row, value `+1`.
- (+) Cross-codebase compatibility: an offline scorer in any language (Python, Go, etc.) can compute the same ID with `sha256` and `uuid.UUID(bytes=…)` (or equivalent).
- (+) No namespace UUID to maintain.
- (−) Loses "engagement-weighted enthusiasm" signal — explicitly accepted as the trade for correctability (Intent FR-6 consequence list).
- (−) Comment field also overwrites — accepted (matches last-write-wins on value).
- (−) The output IDs are not RFC 4122 UUIDs in the strict sense (version/variant bits are SHA-256 derived, not set per spec). Cosmetic; no consumer cares.

**Resolves:** Mechanism for FR-6.

**References:**

- Python implementation: `context-gateway/src/core/observability/session_scoring.py::_deterministic_score_id` (lines 530–537).

---

## ADR-005: Self-implement the deterministic ID (no `uuid` npm dependency)

**Status:** Accepted

**Context:**
ADR-004 needs SHA-256 of a string + UUID-string formatting. Both pieces are trivial in Node — `node:crypto.createHash('sha256')` + a few `slice`/`join` calls — so the implementation is ~10 lines. The `uuid` npm package would add ~50KB per bundle for functionality we don't need (UUIDv1/v4/v5/v6/v7 generators, parsers, validators).

**Decision:**
Implement `computeScoreId(targetId, name)` inline in `src/scoring/id.ts` using `node:crypto`. Cross-validate against the Python reference (`context-gateway/.../session_scoring.py::_deterministic_score_id`) via unit tests that pin a few known `(target, name) → id` mappings.

**Alternatives Considered:**

| Option                                                            | Pros                                                             | Cons                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Self-implement (chosen)                                           | Zero new dep; bundle stays small; ~10 lines, trivially auditable | We own correctness; mitigated by parity tests against the Python reference                   |
| `uuid` npm package                                                | Battle-tested for real UUIDs                                     | Doesn't actually help — we're not generating real UUIDs (ADR-004); adds ~50KB for no benefit |
| Hand-roll using a tiny `sha256` implementation (no `node:crypto`) | Could be portable to non-Node runtimes                           | Pointless — we run under Node and `node:crypto` is built-in                                  |

**Rationale:**

- NFC-5 (no new top-level deps).
- The implementation is so small that the reference Python (`hashlib.sha256(...) + uuid.UUID(bytes=...)`) is one-to-one with our Node version (`createHash('sha256') + format-as-uuid-string`). Cross-language parity is the strongest possible test.
- If we ever want richer UUID functionality elsewhere in the plugin, this ADR is reversible — swap to `uuid` package, no API change to callers.

**Consequences:**

- (+) Bundle size unchanged; no new dependency to track for security advisories.
- (+) Cross-codebase test (Python reference vectors → Node assertion) catches any divergence immediately.
- (−) We own correctness — mitigated by the parity test (which is a much stronger guarantee than RFC vectors would have been).

**Resolves:** Implementation choice for ADR-004.

---

## ADR-006: One state file with new keys, not a separate lookup file

**Status:** Accepted

**Context:**
The slash command CLI needs to look up `cwd → sessionId`. We could put this in a new file (`~/.claude/state/active_sessions.json`) or extend the existing `~/.claude/state/langfuse_state.json`.

**Decision:**
Add a new top-level key `_active_by_cwd: Record<string, string>` to the existing `langfuse_state.json`. The leading underscore marks it as "not a session ID" so existing code that iterates session keys can continue to ignore it.

**Alternatives Considered:**

| Option                              | Pros                                                                             | Cons                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Extend existing state file (chosen) | One lock; one prune cycle; one config knob (`stateFilePath`); one place to debug | Schema for the existing file grows by one field                                                                                           |
| Separate `active_sessions.json`     | Clean separation of concerns                                                     | Two files to coordinate; race condition between them; double the lock complexity; second config knob; second place to look when debugging |
| Use OS environment variables        | No file at all                                                                   | Doesn't survive between processes; doesn't work for slash commands (separate process)                                                     |
| Use a Unix socket / shared memory   | Lower latency                                                                    | Overkill for this volume of writes; cross-platform headaches                                                                              |

**Rationale:**

- NFC-3 (atomicUpdateState) already exists for this file. Extending it requires no new locking logic.
- The single-file architecture is documented in `CLAUDE.md`; adding a second state file would fork that pattern.
- Existing iteration code (e.g., session pruning) walks `Object.entries(state)` filtered by session-ID shape; the leading underscore on `_active_by_cwd` keeps it a non-session entry.

**Consequences:**

- (+) Reuses all existing concurrency, persistence, and pruning machinery.
- (+) A single `cat ~/.claude/state/langfuse_state.json | jq` shows everything when debugging.
- (−) The schema grows. Backward-compatible (optional field), but the JSDoc on the state type must call out the convention.
- (−) `cwd` keys can grow over time if sessions never `SessionEnd` cleanly. Mitigated: the existing 24h prune cycle in Stop also walks `_active_by_cwd` and removes any cwd whose session has been pruned.

**Resolves:** Lookup mechanism for FR-4.

---

## ADR-007: Unified scorability gate — both commands require `last_substantive_trace_id`

**Status:** Accepted

**Context:**
Q-OPEN-3 (`/feedback` before any turn) and Q-OPEN-4 (`/journey` before any turn) ask the same underlying question: "what does it mean to score a session that has no substantive content yet?" The answers should be symmetric — neither command should produce a score for an empty session.

**Decision:**
Both `/feedback` and `/journey` gate on the presence of `last_substantive_trace_id` for the current session. If absent, print a friendly command-specific message and exit 0 (no score emitted). The gate logic is shared in `src/commands/lookup.ts`.

**Alternatives Considered:**

| Option                                                           | Pros                                                                                               | Cons                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Unified gate (chosen)                                            | Symmetric UX; one piece of code; clearer to users; cleaner analytics (no scores on empty sessions) | Requires wiring the same field for both commands' gate logic                                                       |
| Asymmetric: allow `/journey` on empty session, block `/feedback` | sessionId always exists from session start                                                         | Loses symmetry; a `/journey down` on empty session is just dashboard noise; confused user gets no helpful feedback |
| Both allowed, no gate                                            | Simplest                                                                                           | Empty-session scores create misleading approval-rate dashboards                                                    |

**Rationale:**

- B-5 ("Coupling to the existing tracing path: only works when tracing is enabled and the session has at least one completed turn") explicitly disclaims behaviour for empty-traced sessions. The unified gate makes that disclaimer enforceable rather than aspirational.
- A friendly message educates a confused user; silent acceptance does not.
- Symmetry is a UX virtue — users learn one rule rather than two.

**Consequences:**

- (+) Predictable behaviour for both commands.
- (+) No empty-session noise in Langfuse score data.
- (−) A user who genuinely wants to express "I regret even starting this session" cannot. Vanishingly rare; if it ever surfaces, this ADR is revisitable.

**Resolves:** HLD Q-OPEN-3 and Q-OPEN-4.

---

## ADR-008: Score interrupted (Esc-pressed) turns same as completed turns

**Status:** Accepted

**Context:**
The existing `closeInterruptedTurn` helper (called from `UserPromptSubmit` when a stale `current_trace_id` is found) flushes whatever the transcript contains for the interrupted turn and tags the trace `interrupted`. The question is whether `/feedback` should be allowed to target such an interrupted trace, or whether interrupted-turn scoring should be excluded.

**Decision:**
Treat the interrupted turn's trace as substantive: when `closeInterruptedTurn` finalizes a turn, also write its trace ID into `last_substantive_trace_id`. `/feedback` then targets it normally.

**Alternatives Considered:**

| Option                                                   | Pros                                                                                              | Cons                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Score interrupted turns (chosen)                         | Matches user intuition: "I pressed Esc because the response was bad → /feedback down" should work | Score includes a partial turn; analytics may want to filter by the `interrupted` tag                                                           |
| Skip interrupted turns                                   | Cleanly separates "completed work" from "interrupted work"                                        | Loses the most natural use case for `/feedback down` (Esc-then-react); user experiences a friendly-reject when they expected the score to land |
| Allow scoring but tag the score `interrupted_turn: true` | Best of both worlds for analytics                                                                 | Adds metadata complexity; downstream queries get harder; no clear ask for this distinction                                                     |

**Rationale:**

- The most common reason a user would press Esc is dissatisfaction. Blocking them from scoring that turn would be actively user-hostile.
- The `interrupted` tag on the trace itself already distinguishes interrupted turns for any analytics that cares; the score doesn't need a redundant tag.
- The existing `closeInterruptedTurn` already finalizes the trace as a real Langfuse object — there's nothing partial about the trace from Langfuse's perspective.

**Consequences:**

- (+) Natural Esc-then-`/feedback down` flow works.
- (+) No special-case logic in the CLI — same gate, same target field.
- (−) Approval-rate dashboards include interrupted turns. Anyone who wants pure "successful turn quality" can filter by trace tag.

**Resolves:** HLD Q-OPEN-1.

---

## Decisions explicitly NOT taken in v1

These were considered and deferred — recorded here so future contributors don't re-litigate without context.

| Item                                                                                     | Rationale for deferral                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate score names for manual vs. offline-scorer feedback (e.g., `turn_feedback_auto`) | Intent doc B-3 + FR-6 commentary leaves the door open. v1 ships with one name per scope; if a future offline scorer needs to coexist with manual feedback in the same dashboard, the offline scorer picks a distinct name and the same UUIDv5 scheme works unchanged. |
| Plugin rename to shorten command invocation                                              | Q-OPEN-6. Decision deferred to EIS pending empirical autocomplete check. Renaming is user-hostile to existing installs, so we'd only do it if autocomplete genuinely fails.                                                                                           |
| Confirmation message richness (multi-line, color, etc.)                                  | Q-OPEN-5. One-line `✓ ...` confirmed; aesthetics are a low-stakes future PR.                                                                                                                                                                                          |
| Free-text reviews beyond a single-line `comment`                                         | Intent B-1. Out of v1 scope.                                                                                                                                                                                                                                          |
| Per-tool-span scoring                                                                    | Intent B-2. Resolution mismatch with v1 UX (`/feedback` doesn't have a way to identify a specific tool span).                                                                                                                                                         |
| Backfilling pre-feature sessions                                                         | Intent B-3. No mechanism in v1.                                                                                                                                                                                                                                       |

---

## Traceability summary

| ADR     | Resolves HLD Q-OPEN           | Drives Intent FR/NFC                  |
| ------- | ----------------------------- | ------------------------------------- |
| ADR-001 | (foundational)                | FR-1, NFC-4                           |
| ADR-002 | Q-OPEN-2                      | NFC-2, implicit cleanliness           |
| ADR-003 | (supports Q-OPEN-3, Q-OPEN-4) | FR-3, NFC-3                           |
| ADR-004 | (mechanism for FR-6)          | FR-6                                  |
| ADR-005 | (impl choice for ADR-004)     | NFC-5                                 |
| ADR-006 | (lookup mechanism for FR-4)   | FR-4, NFC-3                           |
| ADR-007 | Q-OPEN-3, Q-OPEN-4            | B-5                                   |
| ADR-008 | Q-OPEN-1                      | FR-3 (definition of "completed turn") |
