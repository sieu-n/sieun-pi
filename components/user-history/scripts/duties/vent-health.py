#!/usr/bin/env python3
"""Print one Vent tier's integration lights as JSON, built by the console's own code.

Run with apps/vent's python and PYTHONPATH at an apps/vent/src tree. It calls vent.health.read_health,
the function behind GET /_vent/admin/health, with a Grafana row reader like the console's, so the lights,
windows and success counts match the Vent console for that tier. Usage: vent-health.py <env> <grafana url>,
with GRAFANA_AGENT_TOKEN set. It prints no secret.
"""

import asyncio
import json
import os
import sys

import httpx

from vent import health
from vent import telemetry_read as tr


async def main(env: str, url: str) -> None:
    token = os.environ["GRAFANA_AGENT_TOKEN"]
    source = tr.GrafanaSource(url, f"Bearer {token}", "grafana_clickhouse", env)
    async with httpx.AsyncClient(timeout=None) as client:
        result = await health.read_health(lambda sql: tr.grafana_rows(client, source, sql), env)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
