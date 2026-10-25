#!/usr/bin/env python3
"""Print what each Vent console read costs on prod ClickHouse, as JSON, built by the console's own code.

Run with apps/vent's python and PYTHONPATH at an apps/vent/src tree, the one prod runs. It builds the
17 reads the console runs (vent.telemetry_read usage and calls over 1 h and 24 h, vent.health's summary,
trend and top), runs each once through Grafana as the console does, tagged with a log_comment, and reads
each run's CPU from otel.query_cost. Usage: vent-console-cost.py <env> <grafana url>, with
GRAFANA_AGENT_TOKEN set. It prints no secret.
"""

import asyncio
import json
import os
import secrets
import sys

import httpx

from vent import health
from vent import telemetry_read as tr

# measured: on prod from 10-22 to 10-25, every tagged read showed in otel.query_cost 9 s after it ended
# (system.query_log flushes every 7.5 s by default), across 6 runs of these 17 reads.
FLUSH_S = 9
TRIES = 5


def console_reads(env: str) -> dict[str, str]:
    reads: dict[str, str] = {}
    for range_key in (tr.RangeKey.HOUR, tr.RangeKey.DAY):
        usage = tr.usage_sql(env, range_key, tr.RouteFilter.OUTBOUND)
        for part in ("totals", "series", "by_caller", "by_integration", "by_operation"):
            reads[f"usage.{part} {range_key.value}"] = getattr(usage, part)
        reads[f"calls.all {range_key.value}"] = tr.calls_sql(env, tr.CallFilters(range=range_key), None)
        reads[f"calls.resend {range_key.value}"] = tr.calls_sql(
            env, tr.CallFilters(range=range_key, integration="resend"), None
        )
    lights = health.health_sql(env)
    reads["health.summary"], reads["health.trend"], reads["health.top"] = lights.summary, lights.trend, lights.top
    return reads


async def main(env: str, url: str) -> None:
    source = tr.GrafanaSource(url, f"Bearer {os.environ['GRAFANA_AGENT_TOKEN']}", "grafana_clickhouse", env)
    tags = {name: f"query-cost-{secrets.token_hex(6)}" for name in console_reads(env)}
    async with httpx.AsyncClient(timeout=None) as client:
        for name, sql in console_reads(env).items():
            await tr.grafana_rows(client, source, f"SELECT count() FROM ({sql}) SETTINGS log_comment = '{tags[name]}'")
        listed = ", ".join(f"'{tag}'" for tag in tags.values())
        costs: dict[str, dict[str, object]] = {}
        for _ in range(TRIES):
            await asyncio.sleep(FLUSH_S)
            rows = await tr.grafana_rows(
                client,
                source,
                "SELECT log_comment, toFloat64(cpu_us) AS cpu_us, toFloat64(read_rows) AS read_rows "
                f"FROM otel.query_cost WHERE type = 'QueryFinish' AND log_comment IN ({listed})",
            )
            costs = {str(row["log_comment"]): row for row in rows}
            if len(costs) == len(tags):
                break
    reads = []
    for name, tag in tags.items():
        row = costs.get(tag)
        reads.append({"name": name, "cpu_s": None if row is None else round(float(row["cpu_us"]) / 1e6, 3),
                      "read_rows": None if row is None else int(float(row["read_rows"]))})
    json.dump({"reads": reads}, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
