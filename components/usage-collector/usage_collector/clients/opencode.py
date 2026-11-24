"""OpenCode: assistant messages in ~/.local/share/opencode/opencode*.db and the legacy storage/message JSON files.

A port of tokscale's OpenCode reader (crates/tokscale-core/src/sessions/opencode.rs and opencode_schema.rs at
b265e836): one row per assistant message with tokens, keyed by its message id, with OpenCode's own positive
cost kept as reported.
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
from typing import Iterable, Optional

from usage_collector.outside import open_sqlite_ro, reported, row, walk_files, changed_only

CLIENT = "opencode"
QUERIES = (
    "SELECT sm.id, sm.session_id, sm.data, sm.type = 'assistant' FROM session_message sm",
    "SELECT m.id, m.session_id, m.data, 1 FROM message m",
)


def base(home: str) -> str:
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"), "opencode")


def collect(ctx) -> Iterable[dict]:
    return changed_only(ctx, _rows(ctx))


def _rows(ctx) -> Iterable[dict]:
    seen = set()
    root = base(str(ctx.home))
    for db in sorted(glob.glob(os.path.join(root, "opencode*.db"))):
        try:
            conn = open_sqlite_ro(db)
        except sqlite3.Error:
            continue
        try:
            for q in QUERIES:
                try:
                    rows = conn.execute(q).fetchall()
                except sqlite3.Error:
                    continue
                for mid, sid, data, eligible in rows:
                    r = _parse(data, mid, sid, bool(eligible), q.startswith("SELECT sm"), ctx.host)
                    if r and r["source_key"] not in seen and r["call_at"] >= ctx.since:
                        seen.add(r["source_key"])
                        yield r
        finally:
            conn.close()
    for path in walk_files(os.path.join(root, "storage", "message"), lambda n: n.endswith(".json")):
        try:
            with open(path, "rb") as fh:
                data = fh.read().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        r = _parse(data, None, None, True, False, ctx.host, legacy_path=path)
        if r and r["source_key"] not in seen and r["call_at"] >= ctx.since:
            seen.add(r["source_key"])
            yield r


def _n(v) -> int:
    return max(int(v), 0) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def _parse(data, mid, sid, eligible: bool, v2: bool, host: str, legacy_path: Optional[str] = None) -> Optional[dict]:
    try:
        msg = json.loads(data) if isinstance(data, (str, bytes)) else None
    except ValueError:
        return None
    if not isinstance(msg, dict) or not eligible:
        return None
    role = msg.get("role")
    if not (role == "assistant" or (v2 and role is None)):
        return None
    tokens = msg.get("tokens")
    if not isinstance(tokens, dict):
        return None
    cache = tokens.get("cache")
    if legacy_path is not None and not (isinstance(cache, dict) and "read" in cache and "write" in cache):
        return None
    cache = cache if isinstance(cache, dict) else {}
    model_obj = msg.get("model") if isinstance(msg.get("model"), dict) else {}
    model = msg.get("modelID") or model_obj.get("modelID") or model_obj.get("id")
    if not isinstance(model, str) or not model:
        return None
    provider = msg.get("providerID") or model_obj.get("providerID") or "unknown"
    time = msg.get("time") if isinstance(msg.get("time"), dict) else None
    if time is None or not isinstance(time.get("created"), (int, float)):
        return None
    created = float(time["created"])
    created = created if created > 1e12 else created * 1000
    completed = time.get("completed")
    completed = (completed if completed > 1e12 else completed * 1000) if isinstance(completed, (int, float)) else None
    inp, out, reasoning = _n(tokens.get("input")), _n(tokens.get("output")), _n(tokens.get("reasoning"))
    cache_read, cache_write = _n(cache.get("read")), _n(cache.get("write"))
    ident = msg.get("id") or mid or (os.path.realpath(legacy_path) if legacy_path else None)
    session = msg.get("sessionID") or sid or "unknown"
    fields = dict(source_key=f"opencode:{host}:{ident or f'{session}:{int(created)}'}", call_at=int(created), host=host,
                  client=CLIENT, agent=str(msg.get("mode") or msg.get("agent") or ""), session=str(session),
                  provider=str(provider), model=model, input_tokens=inp, output_tokens=out + reasoning,
                  reasoning_tokens=reasoning, cache_read_tokens=cache_read, cache_write_tokens=cache_write,
                  duration_ms=int(completed - created) if completed and completed > created else 0)
    cost = msg.get("cost")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost > 0:
        fields.update(reported(float(cost), model, str(provider), inp, out + reasoning, cache_read, cache_write))
    return row(**fields)
