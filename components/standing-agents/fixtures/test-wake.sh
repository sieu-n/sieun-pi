#!/bin/bash
# test-wake.sh - fixtures for wake.sh: the guard must fire on the burning cases and stay
# quiet on the known-good ones. A stub prime-agent on PATH records its argv, so nothing is
# billed. Run from anywhere. Exits 0 only if every probe passes. Cleans up after itself.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WAKE="$HERE/../wake.sh"
WORK="$(mktemp -d)"
FAILS=0
fail() { echo "FAIL: $1"; FAILS=$((FAILS+1)); }
pass() { echo "ok: $1"; }

sed "s#FIXTURE_DIR#$WORK#g" "$HERE/fixture.json" > "$WORK/manifest.json"
mkdir -p "$WORK/resume" "$WORK/state" "$WORK/bin"
echo '{"type":"session","id":"old"}' > "$WORK/resume/old.jsonl"; sleep 1
echo '{"type":"session","id":"new"}' > "$WORK/resume/new.jsonl"
echo "FIXTURE_BIRTH_MESSAGE" > "$WORK/birth.md"
cat > "$WORK/bin/prime-agent" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$WORK/argv.txt"
echo \$\$ > "$WORK/stub.pid"
echo x >> "$WORK/calls.txt"
[ -n "\${FIXTURE_HANG:-}" ] && sleep 30
if [ "\$(wc -l < "$WORK/calls.txt")" -le "\${FIXTURE_FAIL:-0}" ]; then echo "\${FIXTURE_ERR:-boom}"; exit 1; fi
echo STUB_REPLY
STUB
chmod +x "$WORK/bin/prime-agent"
export PATH="$WORK/bin:$PATH"

# A fake daemon: a socket file plus a process whose argv matches the guard.
SOCK="$WORK/daemon.sock"
python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$SOCK"
python3 -c "import time; time.sleep(120)" --mode daemon --daemon-socket "$SOCK" &
DAEMON_PID=$!
cleanup() { { kill "$DAEMON_PID"; wait "$DAEMON_PID"; } 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

run() { "$WAKE" --manifest "$WORK/manifest.json" --state-dir "$WORK/state" --daemon-socket "$1" "$2" >/dev/null 2>&1; }

# Probe 1, resume: the newest transcript is resumed with the manifest message.
run "$SOCK" fixture-resume
if grep -qx -- "-r" "$WORK/argv.txt" && grep -q "resume/new.jsonl" "$WORK/argv.txt"; then pass "resume: newest transcript resumed"; else fail "resume: wrong or missing -r target"; fi
if grep -q "FIXTURE_WAKE_MESSAGE" "$WORK/argv.txt"; then pass "resume: manifest message delivered"; else fail "resume: message missing"; fi
if grep -q '"action": "done", "detail": "rc=0' "$WORK/state/wakes.jsonl"; then pass "resume: done rc=0 recorded"; else fail "resume: no done record"; fi
if grep -q STUB_REPLY "$WORK"/state/logs/wake-fixture-resume-*.log; then pass "resume: reply captured in the log"; else fail "resume: log empty"; fi

# Probe 2, birth: no transcript -> the birth message starts a session in session_dir.
rm -f "$WORK/argv.txt"
run "$SOCK" fixture-birth
if grep -qx -- "--session-dir" "$WORK/argv.txt" && grep -q "FIXTURE_BIRTH_MESSAGE" "$WORK/argv.txt"; then pass "birth: new session from the birth message"; else fail "birth: wrong argv"; fi
if grep -q '"action": "birth"' "$WORK/state/wakes.jsonl"; then pass "birth: recorded"; else fail "birth: no record"; fi

# Probe 3, no daemon: the wake must skip, never call prime-agent (a launchd-started daemon has no TCC).
rm -f "$WORK/argv.txt"
run "$WORK/absent.sock" fixture-resume
if [ ! -e "$WORK/argv.txt" ] && grep -q '"action": "skipped_no_daemon"' "$WORK/state/wakes.jsonl"; then pass "no daemon: skipped without calling prime-agent"; else fail "no daemon: prime-agent was called or no skip record"; fi

# Probe 4, lock: a second fire while one wake runs is skipped.
rm -f "$WORK/argv.txt"
FIXTURE_HANG=1 "$WAKE" --manifest "$WORK/manifest.json" --state-dir "$WORK/state" --daemon-socket "$SOCK" fixture-resume >/dev/null 2>&1 &
FIRST=$!; sleep 1
run "$SOCK" fixture-resume
if grep -q '"action": "skipped_running"' "$WORK/state/wakes.jsonl"; then pass "lock: concurrent fire skipped"; else fail "lock: concurrent fire ran"; fi
{ kill "$(cat "$WORK/stub.pid")" "$FIRST"; wait "$FIRST"; } 2>/dev/null

# Probe 5, retry: a provider 403 is retried after WAKE_RETRY_DELAY and the second try succeeds.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR="Provider denied access to the requested resource (permission_error, 403): OAuth authentication is currently not allowed for this organization." WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q '"retry_scheduled", "detail": "attempt=1 error=provider_403' "$WORK/state/wakes.jsonl" && grep -q '"detail": "rc=0' "$WORK/state/wakes.jsonl"; then pass "retry: 403 retried once, then rc=0"; else fail "retry: 403 not retried"; fi

# Probe 6, no retry: an unknown failure is recorded as error=other and never retried.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR="TypeError in my own code" WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 1 ] && grep -q 'error=other' "$WORK/state/wakes.jsonl" && ! grep -q retry_scheduled "$WORK/state/wakes.jsonl"; then pass "retry: other failure not retried"; else fail "retry: other failure retried or unrecorded"; fi

# Probe 7, cap: persistent rate limits stop after WAKE_RETRIES retries.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=9 FIXTURE_ERR="Provider rate limit exceeded (rate_limit_error, 429)" WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 3 ] && [ "$(grep -c 'error=rate_limit' "$WORK/state/wakes.jsonl")" -ge 3 ]; then pass "retry: capped at 2 retries"; else fail "retry: cap not applied"; fi

# Probe 8, transient: an EINTR from the client is retried like a provider error.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR="Error: Cannot use cwd /x: EINTR: interrupted system call, getcwd '/' -> '/x'" WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q 'error=transient' "$WORK/state/wakes.jsonl"; then pass "retry: EINTR retried"; else fail "retry: EINTR not retried"; fi

# Probe 9, daemon timeout: a client that times out waiting for the daemon is retried as transient.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR='error: Timed out after 30000ms waiting for the Prime Agent daemon response to "create". Socket: /x/daemon.sock.' WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q 'error=transient' "$WORK/state/wakes.jsonl"; then pass "retry: daemon timeout retried"; else fail "retry: daemon timeout not retried"; fi

# Probe 10, daemon restart: a supervisor shutdown mid-turn is retried as transient.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR='Daemon supervisor generation b3214ee9-7f60 is shutting down; retry the command' WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q 'error=transient' "$WORK/state/wakes.jsonl"; then pass "retry: daemon restart retried"; else fail "retry: daemon restart not retried"; fi

# Probe 11, cwd fallback: after "Cannot use cwd" the retry runs with --cwd $HOME.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"; mkdir -p "$WORK/home"
HOME="$WORK/home" FIXTURE_FAIL=1 FIXTURE_ERR="Error: Cannot use cwd /x: EINTR: interrupted system call, getcwd '/' -> '/x'" WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -A1 -x -- "--cwd" "$WORK/argv.txt" | grep -qx "$WORK/home"; then pass "retry: cwd falls back to HOME"; else fail "retry: cwd not changed on retry"; fi

# Probe 12, pool slot: a 429 that names a pi-pool slot waits until that slot, not the fixed delay.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
SLOT_AT="$(date -u -d '+90 seconds' +%Y-%m-%dT%H:%M:%S.000Z)"
FIXTURE_FAIL=1 FIXTURE_ERR="Provider rate limit exceeded (rate_limit_error, 429) pi-pool: claude7 is limited; this session waits for its slot at $SLOT_AT." WAKE_RETRY_DELAY=0 timeout 5 "$WAKE" --manifest "$WORK/manifest.json" --state-dir "$WORK/state" --daemon-socket "$SOCK" fixture-resume >/dev/null 2>&1
if grep -qE '"retry_scheduled", "detail": "attempt=1 error=rate_limit in=1[45][0-9]s' "$WORK/state/wakes.jsonl"; then pass "retry: waits for the named pool slot"; else fail "retry: ignored the pool slot"; fi

# Probe 13, daemon update restart: the turn that dies on an update restart is retried as transient.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR='Daemon is preparing an update restart' WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q 'error=transient' "$WORK/state/wakes.jsonl"; then pass "retry: daemon update restart retried"; else fail "retry: daemon update restart not retried"; fi

# Probe 14, precheck: the manifest's precheck runs before prime-agent, and a failed one still lets the wake resume.
rm -f "$WORK/calls.txt" "$WORK/pre.txt"; : > "$WORK/state/wakes.jsonl"
run "$SOCK" fixture-precheck
if grep -qx before "$WORK/pre.txt" 2>/dev/null && grep -q '"action": "precheck", "detail": "rc=0' "$WORK/state/wakes.jsonl" && [ "$(wc -l < "$WORK/calls.txt")" -eq 1 ]; then pass "precheck: ran before the resume"; else fail "precheck: did not run before the resume"; fi
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
run "$SOCK" fixture-precheck-fail
if grep -q '"action": "precheck", "detail": "rc=3' "$WORK/state/wakes.jsonl" && grep -q '"action": "done", "detail": "rc=0' "$WORK/state/wakes.jsonl"; then pass "precheck: a failed precheck still resumes"; else fail "precheck: a failed precheck stopped the wake"; fi

# Probe 15, stale input: a prompt that a dead wake left in accepted-input.json is moved aside before the resume.
ART="$WORK/session-artifacts/new"; mkdir -p "$ART" "$WORK/prime"
STALE='{"version":1,"ownerStopped":false,"records":[{"operationId":"op-1","state":"delivered","action":{"id":"op-1","payload":{"kind":"turn","text":"OLD_WAKE","records":[{"role":"primary","message":{"role":"user","timestamp":1794354365490}}]}}}]}'
echo "$STALE" > "$ART/accepted-input.json"
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
PRIME_AGENT_CODING_AGENT_DIR="$WORK/prime" run "$SOCK" fixture-resume
if [ ! -e "$ART/accepted-input.json" ] && ls "$ART"/accepted-input.json.stale-* >/dev/null 2>&1 && grep -q '"action": "stale_input_cleared", "detail": "moved=.*op-1 state=delivered sent=2026-11-10T23:46:05Z' "$WORK/state/wakes.jsonl" && grep -q '"action": "done", "detail": "rc=0' "$WORK/state/wakes.jsonl"; then pass "stale input: moved aside and recorded, then rc=0"; else fail "stale input: not moved or not recorded"; fi

# Probe 16, live owner: a pending prompt stays when a live process holds the session's lease.
echo "$STALE" > "$ART/accepted-input.json"
LEASE="$WORK/prime/session-leases/$(python3 -c 'import hashlib,os,sys; print(hashlib.sha256(os.path.realpath(sys.argv[1]).encode()).hexdigest())' "$WORK/resume/new.jsonl").lock"
mkdir -p "$LEASE"; echo "{\"version\":1,\"pid\":$DAEMON_PID}" > "$LEASE/owner.json"
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
PRIME_AGENT_CODING_AGENT_DIR="$WORK/prime" run "$SOCK" fixture-resume
if [ -e "$ART/accepted-input.json" ] && grep -q '"action": "stale_input_kept"' "$WORK/state/wakes.jsonl"; then pass "stale input: kept while a live process holds the lease"; else fail "stale input: moved although the session is live"; fi
rm -rf "$LEASE" "$ART"

# Probe 17, busy: "Agent is already processing" is classified busy and retried.
rm -f "$WORK/calls.txt"; : > "$WORK/state/wakes.jsonl"
FIXTURE_FAIL=1 FIXTURE_ERR="Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." WAKE_RETRY_DELAY=0 run "$SOCK" fixture-resume
if [ "$(wc -l < "$WORK/calls.txt")" -eq 2 ] && grep -q 'error=busy' "$WORK/state/wakes.jsonl" && grep -q '"detail": "rc=0' "$WORK/state/wakes.jsonl"; then pass "retry: busy session retried"; else fail "retry: busy session not retried"; fi

if [ "$FAILS" -gt 0 ]; then echo "$FAILS probe(s) failed"; exit 1; fi
echo "all probes passed"
