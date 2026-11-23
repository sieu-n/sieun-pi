"""Aside: one JSONL record per model response under ~/.aside/u/<account>/sessions/<session>/messages.jsonl.

A port of tokscale's Aside reader (crates/tokscale-core/src/sessions/aside.rs at b265e836).
Aside records each response's own cost, so rows carry cost_source 'reported' when it is positive.
"""

from __future__ import annotations

import json
import os
from typing import Iterable

from usage_collector.outside import changed_files, mtime_ms, parse_ts, reported, row

CLIENT = "aside"
# Aside's provider field names the route it took; these routes name no vendor or name Anthropic.
_ROUTES = {"claude-code": "anthropic", "ai-gateway": None, "aside": None, "unknown": None}


def files(home: str) -> list:
    base = os.path.join(home, ".aside", "u")
    out = []
    if not os.path.isdir(base):
        return out
    for account in sorted(os.listdir(base)):
        sessions = os.path.join(base, account, "sessions")
        if not os.path.isdir(sessions):
            continue
        for session in sorted(os.listdir(sessions)):
            p = os.path.join(sessions, session, "messages.jsonl")
            if os.path.isfile(p):
                out.append(p)
    return out


def collect(ctx) -> Iterable[dict]:
    seen = set()
    for mtime, path in changed_files(files(str(ctx.home)), ctx.state, ctx.since):
        for r in parse_file(path, ctx.host):
            if r["source_key"] in seen or r["call_at"] < ctx.since:
                continue
            seen.add(r["source_key"])
            yield r
        ctx.state["mtime_cursor_ms"] = mtime


def _vendor(provider, model: str) -> str:
    raw = provider.strip() if isinstance(provider, str) else ""
    if raw:
        low = raw.lower()
        if low not in _ROUTES:
            return raw
        if _ROUTES[low]:
            return _ROUTES[low]
    m = model.lower()
    for prefix, vendor in (("claude", "anthropic"), ("anthropic/", "anthropic"), ("gpt", "openai"), ("openai/", "openai"),
                           ("o1", "openai"), ("o3", "openai"), ("o4", "openai"), ("gemini", "google"), ("google/", "google")):
        if m.startswith(prefix):
            return vendor
    return "unknown"


def _n(v) -> int:
    return max(int(v), 0) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def parse_file(path: str, host: str) -> list:
    session_dir = os.path.dirname(path)
    session = f"{os.path.basename(os.path.dirname(os.path.dirname(session_dir)))}/{os.path.basename(session_dir)}"
    fallback_ts = mtime_ms(path)
    out = []
    with open(path, "rb") as fh:
        for lineno, raw in enumerate(fh, 1):
            try:
                rec = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if not isinstance(rec, dict) or rec.get("role") != "assistant" or not isinstance(rec.get("usage"), dict):
                continue
            u = rec["usage"]
            output = _n(u.get("output"))
            reasoning = min(_n(u.get("reasoning")), output)
            cache_write = _n(u.get("cacheWrite"))
            inp, cache_read = _n(u.get("input")), _n(u.get("cacheRead"))
            one_hour = min(_n(u.get("cacheWrite1h")), cache_write)
            cost = u.get("cost", {}).get("total") if isinstance(u.get("cost"), dict) else None
            cost = cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost > 0 else 0.0
            if inp + output + cache_read + cache_write == 0 and cost == 0:
                continue
            model = rec.get("model").strip() if isinstance(rec.get("model"), str) and rec["model"].strip() else "unknown"
            provider = _vendor(rec.get("provider"), model)
            ts = parse_ts(rec.get("timestamp"))
            rid = rec.get("responseId").strip() if isinstance(rec.get("responseId"), str) else ""
            key = f"response:{len(provider)}:{provider}:{rid}" if rid else f"nokey:{session}:{lineno}"
            fields = dict(source_key=f"aside:{host}:{key}", call_at=ts if ts is not None else fallback_ts, host=host,
                          client=CLIENT, session=session, account=session.split("/")[0], provider=provider, model=model,
                          input_tokens=inp, output_tokens=output, reasoning_tokens=reasoning, cache_read_tokens=cache_read,
                          cache_write_tokens=cache_write, cache_write_1h_tokens=one_hour)
            if cost > 0:
                fields.update(reported(cost, model, provider, inp, output, cache_read, cache_write, one_hour))
            out.append(row(**fields))
    return out
