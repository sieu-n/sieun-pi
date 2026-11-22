#!/bin/bash
# wake.sh <agent> - deliver one scheduled wake to a standing agent's saved session.
#
# On us-metal02 the Komodo Procedure m02-harness-keeper-wake runs this in a container of the Stack box-sieun-pi (moved from the Mac launchd job
# com.sieun.wake-harness-keeper on 10-19, and from a systemd --user timer on 11-22).
# It resumes the newest transcript in the entry's session_dir with `prime-agent -p -r`, so the
# agent keeps its history and harness without a live chat session, a tmux pane, or an
# rlm_heartbeat. Those three all died with worker restarts, daemon restarts and reboots
# (seo wakes dead since 2026-09-16, harness-keeper since 09-08); launchd replays a missed
# calendar fire at machine wake, so sleep costs a delay, not the day.
#
# Two guards. A launchd process has no TCC grant for ~/Documents, and a prime-agent client
# with no daemon would start one in this context and poison every later worker, so the wake
# only runs when a user-started daemon already listens on the daemon socket. A per-agent lock
# keeps two fires from resuming one session at once.
#
# Fixtures: fixtures/test-wake.sh proves the resume, the birth, the lock, the no-daemon
# skip, the provider-error retry, and the stale-input recovery. Run it after any edit, then
# install.sh. This folder is canonical in sieun-pi components/standing-agents since 2026-11-20;
# ~/.pi/agent/agents/standing-agents links to it.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$HERE/standing-agents.json"
STATE_DIR="$HOME/.prime/agent/standing-agents"
DAEMON_SOCK="/tmp/prime-agent-$(id -u)/daemon.sock"  # us-metal02 (moved from the Mac 10-19)
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --daemon-socket) DAEMON_SOCK="$2"; shift 2 ;;
    -*) echo "usage: wake.sh [--manifest f] [--state-dir d] [--daemon-socket s] <agent>" >&2; exit 2 ;;
    *) NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] || { echo "usage: wake.sh <agent>" >&2; exit 2; }
mkdir -p "$STATE_DIR/logs"
LOG="$STATE_DIR/wakes.jsonl"

record() { # record <action> <detail>
  python3 - "$LOG" "$NAME" "$1" "$2" <<'PY'
import json, sys, datetime
line = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "agent": sys.argv[2], "action": sys.argv[3], "detail": sys.argv[4]}
open(sys.argv[1], "a").write(json.dumps(line) + "\n")
PY
}

PROMPT_FILE="$STATE_DIR/wake-$NAME.prompt"
ENTRY="$(python3 - "$MANIFEST" "$NAME" "$PROMPT_FILE" <<'PY'
import json, os, sys
manifest, name, prompt_file = sys.argv[1:]
entry = next((a for a in json.load(open(manifest))["agents"] if a["name"] == name), None)
if entry is None or entry.get("kind") != "wake":
    sys.exit(f"no wake entry named {name!r} in {manifest}")
session_dir = os.path.expanduser(entry["session_dir"])
files = sorted((f for f in os.listdir(session_dir) if f.endswith(".jsonl")),
               key=lambda f: os.path.getmtime(os.path.join(session_dir, f))) if os.path.isdir(session_dir) else []
session = os.path.join(session_dir, files[-1]) if files else ""
birth = os.path.expanduser(entry.get("birth", ""))
text = entry["message"] if session or not birth else open(birth).read()
open(prompt_file, "w").write(text)
print(session_dir); print(session); print(entry["cwd"]); print(birth); print(entry.get("precheck", ""))
PY
)" || { record "manifest_error" "$ENTRY"; echo "$ENTRY" >&2; exit 2; }
SESSION_DIR="$(sed -n 1p <<<"$ENTRY")"
SESSION="$(sed -n 2p <<<"$ENTRY")"
CWD="$(sed -n 3p <<<"$ENTRY")"
BIRTH="$(sed -n 4p <<<"$ENTRY")"
PRECHECK="$(sed -n 5p <<<"$ENTRY")"

daemon_pid() { ps -axo pid=,args= | grep -F -- "--mode daemon --daemon-socket $DAEMON_SOCK" | grep -v grep | awk 'NR==1{print $1}'; }
if ! [ -S "$DAEMON_SOCK" ] || [ -z "$(daemon_pid)" ]; then
  record "skipped_no_daemon" "no user-started prime-agent daemon on $DAEMON_SOCK; start prime-agent from a terminal"
  exit 0
fi
if [ -z "$SESSION" ] && [ -z "$BIRTH" ]; then
  record "session_missing" "no transcript in $SESSION_DIR and no birth message"
  exit 1
fi

LOCK="$STATE_DIR/wake-$NAME.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || echo 0)"
  if kill -0 "$holder" 2>/dev/null; then
    record "skipped_running" "wake pid $holder still running"
    exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# A wake that dies mid-turn leaves its prompt in the session's accepted-input.json, and Prime
# redelivers that prompt when the next wake opens the session. The new prompt_and_wait then fails
# with "Agent is already processing", and the print client shuts the worker down before the old
# prompt runs, so the file never clears. The 11-10 wake hit the client's 24 h timeout this way,
# and the next 11 fires each failed in 3 s. The lock above proves no other wake runs. When no
# live process holds the session's lease either, move the file aside, since today's prompt
# repeats the old one, and record what moved.
PRIME_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
clear_stale_input() {
  [ -n "$SESSION" ] || return 0
  local out
  out="$(python3 - "$SESSION" "$PRIME_DIR" <<'PY'
import datetime, hashlib, json, os, sys
session, prime_dir = sys.argv[1:]
sid = os.path.basename(session)[: -len(".jsonl")]
path = os.path.join(os.path.dirname(os.path.dirname(session)), "session-artifacts", sid, "accepted-input.json")
try:
    records = json.load(open(path)).get("records", [])
except (OSError, ValueError):
    sys.exit(0)
pending = [r for r in records if r.get("state") != "completed"]
if not pending:
    sys.exit(0)
lease = os.path.join(prime_dir, "session-leases", hashlib.sha256(os.path.realpath(session).encode()).hexdigest() + ".lock", "owner.json")
try:
    pid = int(json.load(open(lease))["pid"])
    os.kill(pid, 0)
    print(f"stale_input_kept\tpid {pid} holds {lease}; {len(pending)} pending record(s) left in {path}")
    sys.exit(0)
except (OSError, ValueError, KeyError, TypeError):
    pass
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
moved = f"{path}.stale-{stamp}"
os.rename(path, moved)
def describe(r):
    payload = r.get("action", {}).get("payload", {})
    first = next((x.get("message", {}) for x in payload.get("records", []) if x.get("role") == "primary"), {})
    at = first.get("timestamp")
    when = datetime.datetime.fromtimestamp(at / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(at, (int, float)) else "?"
    return f"{r.get('operationId')} state={r.get('state')} sent={when} text={(payload.get('text') or '')[:60]!r}"
print("stale_input_cleared\t" + f"moved={moved} records={len(pending)}: " + "; ".join(describe(r) for r in pending))
PY
)" || { record "stale_input_error" "could not check accepted input for $SESSION"; return 0; }
  [ -n "$out" ] && record "${out%%$'\t'*}" "${out#*$'\t'}"
  return 0
}

# A precheck runs the slow, mechanical part of a wake here, before the agent starts, because a
# headless turn cannot outlive one tool call: on 11-04 the kernel handed a 3-minute transcript scan
# off after 120 s, the turn ended, the headless run exited, the scan died with it and the day had no
# report. The agent reads what the precheck wrote. A failed precheck is recorded and never stops the wake.
if [ -n "$PRECHECK" ]; then
  PRE_LOG="$STATE_DIR/logs/precheck-$NAME-$(date +%Y%m%d-%H%M%S).log"
  PRE_START=$(date +%s)
  (cd "$CWD" 2>/dev/null || cd "$HOME"; bash -c "$PRECHECK") >"$PRE_LOG" 2>&1
  record "precheck" "rc=$? seconds=$(( $(date +%s) - PRE_START )) log=$PRE_LOG"
fi

# Provider errors (rate limit, a refused pool account, a failed pi-pool token lookup) kill a
# wake in seconds and cost the whole day: five of the first eight harness-keeper wakes
# (2026-09-22 to 09-28) died this way. A getcwd EINTR after a 44-minute hang killed 10-01's; a 30 s daemon 'create' timeout killed 10-09's; a daemon restart mid-turn killed 10-12's. pi-pool cools a refused account down, so a retry after
# WAKE_RETRY_DELAY seconds usually lands on another account. Other failures are not retried.
RETRIES="${WAKE_RETRIES:-2}"
DELAY="${WAKE_RETRY_DELAY:-1800}"
classify() { # classify <log> -> provider error class, or "other". Only the log tail: prime-agent
  # prints the fatal error last, and the reply above it may quote old errors (09-23 log did).
  local T; T="$(tail -n 6 "$1")"
  if grep -q "rate_limit_error\|(429)\|, 429)" <<<"$T"; then echo rate_limit
  elif grep -q "permission_error, 403\|OAuth authentication is currently not allowed" <<<"$T"; then echo provider_403
  elif grep -q "Failed to resolve API key" <<<"$T"; then echo api_key
  elif grep -qi "overloaded_error\|(529)\|, 529)" <<<"$T"; then echo overloaded
  elif grep -q "Agent is already processing" <<<"$T"; then echo busy
  elif grep -q "EINTR\|ECONNRESET\|ETIMEDOUT\|ENOTFOUND\|fetch failed\|waiting for the Prime Agent daemon response\|Daemon supervisor generation .* is shutting down\|Daemon is preparing an update restart" <<<"$T"; then echo transient
  else echo other; fi
}
newest_session() {
  ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1
}
ATTEMPT=0
while :; do
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUT="$STATE_DIR/logs/wake-$NAME-$STAMP.log"
  START=$(date +%s)
  [ -n "$SESSION" ] || SESSION="$(newest_session)"
  if [ -n "$SESSION" ]; then
    clear_stale_input
    record "resume" "session=$SESSION log=$OUT attempt=$ATTEMPT"
    prime-agent -p --provider anthropic --model claude-opus-5-5 --cwd "$CWD" -r "$SESSION" "$(cat "$PROMPT_FILE")" >"$OUT" 2>&1
  else
    mkdir -p "$SESSION_DIR"
    record "birth" "session_dir=$SESSION_DIR birth=$BIRTH log=$OUT attempt=$ATTEMPT"
    prime-agent -p --provider anthropic --model claude-opus-5-5 --cwd "$CWD" --session-dir "$SESSION_DIR" "$(cat "$PROMPT_FILE")" >"$OUT" 2>&1
  fi
  RC=$?
  if [ "$RC" -eq 0 ]; then
    record "done" "rc=0 seconds=$(( $(date +%s) - START )) log=$OUT"
    exit 0
  fi
  CLASS="$(classify "$OUT")"
  record "done" "rc=$RC error=$CLASS seconds=$(( $(date +%s) - START )) log=$OUT"
  if [ "$CLASS" = other ] || [ "$ATTEMPT" -ge "$RETRIES" ]; then
    exit "$RC"
  fi
  # The client sometimes cannot getcwd the repo under ~/Documents (EINTR), and the same folder
  # fails again on every retry in that sitting (10-01, 10-11, 10-17). Retry from $HOME; the wake
  # text names the repo and the agent changes directory itself.
  if grep -q "Cannot use cwd" <<<"$(tail -n 6 "$OUT")"; then CWD="$HOME"; fi
  ATTEMPT=$((ATTEMPT + 1))
  WAIT=$(( DELAY * (1 << (ATTEMPT - 1)) ))  # 30 min, then 60: three 429s inside one hour on 09-30
  # pi-pool names the slot it waits for ("waits for its slot at 2026-10-23T03:00:01.000Z"); on
  # 10-22 and 10-23 both retries fired before that slot and failed. Wait for the slot instead.
  SLOT="$(grep -o 'waits for its slot at [0-9TZ:.-]*' "$OUT" | tail -1 | awk '{print $NF}' | sed 's/\.$//')"
  if [ -n "$SLOT" ] && SLOT_S=$(date -d "$SLOT" +%s 2>/dev/null); then
    UNTIL=$(( SLOT_S - $(date +%s) + 60 ))
    [ "$UNTIL" -gt "$WAIT" ] && WAIT=$UNTIL
  fi
  record "retry_scheduled" "attempt=$ATTEMPT error=$CLASS in=${WAIT}s"
  sleep "$WAIT"
done
