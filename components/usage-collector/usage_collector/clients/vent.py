"""Vent product calls through CLIProxy, from prod ClickHouse otel.vent_calls (30-day TTL).

Vent writes one log row per upstream call. This module reads the rows that name a model and carry
tokens, through Grafana's ClickHouse datasource (uid grafana_clickhouse) with the viewer token,
because us-metal02 cannot reach ClickHouse itself (store.md section 2). Each row's host is the box
whose CLIProxy served it, taken from its deployment environment, and its key holds only the log
row's own ids, so a second collector running this module writes the same keys instead of new rows.
ledger.events and otel.vendor_usage copy the same calls again and are not read.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Iterable

from usage_collector.outside import row

CLIENT = "vent"
CONFIG = os.environ.get("USAGE_VENT_GRAFANA", os.path.expanduser("~/.prime/agent/browser-chat/grafana-alerts.json"))
DATASOURCE = "grafana_clickhouse"
HOSTS = {"production": "us-metal01", "staging": "us-metal02"}
# A 6 h window held 9,605 rows and took 1.85 s through Grafana on 2026-11-24, while one ORDER BY ... LIMIT
# 10000 page took 14.2 s, because the table sorts by environment first and a time window prunes by day partition.
WINDOW_NS = 6 * 3600 * 10**9
# Rows reach otel.vent_calls a few seconds after their Timestamp (newest row 5.7 s old on 2026-11-24,
# and the prod profile forces 5 s async inserts), so each pass rereads the last minute.
OVERLAP_NS = 60 * 10**9

QUERY = """
SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS ns, TraceId AS trace, SpanId AS span,
       ResourceAttributes['deployment.environment.name'] AS env,
       `vent.caller` AS caller, `vent.operation` AS operation, `vent.integration` AS integration,
       `vent.provider` AS provider, `gen_ai.request.model` AS model,
       toUInt64OrZero(`gen_ai.usage.input_tokens`) AS input, toUInt64OrZero(`gen_ai.usage.output_tokens`) AS output,
       toUInt64OrZero(`gen_ai.usage.cache_read_input_tokens`) AS cache_read,
       toUInt64OrZero(`gen_ai.usage.cache_creation_input_tokens`) AS cache_write,
       toUInt64OrZero(`vent.total_ms`) AS total_ms
FROM otel.vent_calls
WHERE Timestamp >= fromUnixTimestamp64Nano(toInt64({lo})) AND Timestamp < fromUnixTimestamp64Nano(toInt64({hi}))
  AND `gen_ai.request.model` != ''
  AND toUInt64OrZero(`gen_ai.usage.input_tokens`) + toUInt64OrZero(`gen_ai.usage.output_tokens`)
    + toUInt64OrZero(`gen_ai.usage.cache_read_input_tokens`) + toUInt64OrZero(`gen_ai.usage.cache_creation_input_tokens`) > 0
ORDER BY Timestamp
"""


def grafana_query(sql: str) -> list:
    with open(CONFIG) as fh:
        cfg = json.load(fh)
    body = json.dumps({"queries": [{"refId": "A", "datasource": {"uid": DATASOURCE}, "rawSql": sql, "format": 1,
                                    "queryType": "sql", "editorType": "sql"}], "from": "now-1h", "to": "now"}).encode()
    req = urllib.request.Request(cfg["url"].rstrip("/") + "/api/ds/query", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {cfg['token']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.load(r)["results"]["A"]
    if res.get("error"):
        raise RuntimeError(f"grafana {DATASOURCE}: {res['error']}")
    frames = res.get("frames") or []
    if not frames or not frames[0]["data"]["values"]:
        return []
    names = [f["name"] for f in frames[0]["schema"]["fields"]]
    return [dict(zip(names, t)) for t in zip(*frames[0]["data"]["values"])]


def collect(ctx, query=grafana_query, now_ns=None) -> Iterable[dict]:
    from usage_collector.core import CHECKPOINT

    end = now_ns if now_ns is not None else time.time_ns()
    lo = max(int(ctx.state.get("ns_cursor", 0)) - OVERLAP_NS, ctx.since * 10**6)
    seen = set()
    while lo < end:
        hi = min(lo + WINDOW_NS, end)
        for r in query(QUERY.format(lo=lo, hi=hi)):
            out = to_row(r)
            if out["source_key"] not in seen:
                seen.add(out["source_key"])
                yield out
        ctx.state["ns_cursor"] = str(hi)
        yield CHECKPOINT
        lo = hi


def to_row(r: dict) -> dict:
    env = r.get("env") or ""
    host = HOSTS.get(env, env or "unknown")
    ns = int(r["ns"])
    return row(source_key=f"vent:{host}:{r['trace']}:{r['span']}:{ns}", call_at=ns // 10**6, host=host, client=CLIENT,
               agent=r.get("caller") or "", thread=r.get("operation") or "", session=r.get("trace") or r.get("span") or f"untraced:{ns}",
               provider=r.get("provider") or "", model=r["model"], account=r.get("integration") or "",
               input_tokens=int(r["input"]), output_tokens=int(r["output"]), cache_read_tokens=int(r["cache_read"]),
               cache_write_tokens=int(r["cache_write"]), duration_ms=int(r["total_ms"]))
