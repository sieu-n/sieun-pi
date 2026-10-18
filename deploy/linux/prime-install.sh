#!/bin/bash
# usage: prime-install.sh <feed-dir> <expect-version> [--rollback]
# Updates Prime Agent on this box from a local feed. It serves the feed on 127.0.0.1:57415 (the base URL the pack
# baked in), runs `systemctl --user reload --no-block prime-agent-daemon.service`, whose ExecReload
# (prime-agent-daemon-ctl update) runs `prime-agent update $PRIME_UPDATE_ARGS` inside the unit's own cgroup, aimed
# at the unit's socket, then confirms the systemd daemon runs the new build.
#
# The script re-runs itself detached (setsid, nohup, its own log) and returns at once with the log path, so its
# caller can exit or be killed without stopping the run. Prime's update prepare aborts a busy agent bash command
# after 5 s, which killed an attached run mid-wait and skipped its post-checks and env cleanup (p8, 10-18).
# The detached run writes <log>.result (`result=<ctl result> rc=<0|1>`) when it ends; the journal holds the same
# ctl line: `journalctl --user -u prime-agent-daemon | grep 'prime-agent-daemon-ctl: result='`.
#
# No transient systemd-run unit: systemd kills the new supervisor and its restored sessions when such a unit
# ends (sieun-pi 4ddea7bee).
# The updater's env comes from ~/.config/sieun-pi/prime-update.env, which the unit reads as an EnvironmentFile.
# This script writes it (0600) for this run only: the feed settings (PRIME_AGENT_DOWNLOAD_BASE_URL,
# PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS) and PRIME_UPDATE_ARGS=--force, or --rollback --force with --rollback.
# The ctl empties the file as soon as the reload starts, and this script empties it again on exit.
# --force answers Prime's busy-session confirmation, which refuses without a TTY. Prime then checkpoints the busy
# sessions and restores and resumes them on the new daemon; chat-057a approved that path on 10-18.
# --force does not override a prepare refusal, where the running daemon declines the restart because a worker is
# failed, disconnected or not ready. ctl prints `result=prepare-refused` and exits 4, the daemon keeps the old
# build, and this script stops and prints the reason.
# List the workers it names (prime-agent list --all --json). In mem.2 `prime-agent stop` tombstones the session (archiveOnStop),
# cancels its schedules and archives the transcript, so it is not failed-worker cleanup. Reopen a session that is still meant to run
# and still has its saved file (a reopen reclaims a stale descriptor); leave a session whose recovery state is unknown or whose file
# is missing untouched; stop only work someone marked finished or stopped. Until the refusal clears, do not update.
# Never restart prime-agent-daemon around the refusal: that aborts every running turn (c88).
#
# PRIME_INSTALL_UNIT and PRIME_INSTALL_FEED_PORT point a test run at a throwaway unit and port.
FEED="$1"; WANT="$2"; MODE="$3"; RC=0
UNIT=${PRIME_INSTALL_UNIT:-prime-agent-daemon}
PORT=${PRIME_INSTALL_FEED_PORT:-57415}
ENVF=~/.config/sieun-pi/prime-update.env
case "$MODE" in "") ARGS="--force";; --rollback) ARGS="--rollback --force";; *) echo "usage: prime-install.sh <feed-dir> <expect-version> [--rollback]" >&2; exit 2;; esac
[ -n "$WANT" ] && [ -d "$FEED" ] || { echo "usage: prime-install.sh <feed-dir> <expect-version> [--rollback]" >&2; exit 2; }
export PATH=$HOME/.local/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

if [ -z "$PRIME_INSTALL_LOG" ]; then
  mkdir -p ~/setup-logs
  PRIME_INSTALL_LOG=~/setup-logs/prime-install-$(date -u +%Y%m%dT%H%M%SZ).log
  export PRIME_INSTALL_LOG
  setsid -f nohup "$(readlink -f "$0")" "$FEED" "$WANT" $MODE > "$PRIME_INSTALL_LOG" 2>&1 < /dev/null
  echo "$PRIME_INSTALL_LOG"
  echo "The update runs detached. $PRIME_INSTALL_LOG.result holds 'result=<ctl result> rc=<0|1>' when it ends."
  echo "The journal line: journalctl --user -u $UNIT --since '$(date -u '+%Y-%m-%d %H:%M:%S') UTC' | grep 'prime-agent-daemon-ctl: result='"
  exit 0
fi

LOG=$PRIME_INSTALL_LOG
RESULT=
trap ': > "$ENVF"; [ -n "$SRV" ] && kill $SRV 2>/dev/null; echo "result=${RESULT:-none} rc=$RC" > "$LOG.result.tmp" && mv "$LOG.result.tmp" "$LOG.result"' EXIT
echo "before $(prime-agent --version) pid $(systemctl --user show -p MainPID --value $UNIT) args $ARGS"
readlink ~/.local/share/prime-agent/bin/prime-agent
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$FEED" >/dev/null 2>&1 & SRV=$!
sleep 1
( umask 077; mkdir -p "$(dirname "$ENVF")"; printf 'PRIME_AGENT_DOWNLOAD_BASE_URL=http://127.0.0.1:%s\nPRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS=1\nPRIME_UPDATE_ARGS=%s\n' "$PORT" "$ARGS" > "$ENVF" )
SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
# --no-block, because a blocking reload from a Prime session waits on the daemon that runs the session itself.
systemctl --user reload --no-block $UNIT.service
echo "reload queued, exit $?"
while [ "$(systemctl --user show -p ActiveState --value $UNIT)" = reloading ] || [ -n "$(systemctl --user list-jobs --no-legend $UNIT.service)" ]; do sleep 5; done
journalctl --user -u $UNIT --since "$SINCE" --no-pager > $LOG.update 2>&1; grep -v "^.*tar: Ignoring" $LOG.update | tail -20
: > "$ENVF"
RESULT=$(grep -o "prime-agent-daemon-ctl: result=[a-z-]*" $LOG.update | tail -1 | cut -d= -f2)
echo "ctl result ${RESULT:-none}"
readlink ~/.local/share/prime-agent/bin/prime-agent
NOW=$(prime-agent --version)
PID=$(systemctl --user show -p MainPID --value $UNIT)
RUNNING=$(readlink /proc/$PID/exe)
echo "after $NOW daemon pid $PID exe $RUNNING"
case "$RESULT" in
  ok) case "$RUNNING" in *"$WANT"*) echo "daemon on new build";; *) echo "ctl reported ok but the daemon runs $RUNNING"; RC=1;; esac;;
  prepare-refused) echo "prepare refused, daemon still old. --force does not clear this. Reopen named sessions still meant to run that have their saved file, leave unknown ones untouched, stop only work marked finished, and do not update until it clears:"; grep -h -e "Cannot prepare" -e "could not restart" -e "Could not prepare" $LOG.update; RC=1;;
  restore-failed-successor-adopted) echo "the coordinator's restore failed ($(grep -o 'result=restore-failed-successor-adopted restored [a-z0-9]* of [a-z0-9]*' $LOG.update | tail -1 | cut -d' ' -f2-)), and the unit adopted supervisor $PID, which runs $RUNNING. Prime's own recovery restores the rest; check the sessions before calling the update done."; RC=1;;
  busy-refused) echo "busy-session confirmation refused although PRIME_UPDATE_ARGS had --force; check that the unit loads $ENVF"; RC=1;;
  *) echo "update failed (${RESULT:-no ctl result}); see $LOG.update"; RC=1;;
esac
systemctl --user is-active $UNIT
exit $RC
