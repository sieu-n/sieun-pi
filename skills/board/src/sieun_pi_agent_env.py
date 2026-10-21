"""Loads ~/.config/sieun-pi/agent.env into os.environ at the start of every kernel-venv Python, through the last line of
00_sieun_pi_skills.pth (components/user-history/scripts/kernel-skill-paths.ts). It lives beside the board package because the pin
already puts this folder on the path.

Why (10-21): the Prime daemon reads agent.env only when it starts, and each worker and kernel inherits the daemon's environment. The
daemon started at 11:19Z with the RAILWAY_API_TOKEN that Railway refused since 10-18, the file got a working token later that day, and
every job kernel still got the refused one until the daemon's next update restart. Reading the file again at kernel start gives each new
job the values the next daemon start would give, with no daemon restart.

The parse follows systemd's EnvironmentFile: KEY=VALUE lines, # and ; comment lines, and one pair of matching quotes around a value.
A missing or unreadable file leaves the environment as it is.
"""

import os
from pathlib import Path


def env_file() -> Path:
    return Path(os.environ.get("SIEUN_PI_AGENT_ENV") or Path.home() / ".config/sieun-pi/agent.env")


def parse(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;" or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key.isidentifier():
            values[key] = value
    return values


def load() -> dict[str, str]:
    try:
        values = parse(env_file().read_text())
    except (OSError, UnicodeDecodeError):
        return {}
    os.environ.update(values)
    return values


load()
