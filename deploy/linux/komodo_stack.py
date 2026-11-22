"""The Komodo Stack box-sieun-pi, which runs the sieun-pi services and timers on us-metal02 since 11-21: auto-sns-agent
apps/infra/box/compose.sieun-pi.yml, whose jobs the m02- Procedures in apps/infra/komodo/stacks.json start on their schedules.

An installer that finds the Stack on its box writes and enables no systemd user unit, because a unit beside the container starts a
second copy: on 11-21 sieun-pi-wiki.service crash-looped on EADDRINUSE :5176 beside box-sieun-pi-wiki-1. deploy/linux/komodo-stack.mjs
is the same check for the Node installers.
"""
from __future__ import annotations

import subprocess

STACK = "box-sieun-pi"


def runs_here() -> bool:
    """Whether docker on this box holds a container of the Stack."""
    try:
        found = subprocess.run(["docker", "ps", "-a", "-q", "--filter", f"label=com.docker.compose.project={STACK}"], capture_output=True, text=True)
    except FileNotFoundError:
        return False
    return found.returncode == 0 and bool(found.stdout.strip())


def hand_over(units: list[str], service: str | None = None) -> None:
    """Stops and disables the old systemd user units, and restarts the Stack's container of a long-running service so it runs the new release."""
    subprocess.run(["systemctl", "--user", "disable", "--now", *units], capture_output=True)
    if service:
        subprocess.run(["docker", "restart", f"{STACK}-{service}-1"], check=True, capture_output=True)
