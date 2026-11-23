"""Prime chats and jobs: each assistant message with usage in the Prime transcripts is one call, read as usage-feed reads it
(legacy/prime/usage-feed/feed.py Usage.record and backfill.py calls_in), so the totals equal Prime Usage's LGTM series for the same calls.

Files: ~/.prime/agent/sessions/*.jsonl, upstream Pi's sessions/--<cwd slug>--/*.jsonl, and each RLM child's
session-artifacts/<root>/sub-*/.../*.jsonl, the same walk as feed.py transcripts(). Like usage-feed, this counts only `type: message`
assistant entries: child_usage_attributed entries repeat a child's usage that the child's own transcript already holds, and refinement
calls in `prime-agent.refinement` custom entries are left out, as usage-feed leaves them out.

Key: the answer's responseId, so a forked or copied transcript that repeats an answer adds no row; without one, the entry id and its time,
the call id of backfill.py and otel-tok-meter's truth.py.

Cursor per file: [size, offset, inode, session id, session name]. A file is read once from its start, then only the bytes it gained. A
file whose inode changed or that shrank is read again from its start; its rows keep their keys.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from ..core import CHECKPOINT

CLIENT = "prime"
# feed.py WALK_EVERY_S: on the Mac on 10-29 one walk of 13,801 transcripts took 0.32 to 0.44 s of CPU, so a walk on every 10 s pass would
# cost about 4% of a core; between walks only the files that grew since the walk before are read.
WALK_EVERY_S = 60


def epoch_ms(value: object) -> Optional[int]:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def transcripts(prime: Path) -> List[Tuple[Path, Optional[str]]]:
    """(file, root session id) pairs, root sessions first so a child can take its root's name; the root id is None for a root."""
    roots: List[Tuple[Path, Optional[str]]] = []
    sessions = prime / "sessions"
    if sessions.is_dir():
        for entry in os.scandir(sessions):
            if entry.name.endswith(".jsonl") and entry.is_file():
                roots.append((Path(entry.path), None))
            elif entry.name.startswith("--") and entry.is_dir():
                for inner in os.scandir(entry.path):
                    if inner.name.endswith(".jsonl") and inner.is_file():
                        roots.append((Path(inner.path), None))
    children: List[Tuple[Path, Optional[str]]] = []
    artifacts = prime / "session-artifacts"
    if artifacts.is_dir():
        for root in os.scandir(artifacts):
            if not root.is_dir():
                continue
            stack = [Path(root.path)]
            while stack:
                folder = stack.pop()
                try:
                    entries = list(os.scandir(folder))
                except OSError:
                    continue
                for entry in entries:
                    if entry.name.startswith("sub-") and entry.is_dir():
                        stack.append(Path(entry.path))
                    elif folder.name.startswith("sub-") and entry.name.endswith(".jsonl") and entry.name != "rlm-subagents.jsonl" and entry.is_file():
                        children.append((Path(entry.path), root.name))
    return sorted(roots) + sorted(children)


def job_chats(prime: Path) -> Dict[str, str]:
    """Root job name -> the Prime chat that started it, from the browser chat's chat-jobs.json."""
    try:
        jobs = json.loads((prime / "browser-chat/chat-jobs.json").read_text()).get("jobs") or {}
    except (FileNotFoundError, ValueError, AttributeError):
        return {}
    return {str(name): str(job.get("chat") or "") for name, job in jobs.items() if isinstance(job, dict) and job.get("chat")}


def call_of(entry: dict, host: str) -> Optional[Dict[str, Any]]:
    message = entry.get("message") if entry.get("type") == "message" else None
    if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("usage"), dict):
        return None
    model = message.get("responseModel") or message.get("model")
    ended = epoch_ms(entry.get("timestamp"))
    if not isinstance(model, str) or not isinstance(message.get("provider"), str) or ended is None:
        return None
    if message.get("responseId"):
        key = f"{CLIENT}:{host}:{message['responseId']}"
    elif entry.get("id"):
        key = f"{CLIENT}:{host}:msg:{entry['id']}:{entry.get('timestamp')}"
    else:
        return None
    usage = message["usage"]

    def number(source: Any, name: str) -> float:
        value = source.get(name) if isinstance(source, dict) else None
        return value if isinstance(value, (int, float)) and value > 0 else 0

    cost = usage.get("cost")
    started = message.get("timestamp")
    return {
        "source_key": key,
        "call_at": ended,
        "provider": message["provider"],
        "model": model,
        "input_tokens": number(usage, "input"),
        "output_tokens": number(usage, "output"),
        "cache_read_tokens": number(usage, "cacheRead"),
        "cache_write_tokens": number(usage, "cacheWrite"),
        "cost_input_usd": number(cost, "input"),
        "cost_output_usd": number(cost, "output"),
        "cost_cache_read_usd": number(cost, "cacheRead"),
        "cost_cache_write_usd": number(cost, "cacheWrite"),
        "cost_source": "reported",
        "duration_ms": max(0, ended - started) if isinstance(started, (int, float)) else 0,
    }


def read(path: Path, offset: int, host: str, since: int) -> Tuple[List[Dict[str, Any]], int, Optional[str], Optional[str]]:
    """Calls in the complete lines after `offset`, the offset after the last complete line, the header's session id when the read
    starts at 0, and the last session_info name in the bytes read."""
    calls: List[Dict[str, Any]] = []
    session: Optional[str] = None
    name: Optional[str] = None
    position = offset
    with open(path, "rb") as handle:
        handle.seek(offset)
        for line in handle:
            if not line.endswith(b"\n"):
                break
            position += len(line)
            header = session is None and offset == 0 and b'"session"' in line[:200]
            if not header and b'"assistant"' not in line and b'"session_info"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict):
                continue
            kind = entry.get("type")
            if kind == "session" and isinstance(entry.get("id"), str):
                session = entry["id"]
            elif kind == "session_info" and isinstance(entry.get("name"), str):
                name = entry["name"]
            else:
                call = call_of(entry, host)
                if call is not None and call["call_at"] >= since:
                    calls.append(call)
    return calls, position, session, name


def collect(ctx: Any) -> Iterator[Any]:
    prime = ctx.home / ".prime/agent"
    cache = ctx.cache
    now = time.time()
    walk = now - cache.get("walked_at", 0.0) >= WALK_EVERY_S
    if walk:
        files = transcripts(prime)
        cache["jobs"] = job_chats(prime)
    else:
        files = sorted(cache.get("hot", ()), key=lambda item: (item[1] is not None, item))
    jobs: Dict[str, str] = cache.get("jobs", {})
    grew = cache.setdefault("grew", set())
    for path, root in files:
        key = "f:" + str(path.relative_to(prime))
        try:
            info = path.stat()
        except OSError:
            continue
        cursor = ctx.state.get(key)
        if cursor is not None and cursor[2] == info.st_ino and cursor[0] == info.st_size:
            continue
        if cursor is None and info.st_mtime * 1000 < ctx.since:
            ctx.state[key] = [info.st_size, info.st_size, info.st_ino, None, None]
            yield CHECKPOINT
            continue
        grew.add((path, root))
        offset = cursor[1] if cursor is not None and cursor[2] == info.st_ino and cursor[1] <= info.st_size else 0
        calls, end, session, name = read(path, offset, ctx.host, ctx.since)
        if offset > 0 and cursor is not None:
            session = cursor[3]
            name = name or cursor[4]
        if root is None:
            thread, thread_name = session or path.stem, name or ""
        else:
            root_cursor = ctx.state.get(f"f:sessions/{root}.jsonl")
            thread, thread_name = root, (root_cursor[4] if root_cursor else None) or ""
        agent = jobs.get(thread_name, thread_name)
        for call in calls:
            call.update(agent=agent, thread=thread, thread_name=thread_name, session=session or path.stem)
            yield call
        ctx.state[key] = [info.st_size, end, info.st_ino, session, name]
        yield CHECKPOINT
    if walk:
        cache["walked_at"] = now
        cache["hot"], cache["grew"] = grew, set()
