#!/usr/bin/env python3
"""Print one Vent tier's integration lights as JSON, built by the console's own code.

Run with apps/vent's python and PYTHONPATH at an apps/vent/src tree. It calls vent.telemetry.health.read_health,
the function behind GET /_vent/admin/health, with a Grafana row reader like the console's, so the lights,
windows and success counts match the Vent console for that tier. Usage: vent-health.py <env> <grafana url>,
where the url is prod Vent's grafana-agents integration, with GRAFANA_READ_VENT_KEY set. It prints no secret.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

import vent

# apps/vent keeps health and the telemetry reads in vent.telemetry since 2026-11-26, and at the top of the
# package before, so a tree from either side of that move runs.
if (Path(vent.__file__).parent / "telemetry" / "health.py").exists():
    from vent.telemetry import health
    from vent.telemetry import read as tr
else:
    from vent import health  # type: ignore[no-redef]
    from vent import telemetry_read as tr  # type: ignore[no-redef]


async def main(env: str, url: str) -> None:
    token = os.environ["GRAFANA_READ_VENT_KEY"]
    source = tr.GrafanaSource(url, f"Bearer {token}", "grafana_clickhouse", env)
    async with httpx.AsyncClient(timeout=None) as client:
        result = await health.read_health(lambda sql: tr.grafana_rows(client, source, sql), env)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
