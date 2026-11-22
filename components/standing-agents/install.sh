#!/bin/bash
# install.sh - install the standing-agent wake files on us-metal02 (moved from the Mac's launchd on 2026-10-19). Copies wake.sh and
# the manifest to ~/.prime/agent/standing-agents/ (this repo dir stays canonical; re-run after any edit). Each kind=wake entry runs
# from the Komodo Procedure m02-<name>-wake, which starts the job service <name>-wake of the Stack box-sieun-pi in auto-sns-agent
# apps/infra/box/compose.sieun-pi.yml at the `fires` time (Procedure schedules in apps/infra/komodo/stacks.json, UTC). This script
# fails for an entry that has no such job service, because then nothing wakes it. DEST and COMPOSE override the paths.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${DEST:-$HOME/.prime/agent/standing-agents}"
COMPOSE="${COMPOSE:-$HOME/Documents/Github/auto-sns-agent/apps/infra/box/compose.sieun-pi.yml}"
mkdir -p "$DEST/logs"
cp "$HERE/wake.sh" "$HERE/standing-agents.json" "$DEST/"
chmod +x "$DEST/wake.sh"
python3 - "$HERE/standing-agents.json" "$COMPOSE" <<'PY'
import json, re, sys
manifest, compose = sys.argv[1:]
text = open(compose).read()
missing = [a["name"] for a in json.load(open(manifest))["agents"]
           if a.get("kind") == "wake" and not re.search(rf"^  {re.escape(a['name'])}-wake:$", text, re.M)]
if missing:
    sys.exit(f"no job service {', '.join(n + '-wake' for n in missing)} in {compose}; add it and its Procedure m02-<name>-wake")
PY
echo "installed; the Komodo Procedures m02-<name>-wake run the wakes; check: tail $DEST/wakes.jsonl"
