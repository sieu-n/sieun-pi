#!/bin/sh
# The hand-over rig: a copy of the apps/chat unit pair on its own port with the fixture host, whose main process mover.py keeps in a
# scope outside the unit's cgroup as cpu-protect.py does on us-metal02, then rig-test.mjs: 5 reloads under read and send load, writes in each
# hand-over window, kill -9 and SIGSTOP. It fails if the port refuses or resets a call, if more than one server runs on the data dir, or if a
# write is lost or doubled. Run on a Linux box with systemd --user, from anywhere:
#   apps/chat/scripts/handoff-rig/run.sh [<apps/chat dir to test>] [<out dir>]
# The report is <out dir>/report.json and the exit code is rig-test.mjs's. It never touches the live unit or port 5184.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CODE=${1:-$(cd "$HERE/../.." && pwd)}
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/apps-chat-handoff-rig-XXXXXX")}
PORT=${PORT:-5791}
U=apps-chat-handoff-copy.service
UNITS=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
DATA=$OUT/data
mkdir -p "$OUT/home" "$OUT/tmp" "$DATA" "$UNITS"
sed -e "s#@CODE@#$CODE#g" -e "s#@DATA@#$DATA#g" -e "s#@OUT@#$OUT#g" -e "s#@PORT@#$PORT#g" "$HERE/copy.service.template" > "$UNITS/$U"
printf '[Unit]\nDescription=apps/chat hand-over copy rig port 127.0.0.1:%s (throwaway)\n[Socket]\nListenStream=127.0.0.1:%s\n' "$PORT" "$PORT" > "$UNITS/apps-chat-handoff-copy.socket"
systemctl --user daemon-reload
systemctl --user restart apps-chat-handoff-copy.socket "$U"
sleep 6
systemd-run --user --unit=apps-chat-handoff-mover --collect -E PATH python3 -u "$HERE/mover.py" "$U"
sleep 6
node "$HERE/rig-test.mjs" "$U" "$PORT" "$DATA" 5 > "$OUT/report.json" 2>&1
code=$?
systemctl --user stop apps-chat-handoff-mover "$U" apps-chat-handoff-copy.socket
systemctl --user stop apps-chat-handoff-copy-core.scope 2>/dev/null
journalctl --user -u "$U" --since "-15 min" --no-pager -o short-iso-precise > "$OUT/journal.txt"
rm -f "$UNITS/$U" "$UNITS/apps-chat-handoff-copy.socket"
systemctl --user daemon-reload
echo "handoff rig: exit $code, report $OUT/report.json"
exit $code
