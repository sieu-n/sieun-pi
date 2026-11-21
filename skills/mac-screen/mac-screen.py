#!/usr/bin/env python3
"""See and drive the owner's Mac screen through CuaDriver (cua-driver) over ssh."""

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOST = os.environ.get("MAC_SCREEN_HOST", "sieunpark@100.66.173.18")
LOCAL = sys.platform == "darwin"
DRIVER = "~/.local/bin/cua-driver"
START = f"{DRIVER} status >/dev/null 2>&1 || {{ /usr/bin/open -n -g -a CuaDriver --args serve; sleep 3; }}"
STATE = Path(tempfile.gettempdir()) / "mac-screen-last.json"


def sh(command, dry_run=False):
    argv = ["sh", "-c", command] if LOCAL else ["ssh", "-o", "ConnectTimeout=10", HOST, command]
    if dry_run:
        print(shlex.join(argv))
        return None
    done = subprocess.run(argv, capture_output=True, text=True)
    if done.returncode:
        sys.exit(f"mac-screen: {done.stderr.strip() or done.stdout.strip()} (exit {done.returncode})")
    return done.stdout


def call(tool, args=None, dry_run=False):
    out = sh(f"{START}; {DRIVER} call {tool} {shlex.quote(json.dumps(args or {}))}", dry_run)
    return None if dry_run else json.loads(out)


def front():
    app = next(a for a in call("list_apps")["apps"] if a.get("active"))
    windows = [w for w in call("list_windows", {"pid": app["pid"]})["windows"] if w["layer"] == 0]
    top = max(windows, key=lambda w: w["z_index"] or 0, default={})
    return {"app": app["name"], "bundle_id": app.get("bundle_id"), "pid": app["pid"],
            "window_id": top.get("window_id"), "title": top.get("title")}


def shot(out, max_dim):
    remote = f"/tmp/mac-screen-{os.getpid()}-{int(time.time())}.png"
    args = {"screenshot_out_file": remote, **({"max_image_dimension": max_dim} if max_dim is not None else {})}
    info = call("get_desktop_state", args)
    local = Path(out or Path(tempfile.gettempdir()) / f"mac-screen-{int(time.time())}.png").resolve()
    if LOCAL:
        os.replace(remote, local)
    else:
        subprocess.run(["scp", "-q", f"{HOST}:{remote}", str(local)], check=True)
        sh(f"rm -f {remote}")
    STATE.write_text(json.dumps({"capture_id": info["capture_id"]}))
    print(local)
    print(json.dumps({k: info[k] for k in ("screenshot_width", "screenshot_height", "screen_width", "screen_height", "scale_factor")}))


def last_capture():
    try:
        return json.loads(STATE.read_text())["capture_id"]
    except (OSError, ValueError, KeyError):
        sys.exit("mac-screen: take a shot first; x y are pixels of the last shot")


def main():
    p = argparse.ArgumentParser(prog="mac-screen", description=__doc__)
    p.add_argument("--dry-run", action="store_true", help="print the command and send nothing")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("shot", help="screenshot the main display and print the local PNG path")
    s.add_argument("out", nargs="?")
    s.add_argument("--max", type=int, help="long-edge cap in pixels, 0 for full size")
    sub.add_parser("front", help="frontmost app, pid, window id and title")
    c = sub.add_parser("click", help="click at x y pixels of the last shot")
    c.add_argument("x", type=float)
    c.add_argument("y", type=float)
    c.add_argument("--double", action="store_true")
    c.add_argument("--right", action="store_true")
    t = sub.add_parser("type", help="type text into the focused element of the frontmost app")
    t.add_argument("text")
    k = sub.add_parser("key", help="press a combo such as cmd+l, return or shift+tab in the frontmost app")
    k.add_argument("combo")
    r = sub.add_parser("call", help="run any cua-driver tool with JSON arguments")
    r.add_argument("tool")
    r.add_argument("json", nargs="?", default="{}")
    a = p.parse_args()

    if a.cmd == "shot":
        return shot(a.out, a.max)
    if a.cmd == "front":
        return print(json.dumps(front()))
    if a.cmd == "call":
        args = json.loads(a.json)
    elif a.cmd == "click":
        args = {"scope": "desktop", "x": a.x, "y": a.y, "capture_id": "<last shot>" if a.dry_run else last_capture(),
                "button": "right" if a.right else "left", "count": 2 if a.double else 1}
        a.tool = "click"
    else:
        args = {"pid": "<front pid>" if a.dry_run else front()["pid"]}
        if a.cmd == "type":
            a.tool, args["text"] = "type_text", a.text
        else:
            a.tool, args["keys"] = "hotkey", a.combo.lower().split("+")
            if len(args["keys"]) == 1:
                a.tool, args["key"] = "press_key", args.pop("keys")[0]
    out = call(a.tool, args, a.dry_run)
    if out is not None:
        print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
