"""Hermes Agent: per-session usage in ~/.hermes/state.db and each profiles/<name>/state.db.

A port of tokscale's Hermes reader (crates/tokscale-core/src/sessions/hermes.rs at b265e836):
one row per (session, model, billing provider) from session_model_usage, and one row per session
from the sessions table for sessions that table does not cover. Hermes keeps no per-call times,
so each row sits at the session start. tokscale also spreads a session over the days its agent.log
lines name; this module does not, so a session that spans days lands on its first day.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Iterable

from usage_collector.outside import open_sqlite_ro, reported, row

CLIENT = "hermes"
AGENT = "Hermes Agent"

PER_MODEL = """
SELECT smu.session_id, smu.model, smu.billing_provider, s.started_at,
       SUM(smu.input_tokens), SUM(smu.output_tokens), SUM(smu.cache_read_tokens), SUM(smu.cache_write_tokens),
       SUM(smu.reasoning_tokens), SUM(COALESCE(NULLIF(smu.actual_cost_usd, 0), smu.estimated_cost_usd, 0))
FROM session_model_usage smu JOIN sessions s ON s.id = smu.session_id
WHERE smu.model IS NOT NULL AND TRIM(smu.model) != ''
GROUP BY smu.session_id, smu.model, smu.billing_provider, s.started_at
HAVING SUM(smu.input_tokens) > 0 OR SUM(smu.output_tokens) > 0 OR SUM(smu.cache_read_tokens) > 0
    OR SUM(smu.cache_write_tokens) > 0 OR SUM(smu.reasoning_tokens) > 0
    OR SUM(COALESCE(NULLIF(smu.actual_cost_usd, 0), smu.estimated_cost_usd, 0)) > 0
"""
TOTALS = """
SELECT id, model, billing_provider, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, COALESCE(actual_cost_usd, estimated_cost_usd, 0)
FROM sessions
WHERE model IS NOT NULL AND TRIM(model) != ''
  AND (COALESCE(input_tokens, 0) > 0 OR COALESCE(output_tokens, 0) > 0 OR COALESCE(cache_read_tokens, 0) > 0
       OR COALESCE(cache_write_tokens, 0) > 0 OR COALESCE(reasoning_tokens, 0) > 0
       OR COALESCE(actual_cost_usd, estimated_cost_usd, 0) > 0)
"""


def databases(home: str) -> list:
    base = os.environ.get("HERMES_HOME") or os.path.join(home, ".hermes")
    out = [os.path.join(base, "state.db")]
    profiles = os.path.join(base, "profiles")
    if os.path.isdir(profiles):
        out += [os.path.join(profiles, p, "state.db") for p in sorted(os.listdir(profiles))]
    return [p for p in out if os.path.isfile(p)]


def collect(ctx) -> Iterable[dict]:
    seen = set()
    for db in databases(str(ctx.home)):
        for r in read_db(db, ctx.host):
            if r["source_key"] not in seen and r["call_at"] >= ctx.since:
                seen.add(r["source_key"])
                yield r


def _query(conn, sql):
    try:
        return conn.execute(sql).fetchall()
    except sqlite3.Error:
        return None


def _provider(billing, model: str) -> str:
    if isinstance(billing, str) and billing.strip():
        return billing.strip()
    m = model.lower()
    return "anthropic" if m.startswith("claude") else "openai" if m.startswith(("gpt", "o1", "o3", "o4")) else "google" if m.startswith("gemini") else "unknown"


def read_db(path: str, host: str) -> list:
    try:
        conn = open_sqlite_ro(path)
    except sqlite3.Error:
        return []
    try:
        has_smu = bool(_query(conn, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_model_usage'"))
        per_model = (_query(conn, PER_MODEL) if has_smu else None) or []
        totals = _query(conn, TOTALS) or []
    finally:
        conn.close()
    covered = {r[0] for r in per_model}
    out = []
    for r in per_model:
        out.append(_row(r, f"{r[0]}:{r[1]}:{r[2] if r[2] is not None else '<null>'}", host))
    for r in totals:
        if r[0] not in covered:
            out.append(_row(r, r[0], host))
    return out


def _row(r, key: str, host: str) -> dict:
    session, model, billing, started = r[0], r[1], r[2], r[3]
    n = lambda v: max(int(v or 0), 0)
    inp, output, cache_read, cache_write = n(r[4]), n(r[5]), n(r[6]), n(r[7])
    reasoning = min(n(r[8]), output)
    cost = max(float(r[9] or 0), 0.0)
    provider = _provider(billing, model)
    fields = dict(source_key=f"hermes:{host}:{key}", call_at=int(float(started or 0) * 1000), host=host, client=CLIENT,
                  agent=AGENT, session=session, provider=provider, model=model, input_tokens=inp, output_tokens=output,
                  reasoning_tokens=reasoning, cache_read_tokens=cache_read, cache_write_tokens=cache_write)
    if cost > 0:
        fields.update(reported(cost, model, provider, inp, output, cache_read, cache_write))
    return row(**fields)
