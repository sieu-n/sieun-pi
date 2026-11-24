"""usage: python3 -m usage_collector collect [--since 90d] [--loop SECONDS] [--dry-run] [--client NAME ...]

Reads every model call the clients on this host keep and writes it to the store's model_calls table (sink.py TABLE). A client with no saved cursor reads back to
--since; after that each pass reads only what is new. Cursors are kept per sink, so pointing sink.json at a new store backfills it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .core import Settings, Stats, discover, log, run
from .sink import Sink, SinkError
from .state import StateStore

CONFIG_DIR = Path("~/.config/usage-collector")
STATE_DIR = Path("~/.local/state/usage-collector")
UNITS_MS = {"d": 86_400_000, "h": 3_600_000, "m": 60_000, "s": 1000}


def since_ms(text: str, now_ms: int) -> int:
    match = re.fullmatch(r"(\d+)([dhms])", text)
    if match:
        return now_ms - int(match.group(1)) * UNITS_MS[match.group(2)]
    moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    moment = moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment
    return int(moment.timestamp() * 1000)


def default_host(config_dir: Path) -> str:
    """config.json's host, else the name LGTM's box label uses: mbp on the Mac, the short hostname elsewhere."""
    try:
        host = json.loads((config_dir / "config.json").read_text()).get("host")
        if host:
            return str(host)
    except (FileNotFoundError, ValueError):
        pass
    return "mbp" if sys.platform == "darwin" else socket.gethostname().split(".")[0]


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="usage_collector", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    collect = commands.add_parser("collect", help="read new model calls and write them to the sink")
    collect.add_argument("--since", default="90d", help="how far back a client with no cursor reads: 90d, 12h, or an ISO time")
    collect.add_argument("--loop", type=float, metavar="SECONDS", help="run again every SECONDS, per client")
    collect.add_argument("--dry-run", action="store_true", help="read and count from the sink's cursors, write nothing and save no cursor")
    collect.add_argument("--client", action="append", help="only this client (repeatable)")
    collect.add_argument("--config-dir", default=os.environ.get("USAGE_COLLECTOR_CONFIG", str(CONFIG_DIR)))
    collect.add_argument("--state-dir", default=os.environ.get("USAGE_COLLECTOR_STATE", str(STATE_DIR)))
    collect.add_argument("--sink", help="sink config file; default <config dir>/sink.json")
    collect.add_argument("--host", help="host name on every row; default config.json's host, else mbp on macOS, else the short hostname")
    collect.add_argument("--home", default=str(Path.home()), help="the home folder the clients read")
    args = parser.parse_args(argv)

    config_dir = Path(args.config_dir).expanduser()
    host = args.host or default_host(config_dir)
    try:
        sink = Sink.load(Path(args.sink).expanduser() if args.sink else config_dir / "sink.json")
    except SinkError as error:
        log(str(error))
        return 2
    modules = discover(args.client)
    if not modules:
        log("no client modules matched")
        return 2
    settings = Settings(host=host, since_ms=lambda: since_ms(args.since, int(time.time() * 1000)), home=Path(args.home).expanduser(),
                        sink=sink, store=StateStore(Path(args.state_dir).expanduser() / sink.id), dry_run=args.dry_run,
                        max_bytes=sink.max_body_bytes, parallel=sink.parallel_posts)
    def report(client: str, stats: Stats) -> None:
        if args.loop and not stats.rows:
            return
        line = {"client": client, "host": host, "rows": stats.rows, "posts": stats.posts, "bad": stats.bad, "first": stats.first,
                "last": stats.last, "cost_usd": round(stats.cost_usd, 6), "tokens": stats.tokens, "seconds": stats.seconds,
                "dry_run": args.dry_run}
        print(json.dumps(line), flush=True)

    log(f"collect as {host}: {', '.join(m.CLIENT for m in modules)}" + (f", every {args.loop:g} s" if args.loop else ""))
    failed = run(modules, settings, args.loop, report)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
