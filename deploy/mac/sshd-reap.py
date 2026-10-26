#!/usr/bin/python3
"""End this user's sshd sessions on the Mac whose client is gone.

On 2026-10-23 fresh ssh logins from us-metal02 to the Mac failed: 38 sshd sessions whose box side had died while
the Mac slept filled launchd's limit of 42 sshd copies. The Mac's sshd sends nothing on an idle session
(ClientAliveInterval 0), so it never notices a client that left while the Mac could not hear the FIN. The server-side
fix (ClientAliveInterval in sshd_config) needs sudo and is the owner's todo t100; this agent works with or without it.

launchd agent ai.virev.sshd-reap runs this every 5 minutes as the user, without sudo. Each run:
  1. lists this user's sshd sessions (sshd-session: <user>, or <user>@<tty> once a channel opened), skipping the
     session this run is part of;
  2. reads each session's TCP socket and state from lsof and its received bytes from netstat -anb;
  3. marks a session dead when it has no ESTABLISHED socket, or when no byte arrived since the last run and the peer
     host, asked over ssh, holds no TCP connection with that 4-tuple;
  4. ends a dead session whose received bytes last changed DEAD_FOR_S or more ago (SIGTERM, then SIGKILL after 5 s).
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
Log: ~/.local/state/sshd-reap/log.jsonl, one JSON line per run and one per ended session.
`sshd-reap.py --dry-run` prints what a run would end, without ending it, logging or saving state.
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


def end_session(pid):
    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            time.sleep(0.1)
            os.kill(pid, 0)
        os.kill(pid, signal.SIGKILL)
        return "SIGKILL"
    except ProcessLookupError:
        return "SIGTERM"


def main():
    dry_run = "--dry-run" in sys.argv[1:]
    os.makedirs(STATE_DIR, exist_ok=True)
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

    new_state, ended, dead_now, unknown = {}, [], 0, 0
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
            entry = {"event": "ended", "pid": pid, "priv_parent": sessions[pid]["ppid"], "peer": view["peer"],
                     "reason": reason, "quiet_for_s": int(now - view["since"])}
            if dry_run:
                entry["event"] = "would_end"
            else:
                entry["signal"] = end_session(pid)
            log(entry, dry_run)
            ended.append(pid)
            continue
        new_state[view["key"]] = {"rx": view["rx"], "since": view["since"]}

    log({"event": "run", "sessions": len(sessions), "dead": dead_now, "ended": len(ended),
         "peer_unknown": unknown}, dry_run)
    if not dry_run:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(new_state, fh)
        os.replace(tmp, STATE_FILE)


if __name__ == "__main__":
    main()
