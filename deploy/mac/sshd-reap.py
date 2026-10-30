#!/usr/bin/python3
"""End this user's sshd sessions on the Mac whose client is gone.

On 2026-10-23 fresh ssh logins from us-metal02 to the Mac failed: 38 sshd sessions whose box side had died while
the Mac slept filled launchd's limit of 42 sshd copies. The Mac's sshd sends nothing on an idle session
(ClientAliveInterval 0), so it never notices a client that left while the Mac could not hear the FIN. The server-side
fix (ClientAliveInterval in sshd_config) needs sudo and is the owner's todo t100; this agent works with or without it.

launchd agent ai.virev.sshd-reap keeps this running as the user (KeepAlive), without sudo. Every TICK_S it compares
the wall clock with the monotonic clock, which stops while the Mac sleeps. A run starts every INTERVAL_S, and at once
when the Mac slept more than SLEPT_S since the last tick. After such a wake it runs every tick until a run reaches
every PEER_SSH host it had to ask, since the network comes back some seconds after the wake. On 10-30 the Mac slept from 18:38Z 10-29 to a lid wake at 11:13:22Z,
launchd's StartInterval 300 ran the old one-shot version only at 02:45Z and 10:52Z in dark wakes and not yet at
11:13:48Z, so 42 sessions held launchd's limit and 40% of fresh box logins got "kex_exchange_identification".
Each run:
  1. lists this user's sshd sessions (sshd-session: <user>, or <user>@<tty> once a channel opened), skipping the
     session this run is part of;
  2. reads each session's TCP socket and state from lsof and its received bytes from netstat -anb;
  3. marks a session dead when it has no ESTABLISHED socket, or when no byte arrived since the last run and the peer
     host, asked over ssh, holds no TCP connection with that 4-tuple;
  4. ends every dead session whose received bytes last changed DEAD_FOR_S or more ago at once (SIGTERM to all, then
     SIGKILL to any left after 5 s).
A received-bytes change is seen only at a run, so a dead session ends 10 to 15 minutes after its last byte.
A session whose bytes move, whose peer still holds the connection, or whose peer cannot be asked is kept.
Box clients send a keepalive every 15 s (ServerAliveInterval 15 in sieun-pi deploy/linux/ssh-mac.conf), so a live
box session always shows new bytes between runs.
The peer check sees only the peer's host network namespace, so a live session from a container on the peer that
also sends nothing for DEAD_FOR_S would be ended; the received-bytes check is what keeps keepalive clients safe.

Install (from sieun-pi on a box that reaches the Mac):
  ssh mac 'mkdir -p ~/.local/share/sshd-reap ~/.local/state/sshd-reap'
  scp deploy/mac/sshd-reap.py mac:.local/share/sshd-reap/sshd-reap.py
  scp deploy/mac/ai.virev.sshd-reap.plist mac:Library/LaunchAgents/
  ssh mac 'launchctl bootout gui/$(id -u)/ai.virev.sshd-reap; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.virev.sshd-reap.plist'
Log: ~/.local/state/sshd-reap/log.jsonl, one JSON line per run (with why it ran), per wake and per ended session.
`sshd-reap.py --once` does one run and exits. `sshd-reap.py --dry-run` prints what one run would end, without ending
it, logging or saving state.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

DEAD_FOR_S = 600
TICK_S = 5
INTERVAL_S = 300
SLEPT_S = 30
PEER_SSH = {"100.83.139.73": "us-metal02"}
STATE_DIR = os.path.expanduser("~/.local/state/sshd-reap")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
LOG_FILE = os.path.join(STATE_DIR, "log.jsonl")
USER = os.environ.get("USER") or subprocess.run(["/usr/bin/id", "-un"], capture_output=True, text=True).stdout.strip()
SESSION_RE = re.compile(r"^sshd(?:-session)?: ([^\s@]+)(?:@\S+)?\s*$")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(entry, dry_run):
    line = json.dumps({"ts": now_iso(), **entry})
    if dry_run:
        print(line)
        return
    with open(LOG_FILE, "a") as fh:
        fh.write(line + "\n")


def run(cmd, timeout=30):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def processes():
    out = run(["/bin/ps", "-axo", "pid=,ppid=,user=,command="]).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            procs[int(parts[0])] = {"ppid": int(parts[1]), "user": parts[2], "command": parts[3]}
    return procs


def ancestors(procs, pid):
    seen = set()
    while pid in procs and pid not in seen and pid > 1:
        seen.add(pid)
        pid = procs[pid]["ppid"]
    return seen


def sockets(pids):
    """pid -> (local, peer, state) of its first TCP socket, from lsof."""
    if not pids:
        return {}
    out = run(["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(map(str, pids)), "-iTCP", "-Ts", "-FpnT"]).stdout
    result, pid, name = {}, None, None
    for line in out.splitlines():
        if line.startswith("p"):
            pid, name = int(line[1:]), None
        elif line.startswith("n"):
            name = line[1:]
        elif line.startswith("TST=") and pid is not None and name and "->" in name and pid not in result:
            local, peer = name.split("->", 1)
            result[pid] = (local, peer, line[4:])
    return result


def split_endpoint(text, sep):
    host, _, port = text.rpartition(sep)
    return host.strip("[]"), port


def rx_bytes():
    """(local, peer) as 'host:port' -> received bytes, from netstat -anb."""
    out = run(["/usr/sbin/netstat", "-anb", "-p", "tcp"]).stdout
    result = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 8 and parts[0].startswith("tcp") and parts[-3].isupper():
            local = "%s:%s" % split_endpoint(parts[3], ".")
            peer = "%s:%s" % split_endpoint(parts[4], ".")
            result[(local, peer)] = int(parts[-2])
    return result


def peer_ports(peer_ip, my_ip):
    """Source ports the peer host holds toward my_ip:22, or None when it cannot be asked."""
    alias = PEER_SSH.get(peer_ip)
    if not alias:
        return None
    cmd = "ss -Htn dst %s dport = :22" % my_ip
    try:
        res = run(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, cmd], timeout=40)
    except subprocess.TimeoutExpired:
        return None
    if res.returncode != 0:
        return None
    ports = set()
    for line in res.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            ports.add(split_endpoint(parts[3], ":")[1])
    return ports


def end_sessions(pids):
    """pid -> the signal that ended it: SIGTERM to all at once, then SIGKILL to any still there after 5 s."""
    done = {}
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            done[pid] = "gone"
    left = [pid for pid in pids if pid not in done]
    deadline = time.monotonic() + 5
    while left and time.monotonic() < deadline:
        time.sleep(0.1)
        left = [pid for pid in left if alive(pid)]
    for pid in pids:
        if pid in done:
            continue
        if pid in left:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            done[pid] = "SIGKILL"
        else:
            done[pid] = "SIGTERM"
    return done


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def reap(why, dry_run=False):
    """One run; returns how many PEER_SSH hosts it had to ask and could not reach."""
    try:
        with open(STATE_FILE) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}
    now = time.time()
    procs = processes()
    mine = ancestors(procs, os.getpid())
    sessions = {}
    for pid, proc in procs.items():
        match = SESSION_RE.match(proc["command"])
        if proc["user"] == USER and match and match.group(1) == USER and pid not in mine:
            sessions[pid] = proc
    socks = sockets(sorted(sessions))
    rx = rx_bytes()

    views, asks = {}, {}
    for pid in sessions:
        local, peer, tcp_state = socks.get(pid, ("", "", "NONE"))
        key = "%d %s" % (pid, peer)
        received = rx.get((local, peer))
        prev = state.get(key)
        since = prev["since"] if prev and prev["rx"] == received else now
        views[pid] = {"key": key, "local": local, "peer": peer, "tcp": tcp_state, "rx": received, "since": since}
        if since < now and tcp_state == "ESTABLISHED":
            asks.setdefault(split_endpoint(peer, ":")[0], set()).add(split_endpoint(local, ":")[0])

    held = {}
    for peer_ip, my_ips in asks.items():
        for my_ip in my_ips:
            held[(peer_ip, my_ip)] = peer_ports(peer_ip, my_ip)

    unreached = sum(1 for (peer_ip, _), ports in held.items() if ports is None and peer_ip in PEER_SSH)
    new_state, dead, dead_now, unknown = {}, [], 0, 0
    for pid, view in views.items():
        reason = None
        if view["tcp"] != "ESTABLISHED":
            reason = "no established socket (%s)" % view["tcp"]
        elif view["since"] < now:
            peer_ip, peer_port = split_endpoint(view["peer"], ":")
            ports = held.get((peer_ip, split_endpoint(view["local"], ":")[0]))
            if ports is None:
                unknown += 1
            elif peer_port not in ports:
                reason = "peer holds no connection"
        if reason:
            dead_now += 1
        if reason and now - view["since"] >= DEAD_FOR_S:
            dead.append((pid, reason))
            continue
        new_state[view["key"]] = {"rx": view["rx"], "since": view["since"]}

    signals = {} if dry_run else end_sessions([pid for pid, _ in dead])
    for pid, reason in dead:
        view = views[pid]
        entry = {"event": "would_end" if dry_run else "ended", "pid": pid, "priv_parent": sessions[pid]["ppid"],
                 "peer": view["peer"], "reason": reason, "quiet_for_s": int(now - view["since"])}
        if not dry_run:
            entry["signal"] = signals[pid]
        log(entry, dry_run)

    log({"event": "run", "why": why, "sessions": len(sessions), "dead": dead_now, "ended": len(dead),
         "peer_unknown": unknown, "peer_unreached": unreached, "took_s": round(time.time() - now, 1)}, dry_run)
    if not dry_run:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(new_state, fh)
        os.replace(tmp, STATE_FILE)
    return unreached


def plan(asleep_s, since_run_s, catching_up):
    """(why a run is due or None, whether a wake catch-up is on) from the seconds the Mac slept since the last tick and
    the wall-clock seconds since the last run."""
    if asleep_s > SLEPT_S:
        return "wake", True
    if catching_up:
        return "after wake", True
    if since_run_s >= INTERVAL_S:
        return "interval", False
    return None, False


def tick(state, wall, mono, run):
    """The loop's state after one tick at wall-clock `wall` and monotonic `mono`, calling `run(why)` when a run is due.
    time.monotonic() is mach_absolute_time on macOS, which stops while the Mac sleeps, so the wall clock running ahead
    of it between two ticks is the time the Mac slept."""
    asleep_s = (wall - state["wall"]) - (mono - state["mono"])
    why, catching_up = plan(asleep_s, wall - state["run"], state["catching_up"])
    new = {"wall": wall, "mono": mono, "run": state["run"], "catching_up": catching_up}
    if why == "wake":
        log({"event": "wake", "slept_s": int(asleep_s)}, False)
    if why:
        new["run"] = wall
        try:
            unreached = run(why)
        except Exception as error:
            log({"event": "error", "why": why, "error": repr(error)[:300]}, False)
        else:
            new["catching_up"] = catching_up and unreached > 0
    return new


def loop():
    state = {"wall": time.time(), "mono": time.monotonic(), "run": 0.0, "catching_up": False}
    while True:
        state = tick(state, time.time(), time.monotonic(), reap)
        time.sleep(TICK_S)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    args = sys.argv[1:]
    if "--dry-run" in args or "--once" in args:
        reap("once", dry_run="--dry-run" in args)
    else:
        loop()


if __name__ == "__main__":
    main()
