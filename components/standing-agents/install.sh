#!/bin/bash
# install.sh - install the standing-agent wake mechanism on us-metal02 (moved from the Mac's
# launchd on 2026-10-19). Copies wake.sh and the manifest to ~/.prime/agent/standing-agents/
# (this repo dir stays canonical; re-run after any edit) and writes one systemd --user service
# plus timer per kind=wake entry: <name>-wake.service / <name>-wake.timer, OnCalendar from
# `fires` in UTC, Persistent so a fire missed while the box was down runs at boot.
# UNITS_DIR and DEST override the targets; NO_ENABLE=1 writes files only (used to diff against
# the live units without touching them).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${DEST:-$HOME/.prime/agent/standing-agents}"
UNITS_DIR="${UNITS_DIR:-$HOME/.config/systemd/user}"
mkdir -p "$DEST/logs" "$UNITS_DIR"
cp "$HERE/wake.sh" "$HERE/standing-agents.json" "$DEST/"
chmod +x "$DEST/wake.sh"
NAMES="$(python3 - "$HERE/standing-agents.json" "$DEST" "$UNITS_DIR" "$HOME" <<'PY'
import json, sys
manifest, dest, units, home = sys.argv[1:]
for a in json.load(open(manifest))["agents"]:
    if a.get("kind") != "wake":
        continue
    n = a["name"]
    cal = "\n".join(f"OnCalendar=*-*-* {f['hour']:02d}:{f['minute']:02d}:00 UTC" for f in a["fires"])
    open(f"{units}/{n}-wake.service", "w").write(
        f"[Unit]\nDescription=Daily wake for the {n} standing agent\n\n[Service]\nType=simple\n"
        f"Environment=HOME={home} NO_COLOR=1 PATH={home}/.local/bin:{home}/.local/node/bin:/usr/local/bin:/usr/bin:/bin\n"
        f"ExecStart=/bin/bash {dest}/wake.sh {n}\n"
        f"StandardOutput=append:{dest}/logs/systemd-{n}.out.log\n"
        f"StandardError=append:{dest}/logs/systemd-{n}.err.log\n")
    open(f"{units}/{n}-wake.timer", "w").write(
        f"[Unit]\nDescription=Daily wake for {n}\n\n[Timer]\n{cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n")
    print(n)
PY
)"
[ "${NO_ENABLE:-}" = 1 ] && { echo "wrote units for: $NAMES"; exit 0; }
systemctl --user daemon-reload
for n in $NAMES; do systemctl --user enable --now "$n-wake.timer"; done
echo "installed; check: systemctl --user list-timers | grep wake"
