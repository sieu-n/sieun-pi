#!/usr/bin/python3
"""Keeps the Mac Prime daemon running, the way the Mac chat service's DaemonKeeper did before the 10-18 cutover to the box chat service.

launchd job com.sieun.prime-daemon-keeper (KeepAlive, ProcessType Interactive) runs this loop. It starts `bin/prime-agent --mode daemon`
through a login shell (the daemon needs the login variables, such as the API tokens), detached, with output in logs/daemon-stdio.log, only
when no daemon process for the socket is alive and the socket path refuses connects or is missing on every probe for STARTUP_GRACE_S.

On 10-18 from 10:58Z the first copy of this keeper took a 1 s connect timeout at Mac load 450 as a dead daemon. It started 13 more daemons
through `zsh -i -l` in 18 minutes, left each hung one running, and one of them took the socket path from the live daemon (pid 2547, 30
workers). That cut every box send to a Mac session. Now a slow connect counts as alive, and a live daemon process is never joined by a
second one. When the process is alive but its socket path is gone, the keeper logs that a manual restart is needed and starts nothing.
"""
import datetime, errno, os, shlex, socket, subprocess, time

HOME = os.path.expanduser("~")
TMPDIR = "/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/"
SOCK = TMPDIR + "prime-agent-501/daemon.sock"
BIN = HOME + "/.local/share/prime-agent/bin/prime-agent"
LOG = HOME + "/.prime/agent/logs/daemon-keeper.log"
STDIO = HOME + "/.prime/agent/logs/daemon-stdio.log"
# The chat keeper's backoff steps between failed starts.
BACKOFF = [2, 4, 8, 16, 32, 60]
# Probes, PROBE_GAP_S apart, that must all say "down" first; 3 s is the old keeper's wait for a restart the daemon or `prime-agent update` runs itself.
DOWN_PROBES = 2
PROBE_GAP_S = 3
ENV = {"HOME": HOME, "USER": os.environ.get("USER", "sieunpark"), "LOGNAME": os.environ.get("USER", "sieunpark"), "SHELL": "/bin/zsh",
       "TMPDIR": TMPDIR, "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def log(msg):
    with open(LOG, "a") as fh:
        fh.write(f"{datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')} {msg}\n")


def probe(path=SOCK, timeout=10.0):
    """'up' when a connect lands, 'slow' when it times out (a busy daemon), 'down' when the path is missing or refuses connects."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path)
        return "up"
    except socket.timeout:
        return "slow"
    except OSError as error:
        return "down" if error.errno in (errno.ENOENT, errno.ECONNREFUSED) else "slow"
    finally:
        s.close()


def daemon_pids(path=SOCK, ps_output=None):
    """Pids of prime-agent daemons for `path`; a login shell still starting one counts too."""
    if ps_output is None:
        ps_output = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    pids = []
    for line in ps_output.splitlines():
        pid, _, command = line.strip().partition(" ")
        if "--mode daemon" in command and command.rstrip().endswith("--daemon-socket " + path) and "prime-agent" in command:
            pids.append(int(pid))
    return pids


def decide(probes, pids):
    """What the loop does after `probes` (newest last) with daemon processes `pids` alive: 'wait', 'stuck' or 'start'."""
    if not probes or probes[-1] != "down" or len(probes) < DOWN_PROBES or any(p != "down" for p in probes[-DOWN_PROBES:]):
        return "wait"
    return "stuck" if pids else "start"


def launch():
    out = open(STDIO, "a")
    command = f"exec {shlex.quote(BIN)} --mode daemon --daemon-socket {shlex.quote(SOCK)}"
    child = subprocess.Popen(["/bin/zsh", "-i", "-l", "-c", command], cwd=HOME, env=ENV, stdin=subprocess.DEVNULL,
                             stdout=out, stderr=out, start_new_session=True)
    out.close()
    while child.poll() is None:
        if probe(timeout=1.0) == "up":
            return f"started pid {child.pid} and the socket answers"
        time.sleep(1)
    return f"pid {child.pid} exited with {child.returncode}"


def main():
    log(f"keeper start, pid {os.getpid()}")
    failures = 0
    probes = []
    stuck_logged = False
    while True:
        probes = (probes + [probe()])[-DOWN_PROBES:]
        action = decide(probes, daemon_pids())
        if action == "wait":
            if probes[-1] == "up":
                failures, stuck_logged = 0, False
            time.sleep(PROBE_GAP_S)
            continue
        if action == "stuck":
            if not stuck_logged:
                log(f"daemon pids {daemon_pids()} are alive but {SOCK} refuses connects or is gone; starting nothing, a manual restart is needed")
                stuck_logged = True
            time.sleep(PROBE_GAP_S)
            continue
        result = launch()
        probes = []
        if probe() == "up":
            log(f"no daemon was running; {result}")
            failures = 0
            continue
        wait = BACKOFF[min(failures, len(BACKOFF) - 1)]
        failures += 1
        log(f"start failed: {result}; next try in {wait} s")
        time.sleep(wait)


if __name__ == "__main__":
    main()
