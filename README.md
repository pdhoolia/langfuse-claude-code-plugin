# Langfuse Claude Code Plugin

A Claude Code plugin that traces conversations to [Langfuse](https://langfuse.com) with full fidelity — multiple LLM generations per turn, thinking blocks, token usage, and properly nested tool observations.

## What it traces

```
Session (session_id)
  └── Trace: "Claude Code - Turn N"
       ├── Generation: "LLM Call 1/3"  (model, usage, thinking in output)
       │    ├── Span: "Tool: Glob"     (input, output, duration_ms)
       │    └── Span: "Tool: Read"     (input, output, duration_ms)
       ├── Generation: "LLM Call 2/3"  (model, usage)
       │    └── Span: "Tool: Edit"     (input, output, duration_ms)
       └── Generation: "LLM Call 3/3"  (model, usage, final response)
```

- **Multiple generations per turn** — each LLM API call gets its own generation observation
- **Thinking blocks preserved** — stored in the generation `output.thinking` field
- **Token usage tracked** — `input_tokens`, `output_tokens`, cache metrics in metadata
- **Tools nested under their parent generation** — shows which LLM call triggered which tool
- **Streaming chunks merged** — content blocks from all transcript lines with the same `message.id` are concatenated
- **Subagent tracing** — Agent tool calls and their subagent transcripts are traced
- **Context compaction events** — tracked via PreCompact/PostCompact hooks
- **Interrupted turn recovery** — turns interrupted by user escape are properly closed

## Installation

### From the marketplace

```bash
/plugin marketplace add pdhoolia/langfuse-claude-code-plugin
/plugin install langfuse-tracing@langfuse-claude-code-plugin
/reload-plugins
```

### For local development

Clone the repo and build:

```bash
git clone https://github.com/pdhoolia/langfuse-claude-code-plugin.git
cd langfuse-claude-code-plugin
pnpm install
pnpm build
```

Then run Claude Code with the plugin directory:

```bash
claude --plugin-dir /path/to/langfuse-claude-code-plugin
```

### 3. Configure environment variables

```bash
export TRACE_TO_LANGFUSE=true
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
```

`TRACE_TO_LANGFUSE=true` is required to enable tracing. Without it, all hooks exit early.

| Variable                 | Default                             | Description                         |
| ------------------------ | ----------------------------------- | ----------------------------------- |
| `TRACE_TO_LANGFUSE`      | (none)                              | Must be `true` to enable tracing    |
| `CC_LANGFUSE_PUBLIC_KEY` | falls back to `LANGFUSE_PUBLIC_KEY` | Langfuse public key                 |
| `CC_LANGFUSE_SECRET_KEY` | falls back to `LANGFUSE_SECRET_KEY` | Langfuse secret key                 |
| `CC_LANGFUSE_BASE_URL`   | `https://cloud.langfuse.com`        | Langfuse API host (for self-hosted) |
| `CC_LANGFUSE_DEBUG`      | `false`                             | Enable debug logging                |
| `CC_LANGFUSE_MAX_CHARS`  | `50000`                             | Max characters before truncation    |

## Hook lifecycle

| Hook                 | When                       | What it does                                                                |
| -------------------- | -------------------------- | --------------------------------------------------------------------------- |
| **UserPromptSubmit** | User sends a prompt        | Creates the Langfuse trace eagerly; handles interrupted turn recovery       |
| **PreToolUse**       | Before tool executes       | Records wall-clock start time in state                                      |
| **PostToolUse**      | After tool executes        | Records tool end time; for Agent tools, stores deferred creation info       |
| **Stop**             | Agent finishes responding  | Reads transcript, builds turns, creates nested generation/tool observations |
| **StopFailure**      | Turn ends due to API error | Updates trace with error status                                             |
| **SubagentStop**     | Subagent finishes          | Queues subagent transcript info for Stop to process                         |
| **PreCompact**       | Before context compaction  | Records compaction start time                                               |
| **PostCompact**      | After context compaction   | Creates compaction span/trace                                               |
| **SessionEnd**       | Session ends               | Closes interrupted turns                                                    |

## How it works

1. **UserPromptSubmit** creates a Langfuse trace eagerly (so it appears immediately) and stores the trace ID in session state.
2. **PreToolUse** records tool start times for accurate timing.
3. The **Stop** hook reads new lines from the JSONL transcript (line-number tracking), groups messages into turns, and creates nested observations:
   - One **generation** per LLM API call (not one per turn)
   - Tool **spans** nested under their parent generation
   - Streaming chunks with the same `message.id` merged into a single generation
4. **SubagentStop** queues subagent transcript paths; **Stop** reads and traces them.
5. State is persisted to `~/.claude/state/langfuse_state.json` with atomic file locking.

## Recording feedback

Two slash commands let you attach thumbs-up/down scores to either the most recent
completed turn or the entire current session. Both write **idempotent ±1 scores**
to Langfuse — re-invoking on the same target overwrites the previous score, so
mistakes are correctable in place.

```text
/feedback up                            # +1 on the latest completed turn
/feedback down                          # -1 on the latest completed turn
/feedback up great answer               # with optional comment
/feedback down output was truncated     # comment can contain spaces

/journey up                             # +1 on the current session
/journey down                           # -1 on the current session
/journey up wrapped up cleanly          # with optional comment
```

Plugin-namespaced forms also work (`/langfuse-tracing:feedback up`, etc.).

**Score schema:**

| Score name         | Attached to | Value type | Value     |
| ------------------ | ----------- | ---------- | --------- |
| `turn_feedback`    | Trace       | NUMERIC    | `+1`/`-1` |
| `session_feedback` | Session     | NUMERIC    | `+1`/`-1` |

**Score IDs are deterministic** — derived from `sha256(target_id:score_name)`
and formatted as a UUID. Same scheme as the offline scorer in
`context-gateway/.../session_scoring.py`, so an offline scorer can update the
same row by computing the same ID.

**Behavior notes:**

- Both commands silently exit if `TRACE_TO_LANGFUSE` isn't `true`.
- Both commands need at least one substantive turn to have completed in the
  current session — invoking before that prints a friendly hint.
- Slash command turns themselves are not traced (they would otherwise appear
  as their own meaningless traces and confuse the targeting of subsequent
  invocations).

## Development

```bash
pnpm install              # Install dependencies
pnpm build                # TypeScript compile + esbuild bundle (tsc && pnpm bundle)
pnpm dev                  # Watch mode — recompiles TypeScript on changes
pnpm test                 # Run tests (vitest)
pnpm lint                 # Lint with oxlint
pnpm lint:fix             # Lint and auto-fix
pnpm format               # Format with oxfmt
```

After making changes, run `pnpm build` — the `bundle/` directory contains the executable hooks.

## Debugging

```bash
# Enable debug logging
export CC_LANGFUSE_DEBUG=true

# View logs
tail -f ~/.claude/state/langfuse_hook.log
```

## Migrating from v0.1.x to v0.2.0

**What's new:** Two slash commands — `/feedback up|down [comment]` and
`/journey up|down [comment]` — write idempotent ±1 scores to Langfuse
attached to the current turn or session. See _Recording feedback_ above.

**Breaking change (low impact):** Hook bundle paths moved from
`bundle/<name>.js` to `bundle/hooks/<name>.js` so the new
`bundle/commands/<name>.js` files have a clean home. The plugin's own
`hooks/hooks.json` is updated in lockstep, so:

- If you installed via the Claude Code marketplace or a `git pull`,
  no action is needed beyond restarting Claude Code.
- If your personal `~/.claude/settings.json` hardcodes hook paths
  (most users do not), update each `bundle/<name>.js` reference to
  `bundle/hooks/<name>.js`.

State files (`~/.claude/state/langfuse_state.json`) carry over without
modification. Two new optional fields are added on demand by the v0.2.0
hooks; the next turn after upgrade populates them automatically.

## Migration from the Python hook

This plugin replaces the standalone `langfuse_hook.py` Python script. Key differences:

- **Plugin format** — no manual hook registration needed; just install the plugin
- **TypeScript** — compiled and bundled into self-contained ESM files
- **Multi-hook architecture** — 9 hooks instead of a single Stop hook
- **Line-based tracking** — uses line numbers instead of byte offsets
- **No Python dependency** — runs on Node.js (bundled with Claude Code)

### Migration steps

#### 1. Remove the old Python hook from `~/.claude/settings.json`

If both the Python hook and the plugin run at the same time, every turn will be traced twice. Open `~/.claude/settings.json` and delete the entry that invokes `langfuse_hook.py` from the `Stop` hooks array. A typical old config looks like this:

```json
"hooks": {
  "Stop": [
    {
      "hooks": [
        { "type": "command", "command": "python3 ~/.claude/hooks/langfuse_hook.py" }
      ]
    }
  ]
}
```

Remove the `python3 ~/.claude/hooks/langfuse_hook.py` command. If it was the only entry in the `Stop` array, drop the whole `Stop` block. Leave any other unrelated hooks alone.

You can also delete the script itself once you no longer need it:

```bash
rm ~/.claude/hooks/langfuse_hook.py
```

And if nothing else on your system uses it, uninstall the Python SDK:

```bash
pip uninstall langfuse
```

#### 2. Keep your environment variables

Your existing `TRACE_TO_LANGFUSE`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` entries (in `~/.claude/settings.json` under `env`, or exported in your shell) work as-is — the plugin reads the same variables. No changes needed.

#### 3. Install the plugin

```bash
/plugin marketplace add pdhoolia/langfuse-claude-code-plugin
/plugin install langfuse-tracing@langfuse-claude-code-plugin
```

This enables the plugin globally (every session in every directory). To scope it to a single project instead, enable it in that project's `.claude/settings.json` under `enabledPlugins` rather than the global one.

#### 4. Verify

Start a new Claude Code session, send a prompt, and confirm exactly one trace per turn appears in Langfuse. Tail the hook log if anything looks off:

```bash
tail -f ~/.claude/state/langfuse_hook.log
```

## License

MIT
