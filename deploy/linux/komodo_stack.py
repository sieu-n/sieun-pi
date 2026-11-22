"""The Komodo Stack box-sieun-pi, which runs the sieun-pi services and jobs on us-metal02 since 11-21: auto-sns-agent
apps/infra/box/compose.sieun-pi.yml, whose jobs the m02- Procedures in apps/infra/komodo/stacks.json start on their schedules.
No sieun-pi installer writes a systemd user unit on Linux: on 11-21 sieun-pi-wiki.service crash-looped on EADDRINUSE :5176 beside
box-sieun-pi-wiki-1. deploy/linux/komodo-stack.mjs is the same helper for the Node installers.
"""
from __future__ import annotations

import subprocess

STACK = "box-sieun-pi"


def restart(service: str) -> None:
    """Restarts the Stack's container of a long-running service, so it runs the release the installer just put in place."""
    subprocess.run(["docker", "restart", f"{STACK}-{service}-1"], check=True, capture_output=True)
