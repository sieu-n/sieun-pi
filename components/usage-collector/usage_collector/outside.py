"""Shared helpers for the outside-client modules in usage_collector/clients."""

from __future__ import annotations

import io
import os
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Callable, Iterator, Optional

from usage_collector import prices

COLUMNS = (
    "source_key", "call_at", "host", "client", "agent", "thread", "session", "provider", "model", "account",
    "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
    "cache_write_1h_tokens", "cost_input_usd", "cost_output_usd", "cost_cache_read_usd",
    "cost_cache_write_usd", "cost_source", "duration_ms",
)

def row(**fields) -> dict:
    """One usage.model_calls row; costs come from prices.cost unless the caller passes cost_source."""
    out = {
        "agent": "", "thread": "", "session": "", "provider": "", "account": "",
        "input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cache_read_tokens": 0,
        "cache_write_tokens": 0, "cache_write_1h_tokens": 0, "duration_ms": 0,
    }
    out.update(fields)
    if "cost_source" not in out:
        out.update(prices.cost(out["model"], out["provider"], out["input_tokens"], out["output_tokens"],
                               out["cache_read_tokens"], out["cache_write_tokens"], out["cache_write_1h_tokens"]))
    for k in COLUMNS:
        if k not in out:
            raise KeyError(f"row is missing {k}")
    return {k: out[k] for k in COLUMNS}


def reported(total: float, model: str, provider: str, input_tokens: int, output_tokens: int, cache_read_tokens: int,
             cache_write_tokens: int, cache_write_1h_tokens: int = 0) -> dict:
    """Cost columns for a source that records only a total: split in proportion to our own price of each part."""
    parts = prices.cost(model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens)
    names = ("cost_input_usd", "cost_output_usd", "cost_cache_read_usd", "cost_cache_write_usd")
    priced = sum(parts[n] for n in names)
    out = {n: (total * parts[n] / priced if priced > 0 else 0.0) for n in names}
    if priced <= 0:
        out["cost_input_usd"] = total
    out["cost_source"] = "reported"
    return out


def parse_ts(value) -> Optional[int]:
    """RFC 3339 string, epoch seconds or epoch ms to epoch ms."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    if not isinstance(value, str) or not value:
        return None
    s = value.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    if "." in s:
        head, _, tail = s.partition(".")
        digits = ""
        while tail and tail[0].isdigit():
            digits, tail = digits + tail[0], tail[1:]
        s = f"{head}.{(digits + '000000')[:6]}{tail}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return int(dt.timestamp() * 1000)


def mtime_ms(path: str) -> int:
    return int(os.stat(path).st_mtime * 1000)


def walk_files(root: str, keep: Callable[[str], bool]) -> Iterator[str]:
    """Files under root, following no symlinks below it, sorted for a stable order."""
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if keep(name):
                yield os.path.join(dirpath, name)


def changed_files(paths, state: dict, since_ms: int) -> list:
    """(mtime ms, path) of files at or after the saved cursor and since_ms, oldest first.

    A caller saves each file's mtime as state["mtime_cursor_ms"] once its rows are in the sink. The cursor
    is inclusive, so a file written in the same millisecond as the last one read is read again, which
    only resends rows with the same keys.
    """
    floor = max(state.get("mtime_cursor_ms", 0), since_ms)
    picked = []
    for p in paths:
        try:
            m = mtime_ms(p)
        except OSError:
            continue
        if m >= floor:
            picked.append((m, p))
    picked.sort()
    return picked


def read_text(path: str) -> io.TextIOBase:
    """A text reader for a .jsonl or .jsonl.zst file."""
    if not path.endswith(".zst"):
        return open(path, "r", encoding="utf-8", errors="replace")
    try:
        from compression import zstd
        return io.TextIOWrapper(zstd.open(path, "rb"), encoding="utf-8", errors="replace")
    except ImportError:
        pass
    try:
        import zstandard
        return io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(open(path, "rb")), encoding="utf-8", errors="replace")
    except ImportError:
        pass
    exe = shutil.which("zstd") or next((p for p in ("/opt/homebrew/bin/zstd", "/usr/bin/zstd") if os.path.exists(p)), None)
    if not exe:
        raise RuntimeError(f"no zstd decoder for {path}")
    proc = subprocess.Popen([exe, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return io.TextIOWrapper(proc.stdout, encoding="utf-8", errors="replace")


def open_sqlite_ro(path: str):
    """A read-only connection that never writes the database or its WAL."""
    import sqlite3
    from urllib.parse import quote
    return sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=5)


def utc_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
