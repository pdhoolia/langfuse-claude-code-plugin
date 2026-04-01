#!/usr/bin/env python3
"""
Claude Code -> Langfuse Stop Hook

Traces Claude Code conversations to Langfuse with full fidelity:
- Multiple LLM generations per turn (tool-use loops)
- Thinking blocks preserved in generation output
- Token usage and cache metrics
- Tool observations nested under their parent generation
- Streaming chunks merged by message ID
- Incremental processing via byte-offset state tracking
"""

import json
import os
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Fail-open: if langfuse isn't installed, exit silently
try:
    from langfuse import Langfuse, propagate_attributes
except ImportError:
    sys.exit(0)

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────

STATE_DIR = Path.home() / ".claude" / "state"
LOG_FILE = STATE_DIR / "langfuse_hook.log"
STATE_FILE = STATE_DIR / "langfuse_state.json"
LOCK_FILE = STATE_DIR / "langfuse_state.lock"

DEBUG = os.environ.get("CC_LANGFUSE_DEBUG", "").lower() == "true"
MAX_CHARS = int(os.environ.get("CC_LANGFUSE_MAX_CHARS", "50000"))

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────

def _log(level: str, msg: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a") as f:
            f.write(f"{ts} [{level}] {msg}\n")
    except Exception:
        pass


def debug(msg: str) -> None:
    if DEBUG:
        _log("DEBUG", msg)


def info(msg: str) -> None:
    _log("INFO", msg)


def warn(msg: str) -> None:
    _log("WARN", msg)


def error(msg: str) -> None:
    _log("ERROR", msg)

# ──────────────────────────────────────────────
# File Locking
# ──────────────────────────────────────────────

class FileLock:
    """Best-effort flock. Warns and proceeds without lock on timeout."""

    def __init__(self, path: Path, timeout_s: float = 2.0):
        self.path = path
        self.timeout_s = timeout_s
        self._fh = None

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+")
        try:
            import fcntl
            deadline = time.time() + self.timeout_s
            while True:
                try:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return self
                except BlockingIOError:
                    if time.time() > deadline:
                        warn("File lock timeout — proceeding without lock")
                        return self
                    time.sleep(0.05)
        except ImportError:
            # fcntl unavailable (Windows) — proceed without lock
            return self

    def __exit__(self, *exc):
        if self._fh:
            try:
                import fcntl
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                self._fh.close()
            except Exception:
                pass

# ──────────────────────────────────────────────
# State Management
# ──────────────────────────────────────────────

def load_state() -> Dict[str, Any]:
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except Exception:
        pass
    return {}


def save_state(state: Dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        warn(f"Failed to save state: {e}")

# ──────────────────────────────────────────────
# Truncation
# ──────────────────────────────────────────────

def truncate(text: str, max_chars: int = MAX_CHARS) -> str:
    if not text or len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n[...truncated, {len(text) - max_chars} more chars]"


def truncate_value(v: Any, max_chars: int = MAX_CHARS) -> Any:
    """Recursively truncate all string values in nested structures."""
    if isinstance(v, str):
        return truncate(v, max_chars)
    if isinstance(v, dict):
        return {k: truncate_value(val, max_chars) for k, val in v.items()}
    if isinstance(v, list):
        return [truncate_value(item, max_chars) for item in v]
    return v

# ──────────────────────────────────────────────
# Transcript Field Extraction
# ──────────────────────────────────────────────

def get_content(msg: Dict[str, Any]) -> Any:
    if not isinstance(msg, dict):
        return None
    m = msg.get("message")
    if isinstance(m, dict):
        return m.get("content")
    return msg.get("content")


def get_role(msg: Dict[str, Any]) -> Optional[str]:
    if not isinstance(msg, dict):
        return None
    t = msg.get("type")
    if t in ("user", "assistant"):
        return t
    m = msg.get("message")
    if isinstance(m, dict):
        r = m.get("role")
        if r in ("user", "assistant"):
            return r
    return None


def get_message_id(msg: Dict[str, Any]) -> Optional[str]:
    m = msg.get("message")
    if isinstance(m, dict):
        mid = m.get("id")
        if isinstance(mid, str) and mid:
            return mid
    return None


def get_model(msg: Dict[str, Any]) -> str:
    m = msg.get("message")
    if isinstance(m, dict):
        return m.get("model") or "claude"
    return "claude"


def get_usage(msg: Dict[str, Any]) -> Dict[str, int]:
    """Extract token usage, keeping only top-level integer values."""
    m = msg.get("message")
    if not isinstance(m, dict):
        return {}
    usage = m.get("usage")
    if not isinstance(usage, dict):
        return {}
    return {k: v for k, v in usage.items() if isinstance(v, int)}


def get_stop_reason(msg: Dict[str, Any]) -> Optional[str]:
    m = msg.get("message")
    if isinstance(m, dict):
        return m.get("stop_reason")
    return None


def is_tool_result(msg: Dict[str, Any]) -> bool:
    if get_role(msg) != "user":
        return False
    content = get_content(msg)
    if isinstance(content, list):
        return any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content)
    return False


def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for x in content:
            if isinstance(x, dict) and x.get("type") == "text":
                parts.append(x.get("text", ""))
            elif isinstance(x, str):
                parts.append(x)
        return "\n".join(p for p in parts if p)
    return ""


def extract_thinking(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts = []
    for x in content:
        if isinstance(x, dict) and x.get("type") == "thinking":
            parts.append(x.get("thinking", ""))
    return "\n".join(p for p in parts if p)

# ──────────────────────────────────────────────
# Incremental Transcript Reader
# ──────────────────────────────────────────────

def read_new_lines(
    path: Path, offset: int, buffer: str
) -> Tuple[List[Dict[str, Any]], int, str]:
    """
    Read new JSONL lines since `offset`. Keeps `buffer` for partial last line.
    Returns (parsed_messages, new_offset, remaining_buffer).
    """
    if not path.exists():
        return [], offset, buffer

    try:
        with open(path, "rb") as f:
            f.seek(offset)
            chunk = f.read()
            new_offset = f.tell()
    except Exception as e:
        debug(f"Failed to read transcript: {e}")
        return [], offset, buffer

    if not chunk:
        return [], offset, buffer

    text = chunk.decode("utf-8", errors="replace")
    combined = buffer + text
    lines = combined.split("\n")
    remaining = lines[-1]  # may be incomplete

    msgs: List[Dict[str, Any]] = []
    for line in lines[:-1]:
        line = line.strip()
        if not line:
            continue
        try:
            msgs.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    return msgs, new_offset, remaining

# ──────────────────────────────────────────────
# Data Model
# ──────────────────────────────────────────────

@dataclass
class ToolCall:
    id: str
    name: str
    input: Any
    output: Any = None
    timestamp: str = ""
    duration_ms: Optional[int] = None


@dataclass
class LLMCall:
    model: str
    text: str
    thinking: str
    tool_calls: List[ToolCall]
    usage: Dict[str, int]
    stop_reason: Optional[str]
    timestamp: str


@dataclass
class Turn:
    user_text: str
    user_timestamp: str
    llm_calls: List[LLMCall]

# ──────────────────────────────────────────────
# Turn Assembly
# ──────────────────────────────────────────────

def _merge_assistant_lines(
    lines: List[Dict[str, Any]], tool_results: Dict[str, Dict]
) -> LLMCall:
    """Merge streaming chunks (same message.id) into one LLMCall."""
    # Concatenate content blocks from all chunks
    all_content: List[Any] = []
    for line in lines:
        content = get_content(line)
        if isinstance(content, list):
            all_content.extend(content)
        elif isinstance(content, str):
            all_content.append({"type": "text", "text": content})

    # Metadata from the last chunk (final usage, stop_reason, model)
    last = lines[-1]

    # Extract structured parts
    text = extract_text(all_content)
    thinking = extract_thinking(all_content)

    # Build tool calls and match results
    tool_calls: List[ToolCall] = []
    for block in all_content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        tc = ToolCall(
            id=block.get("id", ""),
            name=block.get("name", "unknown"),
            input=block.get("input", {}),
        )
        tr = tool_results.get(tc.id)
        if tr:
            tc.output = tr["content"]
            tc.timestamp = tr.get("timestamp", "")
            tc.duration_ms = tr.get("duration_ms")
        tool_calls.append(tc)

    return LLMCall(
        model=get_model(last),
        text=text,
        thinking=thinking,
        tool_calls=tool_calls,
        usage=get_usage(last),
        stop_reason=get_stop_reason(last),
        timestamp=last.get("timestamp", ""),
    )


def build_turns(messages: List[Dict[str, Any]]) -> List[Turn]:
    """Group transcript messages into user-initiated turns."""
    turns: List[Turn] = []

    current_user: Optional[Dict[str, Any]] = None
    # OrderedDict preserves first-seen order of message IDs
    assistant_lines: OrderedDict[str, List[Dict]] = OrderedDict()
    tool_results: Dict[str, Dict] = {}

    def flush():
        nonlocal current_user, assistant_lines, tool_results
        if current_user is None or not assistant_lines:
            return
        llm_calls = [
            _merge_assistant_lines(lines, tool_results)
            for lines in assistant_lines.values()
        ]
        turns.append(Turn(
            user_text=extract_text(get_content(current_user)),
            user_timestamp=current_user.get("timestamp", ""),
            llm_calls=llm_calls,
        ))

    for msg in messages:
        # Collect tool results (user messages containing tool_result blocks)
        if is_tool_result(msg):
            content = get_content(msg)
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tid = block.get("tool_use_id")
                        if tid:
                            tool_results[tid] = {
                                "content": block.get("content"),
                                "timestamp": msg.get("timestamp", ""),
                                "duration_ms": (msg.get("toolUseResult") or {}).get("durationMs"),
                            }
            continue

        role = get_role(msg)

        if role == "user":
            flush()
            current_user = msg
            assistant_lines = OrderedDict()
            tool_results = {}
            continue

        if role == "assistant":
            if current_user is None:
                continue
            mid = get_message_id(msg)
            if mid is None:
                # No message ID — append to the last group as a continuation
                if assistant_lines:
                    last_key = next(reversed(assistant_lines))
                    assistant_lines[last_key].append(msg)
                else:
                    assistant_lines["_noid_0"] = [msg]
            else:
                if mid not in assistant_lines:
                    assistant_lines[mid] = []
                assistant_lines[mid].append(msg)
            continue

    flush()
    return turns

# ──────────────────────────────────────────────
# Langfuse Emission
# ──────────────────────────────────────────────

def emit_turn(
    langfuse: Langfuse,
    session_id: str,
    turn_num: int,
    turn: Turn,
    transcript_path: Path,
) -> None:
    """Emit one turn as a Langfuse trace with nested generation and tool observations."""
    trace_name = f"Claude Code - Turn {turn_num}"
    user_text = truncate(turn.user_text)
    final_text = truncate(turn.llm_calls[-1].text) if turn.llm_calls else ""

    with langfuse.start_as_current_observation(
        name=trace_name,
        input={"role": "user", "content": user_text},
    ) as root:
        with propagate_attributes(
            session_id=session_id,
            trace_name=trace_name,
            tags=["claude-code"],
            metadata={
                "source": "claude-code",
                "turn_number": str(turn_num),
                "transcript": transcript_path.name,
            },
        ):
            for i, llm in enumerate(turn.llm_calls, 1):
                _emit_llm_call(root, i, len(turn.llm_calls), llm, user_text)

            root.update(output={"role": "assistant", "content": final_text})


def _emit_llm_call(root, index: int, total: int, llm: LLMCall, user_text: str) -> None:
    """Emit one LLM call as a generation with child tool observations."""
    if total > 1:
        gen_name = f"LLM Call {index}/{total}"
    else:
        gen_name = "Claude Response"

    gen = root.start_observation(name=gen_name, as_type="generation")

    # Build output preserving thinking blocks
    output: Dict[str, Any] = {"role": "assistant", "text": truncate(llm.text)}
    if llm.thinking:
        output["thinking"] = truncate(llm.thinking)
    if llm.tool_calls:
        output["tool_calls"] = [{"name": tc.name, "id": tc.id} for tc in llm.tool_calls]

    # Token usage — only positive integer values
    usage_details = {k: v for k, v in llm.usage.items() if isinstance(v, int) and v > 0}

    gen.update(
        model=llm.model,
        input={"role": "user", "content": user_text},
        output=output,
        usage_details=usage_details or None,
        metadata={
            "stop_reason": llm.stop_reason or "",
            "timestamp": llm.timestamp,
            "has_thinking": str(bool(llm.thinking)),
        },
    )

    # Tool observations nested under this generation
    for tc in llm.tool_calls:
        _emit_tool(gen, tc)

    gen.end()


def _emit_tool(parent, tc: ToolCall) -> None:
    """Emit one tool call as an observation under its parent generation."""
    tool_obs = parent.start_observation(name=f"Tool: {tc.name}", as_type="tool")

    tool_input = truncate_value(tc.input)
    tool_output = truncate_value(tc.output) if tc.output is not None else None

    meta: Dict[str, str] = {"tool_id": tc.id}
    if tc.duration_ms is not None:
        meta["duration_ms"] = str(tc.duration_ms)
    if tc.timestamp:
        meta["timestamp"] = tc.timestamp

    tool_obs.update(input=tool_input, output=tool_output, metadata=meta)
    tool_obs.end()

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main() -> int:
    start = time.time()
    debug("Hook started")

    if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
        return 0

    # Read hook payload from stdin
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    # Re-entrancy guard
    if payload.get("stop_hook_active"):
        debug("stop_hook_active=true, skipping")
        return 0

    # Session and transcript
    session_id = payload.get("session_id") or payload.get("sessionId") or ""
    transcript = payload.get("transcript_path") or payload.get("transcriptPath") or ""
    if not session_id or not transcript:
        debug("Missing session_id or transcript_path")
        return 0

    transcript_path = Path(transcript).expanduser().resolve()
    if not transcript_path.exists():
        debug(f"Transcript not found: {transcript_path}")
        return 0

    # Langfuse credentials
    public_key = os.environ.get("CC_LANGFUSE_PUBLIC_KEY") or os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("CC_LANGFUSE_SECRET_KEY") or os.environ.get("LANGFUSE_SECRET_KEY")
    host = (
        os.environ.get("CC_LANGFUSE_BASE_URL")
        or os.environ.get("LANGFUSE_BASE_URL")
        or "https://cloud.langfuse.com"
    )
    if not public_key or not secret_key:
        debug("Missing Langfuse credentials")
        return 0

    try:
        langfuse = Langfuse(public_key=public_key, secret_key=secret_key, host=host)
    except Exception as e:
        error(f"Failed to init Langfuse: {e}")
        return 0

    try:
        # Process transcript under lock
        with FileLock(LOCK_FILE):
            state = load_state()
            ss = state.get(session_id, {})
            offset = int(ss.get("offset", 0))
            buffer = str(ss.get("buffer", ""))
            turn_count = int(ss.get("turn_count", 0))

            msgs, offset, buffer = read_new_lines(transcript_path, offset, buffer)
            turns = build_turns(msgs) if msgs else []

            emitted = 0
            for turn in turns:
                emitted += 1
                num = turn_count + emitted
                try:
                    emit_turn(langfuse, session_id, num, turn, transcript_path)
                except Exception as e:
                    error(f"Failed to emit turn {num}: {e}")

            turn_count += emitted
            state[session_id] = {
                "offset": offset,
                "buffer": buffer,
                "turn_count": turn_count,
                "updated": datetime.now(timezone.utc).isoformat(),
            }
            save_state(state)

        # Flush outside the lock — SDK batches internally, actual API call here
        langfuse.flush()

        dur = time.time() - start
        info(f"Emitted {emitted} turn(s) in {dur:.2f}s (session={session_id})")
        return 0

    except Exception as e:
        error(f"Unexpected error: {e}")
        return 0

    finally:
        try:
            langfuse.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
