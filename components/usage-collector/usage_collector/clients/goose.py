"""Goose: per-session token totals in Goose's sessions.db.

A port of tokscale's Goose reader (crates/tokscale-core/src/sessions/goose.rs at b265e836): one
row per session at its created_at, using the accumulated counters when present. Goose has no
reasoning column; like tokscale, the gap between its total and input plus output counts as reasoning.
A session's counters grow while it runs, and its key stays the session id, so the newest copy replaces the old.
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Iterable

from usage_collector.outside import open_sqlite_ro, parse_ts, row

CLIENT = "goose"
QUERY = """
SELECT id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens,
       accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
FROM sessions WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
"""


def databases(home: str) -> list:
    out = []
    if os.environ.get("GOOSE_PATH_ROOT"):
        out.append(os.path.join(os.environ["GOOSE_PATH_ROOT"], "data", "sessions", "sessions.db"))
    out += [os.path.join(home, ".local/share/goose/sessions/sessions.db"),
            os.path.join(home, "Library/Application Support/goose/sessions/sessions.db"),
            os.path.join(home, ".local/share/Block/goose/sessions/sessions.db")]
    seen, keep = set(), []
    for p in out:
        if os.path.isfile(p) and os.path.realpath(p) not in seen:
            seen.add(os.path.realpath(p))
            keep.append(p)
    return keep


def _created(s) -> int:
    ms = parse_ts(s) if isinstance(s, str) else None
    if ms is not None:
        return ms
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(str(s), fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            pass
    return 0


def collect(ctx) -> Iterable[dict]:
    seen = set()
    for db in databases(str(ctx.home)):
        try:
            conn = open_sqlite_ro(db)
            rows = conn.execute(QUERY).fetchall()
            conn.close()
        except sqlite3.Error:
            continue
        for sid, cfg, provider_name, created, total, inp, out, acc_total, acc_in, acc_out in rows:
            try:
                model = str(json.loads(cfg).get("model_name") or "").strip()
            except (ValueError, AttributeError):
                continue
            if not model:
                continue
            pick = lambda a, b: max(int(a if a is not None else (b or 0)), 0)
            i, o, t = pick(acc_in, inp), pick(acc_out, out), pick(acc_total, total)
            if i == 0 and o == 0 and t == 0:
                continue
            reasoning = max(t - i - o, 0)
            call_at = _created(created)
            key = f"goose:{ctx.host}:{sid}"
            if key in seen or call_at < ctx.since:
                continue
            seen.add(key)
            provider = (provider_name or "").strip() or "unknown"
            yield row(source_key=key, call_at=call_at, host=ctx.host, client=CLIENT, session=str(sid), provider=provider,
                      model=model, input_tokens=i, output_tokens=o + reasoning, reasoning_tokens=reasoning)
