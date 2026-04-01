# Claude Code Langfuse Hook

A high-fidelity [Langfuse](https://langfuse.com) tracing hook for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that captures the full structure of every conversation turn — multiple LLM calls, thinking blocks, token usage, and properly nested tool observations.

## Motivation

Langfuse provides an official Claude Code integration via a stop hook:
[langfuse.com/integrations/other/claude-code](https://langfuse.com/integrations/other/claude-code)

While using it in practice, we observed that the traces it produced were **lossy and flattened** — they didn't faithfully represent what actually happened during a conversation turn. Multi-step tool-use loops were collapsed into a single generation, thinking blocks vanished, token usage wasn't tracked, and tool observations weren't linked to the LLM call that invoked them.

To understand what a good trace *should* look like, we compared it against the LangSmith hook for Claude Code ([docs.langchain.com/langsmith/trace-claude-code](https://docs.langchain.com/langsmith/trace-claude-code)), which produces significantly richer traces. We identified every gap and built this hook to close them.

## Issues found in the original hook

| # | Issue | Impact |
|---|-------|--------|
| 1 | **Only the last assistant message is captured** | In multi-step turns (user &rarr; Claude responds &rarr; tool call &rarr; tool result &rarr; Claude responds again), all intermediate LLM outputs are thrown away. One generation observation is created regardless of how many LLM calls actually happened. |
| 2 | **Thinking blocks are silently discarded** | `extract_text` only picks up `type == "text"` content blocks. Extended thinking content vanishes with no indication it ever existed. |
| 3 | **No token usage tracking** | The generation observation never sets `usage_details`. Claude Code transcripts include `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` — all ignored. |
| 4 | **Tool observations are disconnected from their generation** | Tools are created as siblings of the generation (both children of the trace span). There is no way to tell which LLM call triggered which tool. |
| 5 | **No `stop_hook_active` guard** | The hook doesn't check for re-entrancy. If Claude Code sets this flag to prevent recursive hook firing, the original hook ignores it. |
| 6 | **Tool input truncation is inconsistent** | String inputs are truncated, but dict/list inputs (which can be arbitrarily large) are sent as-is. The truncation boundary depends on type, not size. |
| 7 | **Streaming chunks are not properly merged** | Multiple transcript lines with the same `message.id` represent streaming chunks. The original hook keeps only the last chunk ("latest wins"), potentially losing content blocks from earlier chunks. |
| 8 | **Import guard is too broad** | `except Exception` on the langfuse import catches not just `ImportError` but any bug in langfuse's init, causing silent failures. |
| 9 | **File lock timeout is silent** | On lock timeout, the hook proceeds without the lock and without logging — concurrent invocations could corrupt state. |
| 10 | **`flush()` is called under the file lock** | The Langfuse API call happens while the state file lock is held, increasing lock contention. |
| 11 | **State key is an opaque sha256 hash** | Makes state file debugging harder for no practical benefit — `session_id` is already unique. |
| 12 | **No timing data on observations** | Transcript entries include timestamps, but they are never extracted or stored. |
| 13 | **`propagate_attributes` usage is redundant in parts** | The original wraps `start_as_current_observation` with `propagate_attributes` and passes overlapping parameters to both. |

## What this hook does differently

This hook produces a **faithful, structured trace** for each conversation turn:

```
Session (session_id)
  └── Trace: "Claude Code - Turn N"
       ├── Generation: "LLM Call 1/3"  (model, usage, thinking in output)
       │    ├── Tool: "Glob"           (input, output, duration_ms)
       │    └── Tool: "Read"           (input, output, duration_ms)
       ├── Generation: "LLM Call 2/3"  (model, usage)
       │    └── Tool: "Edit"           (input, output, duration_ms)
       └── Generation: "LLM Call 3/3"  (model, usage, final response)
```

Specifically:

- **Multiple generations per turn** — each LLM API call gets its own `generation` observation, not just one per turn
- **Thinking blocks preserved** — stored in the generation `output.thinking` field
- **Token usage tracked** — `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` passed as `usage_details`
- **Tools nested under their parent generation** — you can see exactly which LLM call triggered which tool
- **Streaming chunks properly merged** — content blocks from all transcript lines with the same `message.id` are concatenated
- **Messages without IDs** — appended to the previous group as continuations (matching the LangSmith hook's behavior)
- **Consistent recursive truncation** — all content (strings, dicts, lists) truncated uniformly via `truncate_value`, configurable via `CC_LANGFUSE_MAX_CHARS`
- **`stop_hook_active` guard** — prevents redundant tracing during hook-triggered continuations
- **`ImportError`-specific catch** — real bugs in langfuse init surface instead of being swallowed
- **Lock timeout warning** — logged when the file lock can't be acquired
- **`flush()` outside the lock** — state file lock is released before the API call
- **Plain `session_id` as state key** — debuggable state file
- **Transcript timestamps in metadata** — stored on generation and tool observations
- **Tool execution duration** — `durationMs` from `toolUseResult` stored in tool observation metadata

## Setup

The setup process is the same as the [official Langfuse Claude Code integration](https://langfuse.com/integrations/other/claude-code) — you may just use this hook script instead of theirs.

### 1. Install the Langfuse SDK

Install `langfuse` in the Python environment that Claude Code will use:

```bash
pip install langfuse
```

> **Tip:** If you use different virtual environments per project, either install `langfuse` in each one, or point the hook's shebang to a fixed Python interpreter where `langfuse` is installed (e.g., a `pipx` environment). The hook fails silently if `langfuse` is not available — it won't break Claude Code, but it won't trace either.

### 2. Copy the hook

```bash
mkdir -p ~/.claude/hooks
cp langfuse_hook.py ~/.claude/hooks/langfuse_hook.py
```

### 3. Register the hook

Add the stop hook to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/langfuse_hook.py"
      }
    ]
  }
}
```

### 4. Set environment variables

```bash
export TRACE_TO_LANGFUSE=true
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
```

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_LANGFUSE_PUBLIC_KEY` | falls back to `LANGFUSE_PUBLIC_KEY` | Langfuse public key |
| `CC_LANGFUSE_SECRET_KEY` | falls back to `LANGFUSE_SECRET_KEY` | Langfuse secret key |
| `CC_LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Langfuse API host (for self-hosted) |
| `CC_LANGFUSE_DEBUG` | `false` | Enable debug logging to `~/.claude/state/langfuse_hook.log` |
| `CC_LANGFUSE_MAX_CHARS` | `50000` | Max characters before truncation |

## How it works

1. Claude Code invokes the hook after each response, passing `session_id` and `transcript_path` on stdin.
2. The hook reads only **new lines** from the JSONL transcript (byte-offset tracking with partial-line buffering).
3. Messages are grouped into **turns** (user message &rarr; one or more assistant messages &rarr; tool results).
4. Streaming chunks with the same `message.id` are **merged** into a single LLM call.
5. Each turn is emitted as a Langfuse trace with properly nested generation and tool observations.
6. State is persisted under `~/.claude/state/langfuse_state.json` with file locking.

## Debugging

Check the log file:

```bash
# Enable debug logging
export CC_LANGFUSE_DEBUG=true

# View logs
tail -f ~/.claude/state/langfuse_hook.log
```

## License

MIT
