import contextlib
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import shlex
import os
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CTL = ROOT / "deploy/linux/prime-agent-daemon-ctl"
UNIT = ROOT / "deploy/linux/prime-agent-daemon.service"
CHAT_UNIT = ROOT / "deploy/linux/sieun-pi-chat.service"
INSTALL = ROOT / "deploy/linux/prime-install.sh"
WRAPPER = ROOT / "deploy/linux/prime-agent"
FEED = ("PRIME_AGENT_DOWNLOAD_BASE_URL", "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS")

FAKE = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import hashlib, json, os, socket, subprocess, sys, time
    log = os.environ["FAKE_LOG"]
    with open(log, "a") as f:
        f.write(json.dumps({"pid": os.getpid(), "argv": sys.argv[1:]}) + "\\n")
    if sys.argv[1] == "chat":
        # Prime's ensureDaemonRunning: a CLI that finds no daemon on its socket spawns one detached, in its own cgroup.
        sock = sys.argv[sys.argv.index("--daemon-socket") + 1] if "--daemon-socket" in sys.argv else os.path.join(os.environ.get("TMPDIR", "/tmp").rstrip("/"), f"prime-agent-{os.getuid()}", "daemon.sock")
        def answers():
            with socket.socket(socket.AF_UNIX) as probe:
                return probe.connect_ex(sock) == 0
        spawned = not answers()
        if spawned:
            subprocess.Popen([sys.argv[0], "--mode", "daemon", "--daemon-socket", sock], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.time() + 10
            while not answers() and time.time() < deadline:
                time.sleep(0.02)
        with open(os.environ["FAKE_CLI_LOG"], "w") as f:
            json.dump({"spawned": spawned, "cgroup": open("/proc/self/cgroup").read()}, f)
        sys.exit(0)
    if sys.argv[1] == "update":
        keys = ("TMPDIR", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "PRIME_AGENT_INTERNAL_DAEMON_WORKER", "PRIME_AGENT_INTERACTIVE_SELF_UPDATE", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", "PRIME_UPDATE_ARGS", "PRIME_AGENT_DOWNLOAD_BASE_URL", "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS")
        coordinator = "--internal-update-restart-coordinator" in sys.argv
        with open(os.environ["FAKE_ENV_LOG"] + (".restart" if coordinator else ""), "w") as f:
            json.dump({k: os.environ.get(k) for k in keys}, f)
        mode = os.environ.get("FAKE_UPDATE_MODE", "restart")
        if not coordinator:
            if mode == "busy":
                print("Prime Agent has 1 busy session. After the update installs, it will stop it, restart its background service, and resume interrupted work. Re-run with --force to proceed.", file=sys.stderr)
                sys.exit(1)
            if "--daemon-socket" in sys.argv or sys.argv[2:3] != ["--self"]:
                print("Package updates moved to the package command.", file=sys.stderr)
                sys.exit(1)
            if os.environ.get("PRIME_AGENT_INTERACTIVE_SELF_UPDATE") != "1":
                print("the ctl must install without the restart", file=sys.stderr)
                sys.exit(9)
            print("Updated Prime Agent from v1 to v2")
            sys.exit(int(os.environ.get("FAKE_UPDATE_CODE", "0")))
        sock = sys.argv[sys.argv.index("--daemon-socket") + 1]
        status_path = sys.argv[sys.argv.index("--internal-update-restart-status") + 1]
        def status(phase, **extra):
            with open(status_path + ".tmp", "w") as f:
                json.dump({"phase": phase, "counts": {"total": 1, "restored": 1, "resumed": 1, "failed": 0}, **extra}, f)
            os.replace(status_path + ".tmp", status_path)
        def answers():
            with socket.socket(socket.AF_UNIX) as probe:
                return probe.connect_ex(sock) == 0
        def runs(pid):
            try:
                return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] not in ("Z", "X")
            except OSError:
                return False
        def successor():
            env = dict(os.environ, FAKE_BEHAVIOR="serve", FAKE_LISTEN_DELAY=os.environ.get("FAKE_SUCCESSOR_DELAY", "2") if mode == "slow-successor" else "0")
            env.pop("FAKE_STUCK", None)
            subprocess.Popen([sys.argv[0], "--mode", "daemon", "--daemon-socket", sock], env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Prime keeps the prepared manifest at <agent dir>/daemon-update-restarts/<sha256 of the socket>.json, and a coordinator
        # that finds no daemon restores it into a successor it starts, or reports skipped when there is none.
        manifest = os.path.join(os.environ["PRIME_AGENT_CODING_AGENT_DIR"], "daemon-update-restarts", hashlib.sha256(sock.encode()).hexdigest() + ".json")
        restores = os.environ.get("FAKE_RESTORES")
        def restored_once(session_file):
            if restores:
                with open(restores, "a") as f:
                    f.write(session_file + "\\n")
        if not answers():
            if os.path.exists(manifest):
                raw = open(manifest, "rb").read()
                plan = json.loads(raw)
                # Prime's stoppedSinceManifest: a session archived at or after the manifest's createdAt is not restored.
                stops = json.load(open(os.environ["FAKE_STOPS"])) if os.environ.get("FAKE_STOPS") else {}
                stopped = [s["sessionFile"] for s in plan["sessions"] if s["sessionFile"] in stops and stops[s["sessionFile"]] >= plan["createdAt"]]
                if os.environ.get("FAKE_RERUN_LOG"):
                    with open(os.environ["FAKE_RERUN_LOG"], "w") as f:
                        json.dump({"manifest_sha256": hashlib.sha256(raw).hexdigest(), "stopped": stopped}, f)
                successor()
                for s in plan["sessions"]:
                    if s["sessionFile"] not in stopped:
                        restored_once(s["sessionFile"])
                os.remove(manifest)
                total = len(plan["sessions"])
                status("complete", counts={"total": total, "restored": total - len(stopped), "resumed": total - len(stopped), "failed": 0}, stoppedBeforeRestore=[{"sessionFile": f} for f in stopped])
                sys.exit(0)
            status("skipped", message="No running daemon needed to be restarted", counts={"total": 0, "restored": 0, "resumed": 0, "failed": 0})
            sys.exit(0)
        if mode in ("stuck-stop", "refusing", "cancelled", "stuck-queued"):
            # 10-27 on us-metal02: the predecessor took the shutdown and never finished it, and the coordinator restored
            # every planned session into it, each refused as preparing after a 120 s wait.
            old = int(open(os.environ["FAKE_PIDS"]).read().split()[-1])
            total = int(os.environ.get("FAKE_SESSIONS", "3"))
            os.makedirs(os.path.dirname(manifest), exist_ok=True)
            with open(manifest, "w") as f:
                json.dump({"formatVersion": 1, "createdAt": "2026-10-27T08:47:11.045Z", "sessions": [{"activeSessionId": f"a{n}", "sessionFile": f"/s/{n}.jsonl"} for n in range(total)]}, f)
            if os.environ.get("FAKE_RERUN_LOG"):
                with open(os.environ["FAKE_RERUN_LOG"] + ".first", "w") as f:
                    f.write(hashlib.sha256(open(manifest, "rb").read()).hexdigest())
            recoveries = manifest[:-len(".json")] + ".recoveries"
            counts = {"total": total, "restored": 0, "resumed": 0, "failed": 0}
            status("preparing", counts=counts, predecessor={"pid": old})
            if mode == "cancelled":
                # Prime f2d4ec7 and chat-057a's follow-up: the predecessor never accepts the shutdown. The coordinator's connection
                # closes (SIGUSR2 to the fake supervisor here), on its own after the refusal or when the coordinator dies, the
                # predecessor cancels its prepared phase, and the coordinator reports phase cancelled after its 10 s stop wait.
                import signal
                def closed(*_):
                    os.kill(old, signal.SIGUSR2)
                    sys.exit(1)
                signal.signal(signal.SIGTERM, closed)
                status("stopping", counts=counts, predecessor={"pid": old})
                time.sleep(float(os.environ.get("FAKE_REFUSAL_SECONDS", "0")))
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                os.kill(old, signal.SIGUSR2)
                time.sleep(float(os.environ.get("FAKE_STOP_WAIT", "1")))
                status("cancelled", message=f"The predecessor daemon on {sock} did not accept the shutdown; it cancelled the update and restores its own sessions", counts=counts)
                sys.exit(1)
            if mode == "stuck-queued":
                # Prime f2d4ec7: an accepted shutdown that outlives the 10 s wait. The coordinator restores nothing into the
                # predecessor, queues every prepared session as a pending recovery record, keeps the manifest and fails.
                status("stopping", counts=counts, predecessor={"pid": old})
                os.kill(old, 10)
                time.sleep(float(os.environ.get("FAKE_STOP_WAIT", "1")))
                os.makedirs(recoveries, exist_ok=True)
                for n in range(total):
                    with open(os.path.join(recoveries, f"{n}.json"), "w") as f:
                        json.dump({"formatVersion": 1, "updateId": f"2026-10-27T08:47:11.045Z:a{n}", "manifestCreatedAt": "2026-10-27T08:47:11.045Z", "session": {"activeSessionId": f"a{n}", "sessionFile": f"/s/{n}.jsonl"},
                                   "admission": "never_admitted", "attempts": [], "state": {"status": "pending"}}, f)
                status("failed", message=f"Could not stop the predecessor daemon on {sock}", counts=counts)
                sys.exit(1)
            if mode == "stuck-stop":
                status("stopping", counts=counts, predecessor={"pid": old})
                os.kill(old, 10)
                deadline = time.time() + float(os.environ.get("FAKE_STOP_WAIT", "1"))
                while runs(old) and time.time() < deadline:
                    time.sleep(0.01)
                if not runs(old):
                    successor()
                    os.remove(manifest)
                    status("complete", counts=dict(counts, restored=total, resumed=total))
                    sys.exit(0)
            for n in range(total):
                time.sleep(float(os.environ.get("FAKE_RESTORE_SECONDS", "1")))
                # Prime's failRestore keeps a pending recovery record for a transient update_restarting refusal.
                os.makedirs(recoveries, exist_ok=True)
                with open(os.path.join(recoveries, f"{n}.json"), "w") as f:
                    json.dump({"formatVersion": 1, "updateId": f"2026-10-27T08:47:11.045Z:a{n}", "manifestCreatedAt": "2026-10-27T08:47:11.045Z", "session": {"activeSessionId": f"a{n}", "sessionFile": f"/s/{n}.jsonl"},
                               "attempts": [{"outcome": "failed", "error": "Daemon is preparing an update restart"}], "state": {"status": "pending"}}, f)
                print(f"Warning: could not restore /s/{n}.jsonl: Daemon is preparing an update restart", flush=True)
            os.remove(manifest)
            status("failed", message=f"Could not stop the predecessor daemon on {sock}", counts=dict(counts, failed=total))
            sys.exit(1)
        if mode == "prepare":
            status("failed", message="Could not prepare daemon sessions for automatic resume; the previous daemon is still running (Cannot prepare update restart while resident worker 6acc196dee81 is failed and disconnected (session s))")
            sys.exit(1)
        if mode == "restart-failed":
            status("failed", message="Could not stop the predecessor daemon on x")
            sys.exit(1)
        if mode == "manifest":
            folder = os.path.join(os.environ["PRIME_AGENT_CODING_AGENT_DIR"], "daemon-update-restarts")
            manifest = os.path.join(folder, "5e1f.json")
            with open(manifest + ".tmp", "w") as f:
                json.dump({"formatVersion": 1, "createdAt": "2026-10-20T03:08:00.000Z", "sessions": [{"activeSessionId": "b4d32e15dd56", "sessionId": "01a1549e",
                    "sessionFile": "/s/01a1549e.jsonl", "cwd": "/home/sieun", "config": {"model": "m"}, "clientEnv": {"TOKEN": "secret"},
                    "queue": {"actions": {}, "nextTurn": [{"content": "queued text"}]}, "shouldResume": True, "hadRunningRlmChildren": True}]}, f)
            os.rename(manifest + ".tmp", manifest)
            planned = status_path[:-len(".json")] + ".planned.json"
            deadline = time.time() + 10
            while not os.path.exists(planned) and time.time() < deadline:
                time.sleep(0.01)
            os.remove(manifest)
        old = int(open(os.environ["FAKE_PIDS"]).read().split()[-1])
        os.kill(old, 15)
        while os.path.exists(sock):
            time.sleep(0.01)
        successor()
        if mode == "slow-successor":
            status("failed", message=f"Timed out waiting for daemon to start on {sock}.", counts={"total": 3, "restored": 0, "resumed": 0, "failed": 0})
            sys.exit(1)
        status("complete")
        sys.exit(0)
    sock = sys.argv[sys.argv.index("--daemon-socket") + 1]
    if os.environ.get("FAKE_BEHAVIOR") == "worker":
        # A session worker that is still writing worker_commit_update, and exits when its commit ends.
        time.sleep(float(os.environ["FAKE_COMMIT_SECONDS"]))
        with open(os.environ["FAKE_WORKER_EXITS"], "a") as f:
            f.write(f"{time.time()}\\n")
        sys.exit(0)
    with open(os.environ["FAKE_ENV_LOG"] + ".daemon", "w") as f:
        json.dump({"TMPDIR": os.environ.get("TMPDIR"), "socket": os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET"), "feed": [k for k in ("PRIME_AGENT_DOWNLOAD_BASE_URL", "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS") if k in os.environ]}, f)
    behavior = os.environ.get("FAKE_BEHAVIOR", "serve")
    if behavior.startswith("exit"):
        sys.exit(int(behavior[4:]))
    if behavior == "wait":
        time.sleep(60)
    time.sleep(float(os.environ.get("FAKE_LISTEN_DELAY", "0")))
    if os.environ.get("FAKE_LOCK") == "mem3":
        lock = sock + ".lock"
        try:
            os.mkdir(lock)
        except FileExistsError:
            if time.time() - os.stat(lock).st_mtime < 5:
                print(f"ELOCKED: Lock file is already being held {sock}", file=sys.stderr)
                sys.exit(1)
            try:
                os.rmdir(lock)
                os.mkdir(lock)
            except OSError as error:
                print(f"{error.strerror}: rmdir '{lock}'", file=sys.stderr)
                sys.exit(1)
    with socket.socket(socket.AF_UNIX) as probe:
        if os.path.exists(sock) and probe.connect_ex(sock) != 0:
            os.unlink(sock)
    server = socket.socket(socket.AF_UNIX)
    server.bind(sock)
    server.listen(8)
    with open(os.environ["FAKE_PIDS"], "a") as f:
        f.write(f"{os.getpid()}\\n")
    import signal
    for n in range(int(os.environ.get("FAKE_WORKERS", "0"))):
        subprocess.Popen([sys.argv[0], "--mode", "daemon", "--daemon-socket", os.path.join(os.path.dirname(sock), f"worker-5e1f-{n}.sock")],
                         env=dict(os.environ, FAKE_BEHAVIOR="worker"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def signalled(name):
        if os.environ.get("FAKE_SIGNALS"):
            with open(os.environ["FAKE_SIGNALS"], "a") as f:
                f.write(f"{name} {time.time()}\\n")
    def stop(*_):
        signalled("SIGTERM")
        os.unlink(sock)
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    # FAKE_STUCK models Prime's supervisor on 10-27: it takes the shutdown (SIGUSR1 here), drops its signal handlers and
    # never finishes. "soft" then dies on SIGTERM and leaves its socket file; "hard" ignores SIGTERM too.
    def dies(*_):
        signalled("SIGTERM")
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGTERM)
    def shutdown_that_hangs(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN if os.environ["FAKE_STUCK"] == "hard" else dies)
    if os.environ.get("FAKE_STUCK"):
        signal.signal(signal.SIGUSR1, shutdown_that_hangs)
    # SIGUSR2 is the coordinator's connection closing without an accepted shutdown. With FAKE_CANCELS the supervisor is
    # Prime f2d4ec7's cancelPreparedUpdateRestart: it queues each manifest session as a pending recovery record, deletes the
    # manifest and serves again. Without it, it is an f48fb6fd supervisor, which keeps its prepared phase.
    def cancel(*_):
        signalled("CANCEL")
        manifest = os.path.join(os.environ["PRIME_AGENT_CODING_AGENT_DIR"], "daemon-update-restarts", hashlib.sha256(sock.encode()).hexdigest() + ".json")
        plan = json.load(open(manifest))
        recoveries = manifest[:-len(".json")] + ".recoveries"
        os.makedirs(recoveries, exist_ok=True)
        for n, s in enumerate(plan["sessions"]):
            with open(os.path.join(recoveries, f"{n}.json"), "w") as f:
                json.dump({"formatVersion": 1, "updateId": f"{plan['createdAt']}:{s['activeSessionId']}", "session": s, "state": {"status": "pending"}}, f)
        os.remove(manifest)
    signal.signal(signal.SIGUSR2, cancel if os.environ.get("FAKE_CANCELS") else signal.SIG_IGN)
    hello = {"type": "daemon_hello", "protocol": {"version": 7}, "supervisorPid": os.getpid(), "supervisorSocketPath": sock}
    while True:
        conn, _ = server.accept()
        try:
            conn.sendall((json.dumps(hello) + "\\n").encode())
        except OSError:
            pass
        conn.close()
    """
)


@unittest.skipUnless(sys.platform.startswith("linux"), "the ctl reads /proc and runs only on the Linux box")
class DaemonCtlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pad-ctl-", dir="/tmp")
        self.dir = Path(self.tmp.name)
        self.sockdir = self.dir / f"prime-agent-{os.getuid()}"
        self.sockdir.mkdir()
        self.sock = str(self.sockdir / "daemon.sock")
        self.pidfile = str(self.dir / "daemon.pid")
        self.fake = self.dir / "prime-agent"
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.env = dict(
            os.environ,
            FAKE_LOG=str(self.dir / "calls.jsonl"),
            FAKE_PIDS=str(self.dir / "pids"),
            FAKE_ENV_LOG=str(self.dir / "env.json"),
            PRIME_AGENT_CODING_AGENT_DIR=str(self.dir / "agent"),
        )
        for key in ("PRIME_UPDATE_ARGS", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "PRIME_AGENT_INTERACTIVE_SELF_UPDATE", *FEED):
            self.env.pop(key, None)
        self.procs = []

    def tearDown(self):
        pids = Path(self.env["FAKE_PIDS"])
        for pid in pids.read_text().split() if pids.exists() else []:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        self.tmp.cleanup()

    def calls(self):
        path = Path(self.env["FAKE_LOG"])
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def ctl(self, *args, env=None):
        out = self.dir / "ctl.out"
        with open(out, "w") as sink:
            code = subprocess.call([sys.executable, "-B", str(CTL), *args], env=env or self.env, stdout=sink, stderr=subprocess.STDOUT, timeout=30)
        return subprocess.CompletedProcess(args, code, out.read_text(), out.read_text())

    def serve(self, **extra):
        proc = subprocess.Popen([str(self.fake), "--mode", "daemon", "--daemon-socket", self.sock], env=dict(self.env, **extra))
        self.procs.append(proc)
        self.wait_for_socket()
        return proc

    def wait_for_socket(self):
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                with socket.socket(socket.AF_UNIX) as conn:
                    conn.connect(self.sock)
                    return
            except OSError:
                time.sleep(0.02)
        self.fail("fake supervisor did not listen")

    def pid_in_file(self):
        return int(Path(self.pidfile).read_text())

    def test_start_adopts_the_supervisor_that_already_answers(self):
        running = self.serve()
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.pid_in_file(), running.pid)
        self.assertEqual([c for c in self.calls() if c["pid"] != running.pid], [])

    def test_start_launches_a_supervisor_and_writes_its_pid(self):
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stderr)
        launched = [c for c in self.calls() if c["argv"][:2] == ["--mode", "daemon"]]
        self.assertEqual(len(launched), 1)
        self.assertEqual(self.pid_in_file(), launched[0]["pid"])

    def test_start_waits_for_a_live_update_restart_coordinator(self):
        registry = self.sockdir / "update-restart-coordinators"
        registry.mkdir()
        coordinator = subprocess.Popen(["sleep", "30"])
        self.procs.append(coordinator)
        (registry / "x.json").write_text(json.dumps({"pid": coordinator.pid, "socketPath": self.sock}))
        ctl = subprocess.Popen([sys.executable, "-B", str(CTL), "start", str(self.fake), self.sock, self.pidfile], env=self.env, stdout=subprocess.DEVNULL)
        self.procs.append(ctl)
        time.sleep(1)
        self.assertIsNone(ctl.poll())
        self.assertEqual(self.calls(), [])
        successor = self.serve()
        self.assertEqual(ctl.wait(timeout=10), 0)
        self.assertEqual(self.pid_in_file(), successor.pid)
        self.assertEqual([c["pid"] for c in self.calls()], [successor.pid])

    def test_start_reports_a_coordinator_past_its_deadline_sum_and_keeps_waiting(self):
        registry = self.sockdir / "update-restart-coordinators"
        registry.mkdir()
        status = self.dir / "status.json"
        status.write_text(json.dumps({"counts": {"total": 2}}))
        coordinator = subprocess.Popen(["sleep", "30"])
        self.procs.append(coordinator)
        created = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 1200))
        (registry / "x.json").write_text(json.dumps({"pid": coordinator.pid, "socketPath": self.sock, "statusPath": str(status), "createdAt": created}))
        ctl = subprocess.Popen([sys.executable, "-B", str(CTL), "start", str(self.fake), self.sock, self.pidfile], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.procs.append(ctl)
        time.sleep(1)
        self.assertIsNone(ctl.poll())
        successor = self.serve()
        self.assertEqual(ctl.wait(timeout=10), 0)
        self.assertEqual(self.pid_in_file(), successor.pid)
        stderr = ctl.stderr.read()
        ctl.stderr.close()
        self.assertIn("past the 1075 s sum of Prime's step deadlines", stderr)

    def test_start_ignores_a_dead_coordinator_record(self):
        registry = self.sockdir / "update-restart-coordinators"
        registry.mkdir()
        dead = subprocess.Popen(["true"])
        dead.wait()
        (registry / "x.json").write_text(json.dumps({"pid": dead.pid, "socketPath": self.sock}))
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_start_fails_with_the_daemon_exit_code(self):
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_BEHAVIOR="exit3"))
        self.assertEqual(result.returncode, 3)
        self.assertFalse(Path(self.pidfile).exists())

    def test_start_stops_its_own_daemon_when_another_supervisor_wins(self):
        ctl = subprocess.Popen([sys.executable, "-B", str(CTL), "start", str(self.fake), self.sock, self.pidfile], env=dict(self.env, FAKE_BEHAVIOR="wait"), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.procs.append(ctl)
        deadline = time.time() + 10
        while not self.calls() and time.time() < deadline:
            time.sleep(0.02)
        own = self.calls()[0]["pid"]
        winner = self.serve(FAKE_BEHAVIOR="serve")
        self.assertEqual(ctl.wait(timeout=10), 0)
        self.assertEqual(self.pid_in_file(), winner.pid)
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(own, 0)
        self.assertIn("took the socket first", ctl.stderr.read())

    def installs(self):
        return [c["argv"] for c in self.calls() if c["argv"][0] == "update" and "--internal-update-restart-coordinator" not in c["argv"]]

    def env_seen(self, suffix=""):
        return json.loads(Path(self.env["FAKE_ENV_LOG"] + suffix).read_text())

    def test_update_forwards_prime_update_args_and_tracks_the_successor(self):
        old = self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, PRIME_UPDATE_ARGS="--rollback --force"))
        self.assertEqual(result.returncode, 0, result.stdout)
        updates = [c for c in self.calls() if c["argv"][0] == "update"]
        self.assertEqual(updates[0]["argv"], ["update", "--self", "--rollback", "--force"])
        new = self.pid_in_file()
        self.assertNotEqual(new, old.pid)
        self.assertEqual(int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1]), new)
        self.assertIn("result=ok", result.stdout)
        self.assertIsNone(self.env_seen()["PRIME_UPDATE_ARGS"])

    def test_update_empties_the_env_file_before_the_updater_runs(self):
        self.serve()
        env_file = self.dir / "prime-update.env"
        env_file.write_text("PRIME_UPDATE_ARGS=--force\n")
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, str(env_file), env=dict(self.env, PRIME_UPDATE_ARGS="--force"))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(env_file.read_text(), "")
        self.assertEqual(self.installs(), [["update", "--self", "--force"]])

    def test_update_without_prime_update_args_runs_a_plain_update(self):
        self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.installs(), [["update", "--self"]])

    def test_update_targets_the_socket_argument_over_an_inherited_one(self):
        self.serve()
        wrong = dict(
            self.env,
            TMPDIR="/tmp/pad-wrong-tmp",
            PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET="/tmp/pad-wrong/daemon.sock",
            PRIME_AGENT_INTERNAL_DAEMON_WORKER="1",
            PRIME_AGENT_INTERACTIVE_SELF_UPDATE="1",
            PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=str(self.dir / "owners"),
        )
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=wrong)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(
            self.env_seen(),
            {
                "TMPDIR": str(self.dir),
                "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET": self.sock,
                "PRIME_AGENT_INTERNAL_DAEMON_WORKER": None,
                "PRIME_AGENT_INTERACTIVE_SELF_UPDATE": "1",
                "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR": str(self.dir / "owners"),
                "PRIME_UPDATE_ARGS": None,
                "PRIME_AGENT_DOWNLOAD_BASE_URL": None,
                "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS": None,
            },
        )

    def test_only_the_install_sees_the_feed_variables_and_the_successor_gets_the_unit_env(self):
        self.serve()
        feed = {"PRIME_AGENT_DOWNLOAD_BASE_URL": "http://127.0.0.1:57415", "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS": "1"}
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, PRIME_UPDATE_ARGS="--force", **feed))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("result=ok", result.stdout)
        installed = self.env_seen()
        self.assertEqual({k: installed[k] for k in FEED}, feed)
        self.assertEqual(installed["PRIME_AGENT_INTERACTIVE_SELF_UPDATE"], "1")
        restart = self.env_seen(".restart")
        self.assertEqual({k: restart[k] for k in (*FEED, "PRIME_AGENT_INTERACTIVE_SELF_UPDATE", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET")}, dict.fromkeys((*FEED, "PRIME_AGENT_INTERACTIVE_SELF_UPDATE", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET")))
        self.assertEqual(self.env_seen(".daemon")["feed"], [])
        coordinator = [c["argv"] for c in self.calls() if "--internal-update-restart-coordinator" in c["argv"]]
        self.assertEqual(len(coordinator), 1)
        self.assertEqual(coordinator[0][2:4], ["--daemon-socket", self.sock])
        self.assertTrue(coordinator[0][5].startswith(str(self.dir / "agent/update-restarts") + "/"))

    def test_update_keeps_a_metadata_copy_of_the_planned_restore_after_the_manifest_is_consumed(self):
        self.serve()
        (self.dir / "agent").mkdir()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_MODE="manifest"))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(list((self.dir / "agent/daemon-update-restarts").iterdir()), [])
        copies = list((self.dir / "agent/update-restarts").glob("ctl-*.planned.json"))
        self.assertEqual(len(copies), 1, result.stdout)
        plan = json.loads(copies[0].read_text())["manifests"]["5e1f.json"]
        self.assertEqual(plan["total"], 1)
        self.assertEqual(plan["sessions"], [{"activeSessionId": "b4d32e15dd56", "sessionId": "01a1549e", "sessionFile": "/s/01a1549e.jsonl", "cwd": "/home/sieun",
                                             "shouldResume": True, "hadRunningRlmChildren": True}])
        self.assertNotIn("secret", copies[0].read_text())
        self.assertNotIn("queued text", copies[0].read_text())

    def test_an_install_that_installs_nothing_skips_the_restart(self):
        old = self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_CODE="75"))
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("result=failed prime-agent update installed nothing", result.stdout)
        self.assertEqual([c for c in self.calls() if "--internal-update-restart-coordinator" in c["argv"]], [])
        self.assertEqual(self.pid_in_file(), old.pid)

    def test_start_pins_the_daemon_it_launches_to_the_socket_argument(self):
        wrong = dict(self.env, TMPDIR="/tmp/pad-wrong-tmp", PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET="/tmp/pad-wrong/daemon.sock")
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile, env=wrong)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.env_seen(".daemon"), {"TMPDIR": str(self.dir), "socket": None, "feed": []})

    def test_update_refuses_args_other_than_force_and_rollback(self):
        self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, PRIME_UPDATE_ARGS="--force --daemon-socket /tmp/x"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("result=usage", result.stdout)
        self.assertEqual(self.installs(), [])

    def test_update_reports_a_busy_session_refusal_apart_from_a_prepare_refusal(self):
        cases = (("busy", 3, "result=busy-refused"), ("prepare", 4, "result=prepare-refused"))
        for mode, code, line in cases:
            with self.subTest(mode=mode):
                Path(self.env["FAKE_PIDS"]).unlink(missing_ok=True)
                old = self.serve()
                result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_MODE=mode))
                self.assertEqual(result.returncode, code, result.stdout)
                self.assertIn(line, result.stdout)
                self.assertEqual(self.pid_in_file(), old.pid)
                old.terminate()
                old.wait()

    def update_in_process(self, **env):
        """Run update in this process with the stop timings cut to fit a test; production waits 15, 10 and 5 s."""
        ctl = load_ctl()
        ctl.COORDINATOR_GAVE_UP_SECONDS = 2
        ctl.PREDECESSOR_EXIT_SECONDS = 0.5
        ctl.SIGNAL_WAIT_SECONDS = 2
        out = io.StringIO()
        began = time.monotonic()
        with mock.patch.dict(os.environ, dict(self.env, **env), clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = ctl.update(str(self.fake), self.sock, self.pidfile)
        return code, out.getvalue(), time.monotonic() - began

    def kill_fakes(self):
        pids = Path(self.env["FAKE_PIDS"])
        for pid in pids.read_text().split() if pids.exists() else []:
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pid), signal.SIGKILL)
        pids.unlink(missing_ok=True)
        Path(self.sock).unlink(missing_ok=True)

    def successor_pid(self):
        return int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1])

    def test_a_predecessor_that_never_finishes_its_shutdown_is_ended_and_the_kept_manifest_restored(self):
        # 10-27 08:48Z on us-metal02: 2013592 took Prime's shutdown and never finished it, the coordinator restored all 188
        # sessions into it at 120 s a root, restored 0, and the ctl adopted it with exit 0. The box served nothing for 4 h.
        for stuck, signals in (("soft", ["SIGTERM"]), ("hard", ["SIGTERM", "SIGKILL"])):
            with self.subTest(stuck=stuck):
                self.kill_fakes()
                old = self.serve(FAKE_STUCK=stuck)
                code, out, took = self.update_in_process(FAKE_UPDATE_MODE="stuck-stop", FAKE_SESSIONS="4", FAKE_RESTORE_SECONDS="3")
                self.assertEqual(code, 0, out)
                self.assertIn("result=stop-forced restored 4 of 4", out)
                self.assertEqual(old.wait(timeout=5), -getattr(signal, signals[-1]))
                self.assertNotEqual(self.pid_in_file(), old.pid)
                self.assertEqual(self.pid_in_file(), self.successor_pid())
                self.assertEqual([s for s in ("SIGTERM", "SIGKILL") if f"sent {s} to supervisor {old.pid} " in out], signals, out)
                self.assertNotIn("could not restore", out)
                self.assertLess(took, 15, out)

    def test_restores_stop_at_the_first_preparing_refusal(self):
        # Each refusal cost 120 s on 10-27; the ctl stops the coordinator on the first one, whatever phase it reports.
        old = self.serve(FAKE_STUCK="soft")
        code, out, took = self.update_in_process(FAKE_UPDATE_MODE="refusing", FAKE_SESSIONS="6", FAKE_RESTORE_SECONDS="1")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("could not restore"), 1, out)
        self.assertIn("stopped Prime's coordinator because it printed 'Daemon is preparing an update restart'", out)
        self.assertIn("result=stop-forced restored 6 of 6", out)
        self.assertIsNotNone(old.wait(timeout=5))
        self.assertEqual(self.pid_in_file(), self.successor_pid())
        self.assertLess(took, 6, out)

    def test_a_coordinator_that_exits_on_could_not_stop_the_predecessor_never_leaves_it_adopted(self):
        # With nothing to restore, the coordinator fails at once and leaves the prepared predecessor, which serves no session.
        old = self.serve()
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="restart-failed")
        self.assertEqual(code, 0, out)
        self.assertIn("result=stop-forced restored 0 of 0", out)
        self.assertNotIn("result=restore-failed-successor-adopted", out)
        self.assertIsNotNone(old.wait(timeout=5))
        self.assertNotEqual(self.pid_in_file(), old.pid)
        self.assertEqual(self.pid_in_file(), self.successor_pid())

    def rerun_files(self):
        return {name: str(self.dir / name) for name in ("restores", "rerun.json", "stops.json")}

    def recoveries(self):
        folder = Path(self.env["PRIME_AGENT_CODING_AGENT_DIR"]) / "daemon-update-restarts"
        return {p.name: p.read_bytes() for p in sorted(folder.glob("*.recoveries/*.json"))}

    def test_the_rerun_restores_the_kept_manifest_once_and_skips_a_session_stopped_after_it(self):
        # The owner stops /s/1 at 08:48:30, after the manifest's createdAt of 08:47:11.045, while the predecessor is stuck.
        # /s/2's stop at 08:40 is older than the manifest, so that session was live when the manifest named it.
        files = self.rerun_files()
        Path(files["stops.json"]).write_text(json.dumps({"/s/1.jsonl": "2026-10-27T08:48:30.000Z", "/s/2.jsonl": "2026-10-27T08:40:00.000Z"}))
        old = self.serve(FAKE_STUCK="soft")
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="refusing", FAKE_SESSIONS="4", FAKE_RESTORE_SECONDS="1",
                                              FAKE_RESTORES=files["restores"], FAKE_RERUN_LOG=files["rerun.json"], FAKE_STOPS=files["stops.json"])
        self.assertEqual(code, 0, out)
        self.assertIsNotNone(old.wait(timeout=5))
        rerun = json.loads(Path(files["rerun.json"]).read_text())
        self.assertEqual(rerun["manifest_sha256"], Path(files["rerun.json"] + ".first").read_text(), "the ctl must hand the rerun the manifest the first run kept, unchanged")
        self.assertEqual(rerun["stopped"], ["/s/1.jsonl"])
        self.assertEqual(Path(files["restores"]).read_text().splitlines(), ["/s/0.jsonl", "/s/2.jsonl", "/s/3.jsonl"])
        self.assertIn("result=stop-forced restored 3 of 4", out)
        pending = self.recoveries()
        self.assertEqual(list(pending), ["0.json"], "the first run's one refusal leaves one pending record")
        self.assertEqual(json.loads(pending["0.json"])["state"], {"status": "pending"}, "the ctl leaves Prime's pending record as Prime wrote it")

    def test_a_stuck_stop_is_ended_before_the_first_restore_attempt_writes_a_recovery_record(self):
        # In the 10-27 shape each refusal took 120 s, so the ctl's stopping-phase deadline fires before any restore returns.
        files = self.rerun_files()
        old = self.serve(FAKE_STUCK="soft")
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="stuck-stop", FAKE_SESSIONS="3", FAKE_RESTORE_SECONDS="30",
                                              FAKE_RESTORES=files["restores"], FAKE_RERUN_LOG=files["rerun.json"])
        self.assertEqual(code, 0, out)
        self.assertIsNotNone(old.wait(timeout=5))
        self.assertNotIn("could not restore", out)
        self.assertEqual(self.recoveries(), {})
        self.assertEqual(Path(files["restores"]).read_text().splitlines(), ["/s/0.jsonl", "/s/1.jsonl", "/s/2.jsonl"])
        self.assertIn("result=stop-forced restored 3 of 3", out)

    def test_no_signal_reaches_a_predecessor_while_a_worker_of_it_still_commits(self):
        # 10-27 (CAUSE-draft.md step 3): the coordinator's first preparing refusal came while 2013592 was still sending
        # worker_commit_update and stopping its 39 workers. Here the refusal comes after 1 s and the workers commit for 4 s.
        signals, exits = str(self.dir / "signals"), str(self.dir / "worker-exits")
        old = self.serve(FAKE_WORKERS="3", FAKE_COMMIT_SECONDS="4", FAKE_WORKER_EXITS=exits, FAKE_SIGNALS=signals)
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="refusing", FAKE_SESSIONS="8", FAKE_RESTORE_SECONDS="1")
        self.assertEqual(code, 0, out)
        self.assertIsNotNone(old.wait(timeout=5))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not (Path(exits).exists() and len(Path(exits).read_text().split()) == 3):
            time.sleep(0.05)
        last_exit = max(float(t) for t in Path(exits).read_text().split())
        sent = [float(line.split()[1]) for line in Path(signals).read_text().splitlines()]
        self.assertEqual(len(Path(exits).read_text().split()), 3)
        self.assertTrue(sent and min(sent) > last_exit, f"signal at {sent}, last worker exit at {last_exit}\n{out}")
        self.assertIn("after the predecessor's last worker exited", out)
        self.assertIn("result=stop-forced restored 8 of 8", out)

    def test_a_predecessor_that_outlives_sigkill_fails_the_update_loudly(self):
        old = self.serve(FAKE_STUCK="soft")
        ctl = load_ctl()
        ctl.COORDINATOR_GAVE_UP_SECONDS = 2
        out = io.StringIO()
        with mock.patch.object(ctl, "end_supervisor", return_value=False), mock.patch.dict(os.environ, dict(self.env, FAKE_UPDATE_MODE="stuck-stop", FAKE_SESSIONS="2", FAKE_RESTORE_SECONDS="3"), clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = ctl.update(str(self.fake), self.sock, self.pidfile)
        self.assertEqual(code, ctl.STOP_FAILED, out.getvalue())
        self.assertIn("result=stop-failed", out.getvalue())
        self.assertNotIn("could not restore", out.getvalue())
        self.assertIsNone(old.poll())

    def test_a_stop_that_finishes_inside_prime_s_wait_gets_no_signal_from_the_ctl(self):
        old = self.serve()
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="stuck-stop", FAKE_SESSIONS="2")
        self.assertEqual(code, 0, out)
        self.assertIn("result=ok", out)
        self.assertNotIn("sent SIG", out)
        self.assertEqual(old.wait(timeout=5), -signal.SIGUSR1)
        self.assertEqual(self.pid_in_file(), self.successor_pid())

    def manifest(self):
        return Path(self.env["PRIME_AGENT_CODING_AGENT_DIR"]) / "daemon-update-restarts" / f"{hashlib.sha256(self.sock.encode()).hexdigest()}.json"

    def test_a_predecessor_that_never_accepted_the_shutdown_restores_its_own_sessions_and_gets_no_signal(self):
        # Prime f2d4ec7 and chat-057a's follow-up on 10-28: a shutdown the predecessor never accepts closes the coordinator's
        # connection, the predecessor cancels its prepared phase, queues the manifest as pending recovery records, deletes the
        # manifest and restores them itself, and the coordinator ends in phase cancelled with no 'Could not stop' text. Its
        # stop wait is 10 s and usually ends near 11 s, but a slow shutdown answer or session list can run past the ctl's 15 s
        # clock ("past"), and a refusal can still be in flight when the clock fires ("slow-refusal", where the ctl's stop of
        # the coordinator is what closes the connection).
        for case, extra in (("in-time", {"FAKE_STOP_WAIT": "1"}), ("past", {"FAKE_STOP_WAIT": "4"}),
                            ("slow-refusal", {"FAKE_REFUSAL_SECONDS": "5", "FAKE_STOP_WAIT": "1"})):
            with self.subTest(case=case):
                self.kill_fakes()
                signals = self.dir / f"signals-{case}"
                old = self.serve(FAKE_CANCELS="1", FAKE_SIGNALS=str(signals))
                code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="cancelled", FAKE_SESSIONS="3", **extra)
                self.assertEqual(signals.read_text().split()[0::2], ["CANCEL"], out)
                self.assertIsNone(old.poll(), out)
                self.assertNotIn("sent SIG", out)
                self.assertFalse(self.manifest().exists())
                self.assertEqual(len(self.recoveries()), 3, "the predecessor's pending records stay for its own sweep")
                self.assertIn("result=update-cancelled", out)
                self.assertEqual(code, 5, out)
                self.assertEqual(self.pid_in_file(), old.pid)

    def test_a_cancelled_coordinator_whose_predecessor_kept_its_prepared_phase_ends_it_and_restores_the_manifest(self):
        # A mixed update: Prime f2d4ec7's coordinator over an f48fb6fd predecessor, which never cancels a prepared phase, so the
        # manifest stays and the predecessor refuses every open, as 2013592 did on 10-27 from 08:48Z to 12:56Z.
        files = self.rerun_files()
        old = self.serve(FAKE_SIGNALS=str(self.dir / "signals"))
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="cancelled", FAKE_SESSIONS="3", FAKE_RESTORES=files["restores"])
        self.assertEqual(code, 0, out)
        self.assertIn("and its prepared manifest is still there", out)
        self.assertIsNotNone(old.wait(timeout=5))
        self.assertEqual(Path(files["restores"]).read_text().splitlines(), ["/s/0.jsonl", "/s/1.jsonl", "/s/2.jsonl"])
        self.assertIn("result=stop-forced restored 3 of 3", out)
        self.assertEqual(self.pid_in_file(), self.successor_pid())

    def test_an_accepted_stop_that_outlives_prime_s_wait_is_ended_and_the_rerun_gets_the_kept_manifest_and_records(self):
        # Prime f2d4ec7: the coordinator keeps 'Could not stop the predecessor daemon on <socket>' for an accepted shutdown
        # whose pid and start id still live after 10 s, queues every session as a pending record and keeps the manifest.
        files = self.rerun_files()
        old = self.serve(FAKE_STUCK="soft")
        code, out, _ = self.update_in_process(FAKE_UPDATE_MODE="stuck-queued", FAKE_SESSIONS="3", FAKE_RESTORES=files["restores"], FAKE_RERUN_LOG=files["rerun.json"])
        self.assertEqual(code, 0, out)
        self.assertIsNotNone(old.wait(timeout=5))
        self.assertEqual(json.loads(Path(files["rerun.json"]).read_text())["manifest_sha256"], Path(files["rerun.json"] + ".first").read_text())
        self.assertEqual(Path(files["restores"]).read_text().splitlines(), ["/s/0.jsonl", "/s/1.jsonl", "/s/2.jsonl"])
        records = {name: json.loads(raw) for name, raw in self.recoveries().items()}
        self.assertEqual(sorted(records), ["0.json", "1.json", "2.json"])
        self.assertTrue(all(r["state"] == {"status": "pending"} and r["attempts"] == [] for r in records.values()), "the ctl leaves Prime's records as Prime wrote them")
        self.assertIn("result=stop-forced restored 3 of 3", out)

    def serve_outside(self):
        """A supervisor in its own transient scope, as 3052306 runs in session-c155369.scope since 10-27 12:56Z."""
        if subprocess.call(["systemd-run", "--user", "--scope", "--quiet", "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            self.skipTest("no systemd user manager to make a scope in")
        proc = subprocess.Popen(["systemd-run", "--user", "--scope", "--quiet", f"--unit=pad-ctl-outside-{os.getpid()}-{time.monotonic_ns()}",
                                 "-E", f"PRIME_AGENT_CODING_AGENT_DIR={self.env['PRIME_AGENT_CODING_AGENT_DIR']}", str(self.fake), "--mode", "daemon", "--daemon-socket", self.sock], env=self.env)
        self.procs.append(proc)
        self.wait_for_socket()
        return proc

    def shell_cli(self, binary, env):
        """Run `<binary> chat` the way a login shell does, in its own transient scope, as the VS Code shell ran in session-c155369.scope."""
        scope = f"pad-shell-{os.getpid()}-{time.monotonic_ns()}"
        cli_log = self.dir / "cli.json"
        args = ["systemd-run", "--user", "--scope", "--quiet", f"--unit={scope}"]
        for key, value in dict(env, FAKE_CLI_LOG=str(cli_log)).items():
            args += ["-E", f"{key}={value}"]
        done = subprocess.run([*args, str(binary), "chat"], capture_output=True, text=True, timeout=60, env=self.bus_env())
        return done, json.loads(cli_log.read_text())

    def bus_env(self):
        """Only what systemd-run needs to reach the user manager, so no live PRIME_AGENT_INTERNAL_* socket leaks into the scratch run."""
        return {k: os.environ[k] for k in ("PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if k in os.environ}

    def supervisor_cgroup(self):
        pid = int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1])
        return pid, Path(f"/proc/{pid}/cgroup").read_text().strip()

    def test_a_shell_cli_that_finds_no_daemon_gets_the_daemon_started_in_the_unit(self):
        if subprocess.call(["systemd-run", "--user", "--scope", "--quiet", "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            self.skipTest("no systemd user manager to make a scope and a unit in")
        unit = f"pad-daemon-{os.getpid()}-{time.monotonic_ns()}.service"
        env = {k: self.env[k] for k in ("FAKE_LOG", "FAKE_PIDS", "FAKE_ENV_LOG", "PRIME_AGENT_CODING_AGENT_DIR")}
        env.update(PATH=os.environ["PATH"], HOME=os.environ["HOME"], TMPDIR=str(self.dir), PRIME_AGENT_REAL_BIN=str(self.fake), PRIME_AGENT_DAEMON_UNIT=unit,
                   PRIME_AGENT_DAEMON_PIDFILE=self.pidfile, PRIME_AGENT_DAEMON_SOCKET=self.sock)
        # A scratch copy of prime-agent-daemon.service: Type=forking with the ctl's start and this PIDFile, never the live unit or socket.
        start = ["systemd-run", "--user", "--quiet", "--collect", f"--unit={unit}", "-p", "Type=forking", "-p", f"PIDFile={self.pidfile}"]
        for key, value in env.items():
            start += ["-E", f"{key}={value}"]
        start += [sys.executable, "-B", str(CTL), "start", str(WRAPPER), self.sock, self.pidfile]
        self.addCleanup(subprocess.call, ["systemctl", "--user", "stop", unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        start = ["env", "-i", *[f"{k}={v}" for k, v in self.bus_env().items()], *start]
        self.assertNotEqual(self.sock, "/tmp/prime-agent-%d/daemon.sock" % os.getuid())
        with self.subTest("without the wrapper the CLI's daemon lands in the shell's scope"):
            _, cli = self.shell_cli(self.fake, env)
            self.assertTrue(cli["spawned"])
            pid, group = self.supervisor_cgroup()
            self.assertEqual(group, cli["cgroup"].strip())
            os.kill(pid, signal.SIGKILL)
            Path(self.sock).unlink(missing_ok=True)
        with self.subTest("with the wrapper the unit starts it and the CLI finds it"):
            done, cli = self.shell_cli(WRAPPER, dict(env, PRIME_AGENT_DAEMON_START=shlex.join(start)))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn(f"so this starts {unit} first", done.stderr)
            self.assertFalse(cli["spawned"], "the CLI found the unit's daemon and spawned none")
            pid, group = self.supervisor_cgroup()
            self.assertTrue(group.endswith(f"/{unit}"), group)
            self.assertEqual(self.pid_in_file(), pid)
            self.assertEqual(subprocess.run(["systemctl", "--user", "show", "-p", "MainPID", "--value", unit], capture_output=True, text=True).stdout.strip(), str(pid))
        with self.subTest("a second shell CLI finds the live daemon and starts nothing"):
            done, cli = self.shell_cli(WRAPPER, dict(env, PRIME_AGENT_DAEMON_START="false"))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertNotIn("starts", done.stderr)
            self.assertFalse(cli["spawned"])
        with self.subTest("a daemon start on the public socket from a shell is refused"):
            done = subprocess.run([str(WRAPPER), "--mode", "daemon", "--daemon-socket", self.sock], env=dict(self.bus_env(), **env), capture_output=True, text=True, timeout=10)
            self.assertEqual(done.returncode, 2, done.stderr)

    def test_an_outside_supervisor_is_adopted_and_the_next_reload_starts_its_successor_in_the_unit(self):
        old = self.serve_outside()
        own = Path("/proc/self/cgroup").read_text()
        self.assertNotEqual(Path(f"/proc/{old.pid}/cgroup").read_text(), own)
        adopted = self.ctl("start", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(adopted.returncode, 0, adopted.stdout)
        self.assertEqual(self.pid_in_file(), old.pid)
        self.assertIn(f"supervisor {old.pid} runs outside this unit", adopted.stdout)
        self.assertIn("the next systemctl --user reload starts its successor inside this unit", adopted.stdout)
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("result=ok", result.stdout)
        new = self.pid_in_file()
        self.assertNotEqual(new, old.pid)
        self.assertEqual(Path(f"/proc/{new}/cgroup").read_text(), own)
        self.assertNotIn("runs outside this unit", result.stdout)

    def test_update_exits_0_and_tracks_a_successor_that_listens_after_the_coordinator_timed_out(self):
        # 10-18 06:47Z on us-metal02: the successor listened 2 s after Prime's coordinator gave up, the reload exited 5,
        # and systemd counted the dead MainPID as a stop and restarted the unit (NRestarts 0 to 1).
        old = self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_MODE="slow-successor", FAKE_BEHAVIOR="wait"))
        self.assertEqual(result.returncode, 0, result.stdout)
        new = self.pid_in_file()
        self.assertNotEqual(new, old.pid)
        self.assertEqual(int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1]), new)
        self.assertIn(f"result=restore-failed-successor-adopted restored 0 of 3; the coordinator failed, supervisor {new} owns {self.sock}; exit 0", result.stdout)
        self.assertNotIn("result=ok", result.stdout)
        self.assertNotIn("result=restart-failed", result.stdout)

    def test_update_waits_for_a_successor_that_holds_the_lock_after_its_own_daemon_hits_elocked(self):
        # A successor slower than the ctl's own daemon: that daemon exits with ELOCKED, and the reload used to fail
        # and restart the unit, as on 10-18 06:47Z.
        old = self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_MODE="slow-successor", FAKE_SUCCESSOR_DELAY="3", FAKE_BEHAVIOR="exit1"))
        self.assertEqual(result.returncode, 0, result.stdout)
        new = self.pid_in_file()
        self.assertNotEqual(new, old.pid)
        self.assertEqual(int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1]), new)
        self.assertIn(f"supervisor {new} still starts on it and holds its lock (ELOCKED); waiting for its hello", result.stdout)
        self.assertIn(f"result=restore-failed-successor-adopted restored 0 of 3; the coordinator failed, supervisor {new} owns", result.stdout)

    def test_start_logs_once_past_the_successor_deadline_and_keeps_waiting_for_the_lock_holder(self):
        loader = importlib.machinery.SourceFileLoader("daemon_ctl", str(CTL))
        ctl = importlib.util.module_from_spec(importlib.util.spec_from_loader("daemon_ctl", loader))
        loader.exec_module(ctl)
        ctl.SUCCESSOR_START_SECONDS = 0.5
        holder = subprocess.Popen([str(self.fake), "--mode", "daemon", "--daemon-socket", self.sock], env=dict(self.env, FAKE_LISTEN_DELAY="2.5"))
        self.procs.append(holder)
        err = io.StringIO()
        with mock.patch.dict(os.environ, dict(self.env, FAKE_BEHAVIOR="exit1"), clear=True), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ctl.start(str(self.fake), self.sock, self.pidfile), ctl.OK)
        self.assertEqual(self.pid_in_file(), holder.pid)
        self.assertEqual(err.getvalue().count("past the 0.5 s Prime allows a successor from launch to hello; still waiting for it"), 1, err.getvalue())

    def test_update_reports_a_failed_update_after_tracking_the_supervisor(self):
        self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, FAKE_UPDATE_CODE="4"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("result=failed", result.stdout)
        self.assertTrue(Path(self.pidfile).exists())

    def test_a_socket_outside_a_prime_agent_uid_directory_is_refused(self):
        result = self.ctl("start", str(self.fake), str(self.dir / "daemon.sock"), self.pidfile)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])


def proc_start_id(pid):
    return "proc:" + Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def load_ctl():
    loader = importlib.machinery.SourceFileLoader("prime_agent_daemon_ctl", str(CTL))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith("linux"), "the ctl reads /proc and runs only on the Linux box")
class SocketLockCleanupTest(unittest.TestCase):
    """A lock directory that a newer Prime left with owner.json in it, after a rollback to a binary that only rmdirs.

    Each test runs the ctl with env -i and an allowlist, in its own HOME, TMPDIR, socket and PI_POOL_DIR, and the fake
    daemon models mem.3's lock: it fails with ENOTEMPTY on a lock directory that is not empty.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pad-lock-", dir="/tmp")
        self.dir = Path(self.tmp.name)
        self.sockdir = self.dir / f"prime-agent-{os.getuid()}"
        self.sockdir.mkdir()
        (self.dir / "home").mkdir()
        (self.dir / "pool").mkdir()
        self.sock = str(self.sockdir / "daemon.sock")
        self.lock = Path(self.sock + ".lock")
        self.pidfile = str(self.dir / "daemon.pid")
        self.fake = self.dir / "prime-agent"
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(self.dir / "home"),
            "TMPDIR": str(self.dir),
            "PI_POOL_DIR": str(self.dir / "pool"),
            "FAKE_LOG": str(self.dir / "calls.jsonl"),
            "FAKE_PIDS": str(self.dir / "pids"),
            "FAKE_ENV_LOG": str(self.dir / "env.json"),
            "FAKE_LOCK": "mem3",
        }
        self.procs = []

    def tearDown(self):
        pids = Path(self.env["FAKE_PIDS"])
        for pid in pids.read_text().split() if pids.exists() else []:
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pid), signal.SIGKILL)
        for proc in self.procs:
            with contextlib.suppress(ProcessLookupError):
                os.kill(proc.pid, signal.SIGCONT)
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        self.tmp.cleanup()

    def hello_pid(self):
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(2)
            conn.connect(self.sock)
            hello = json.loads(conn.makefile().readline())
        self.assertEqual(hello["supervisorSocketPath"], self.sock)
        return hello["supervisorPid"]

    def popen(self, *argv):
        proc = subprocess.Popen(list(argv), env=self.env, stdout=subprocess.DEVNULL)
        self.procs.append(proc)
        return proc

    def owner_lock(self, pid, start_id, token="gen-1", extra=()):
        self.lock.mkdir(mode=0o700)
        owner = {"version": 1, "token": token, "pid": pid, "acquiredAt": "2026-10-18T11:00:00.000Z"}
        if start_id is not None:
            owner["processStartId"] = start_id
        (self.lock / "owner.json").write_text(json.dumps(owner) + "\n")
        for name in extra:
            (self.lock / name).write_text("")
        old = time.time() - 600
        os.utime(self.lock, (old, old))
        return os.stat(self.lock).st_ino

    def crashed_owner(self, **kwargs):
        owner = self.popen("sleep", "600")
        start_id = proc_start_id(owner.pid)
        ino = self.owner_lock(owner.pid, start_id, **kwargs)
        owner.kill()
        owner.wait()
        return owner.pid, ino

    def ctl(self, timeout=30):
        out = self.dir / "ctl.out"
        with open(out, "w") as sink:
            code = subprocess.call(["/usr/bin/env", "-i", *[f"{k}={v}" for k, v in self.env.items()], sys.executable, "-B", str(CTL), "start", str(self.fake), self.sock, self.pidfile], stdout=sink, stderr=subprocess.STDOUT, timeout=timeout)
        return code, out.read_text()

    def assert_lock_kept(self, ino, token="gen-1"):
        self.assertEqual(os.stat(self.lock).st_ino, ino)
        self.assertEqual(json.loads((self.lock / "owner.json").read_text())["token"], token)
        self.assertEqual(sorted(p.name for p in self.sockdir.iterdir() if p.name.startswith("daemon.sock.lock.")), [])

    def test_a_rolled_back_binary_starts_after_the_owner_of_a_new_format_lock_crashed(self):
        dead, _ = self.crashed_owner()
        code, out = self.ctl()
        self.assertEqual(code, 0, out)
        self.assertEqual(int(Path(self.pidfile).read_text()), self.hello_pid())
        self.assertIn(f"removed the stale socket lock {self.lock} of generation gen-1: pid {dead} has exited", out)
        self.assertEqual(list(self.lock.iterdir()), [])

    def test_a_pid_that_now_runs_another_process_loses_the_lock(self):
        reused = self.popen("sleep", "600")
        self.owner_lock(reused.pid, "proc:1")
        code, out = self.ctl()
        self.assertEqual(code, 0, out)
        self.assertIn(f"pid {reused.pid} now runs another process (start id {proc_start_id(reused.pid)}, owner.json records proc:1)", out)
        self.assertIsNone(reused.poll())
        self.assertEqual(int(Path(self.pidfile).read_text()), self.hello_pid())

    def test_a_live_owner_keeps_its_lock_however_old(self):
        owner = self.popen("sleep", "600")
        ino = self.owner_lock(owner.pid, proc_start_id(owner.pid))
        code, out = self.ctl()
        self.assertNotEqual(code, 0, out)
        self.assert_lock_kept(ino)
        self.assertIn(f"pid {owner.pid} is alive with the recorded start id", out)

    def test_a_halted_owner_keeps_its_lock(self):
        owner = self.popen("sleep", "600")
        os.kill(owner.pid, signal.SIGSTOP)
        ino = self.owner_lock(owner.pid, proc_start_id(owner.pid))
        code, out = self.ctl()
        self.assertNotEqual(code, 0, out)
        self.assert_lock_kept(ino)
        self.assertIsNone(owner.poll())

    def test_a_live_owner_with_no_start_id_keeps_its_lock(self):
        owner = self.popen("sleep", "600")
        ino = self.owner_lock(owner.pid, None)
        code, out = self.ctl()
        self.assertNotEqual(code, 0, out)
        self.assert_lock_kept(ino)
        self.assertIn("records no start id, so pid reuse cannot be told apart from the owner", out)

    def test_a_lock_without_owner_json_or_with_unknown_entries_stays(self):
        for extra, reason in (((), None), (("socket.json",), "it holds entries Prime does not write there: socket.json")):
            with self.subTest(extra=extra):
                dead, ino = self.crashed_owner(extra=extra)
                if not extra:
                    (self.lock / "owner.json").unlink()
                    reason = "it has no owner.json, so no generation names its owner"
                code, out = self.ctl()
                self.assertNotEqual(code, 0, out)
                self.assertEqual(os.stat(self.lock).st_ino, ino)
                self.assertIn(f"left the socket lock {self.lock} in place: {reason}", out)
                for entry in self.lock.iterdir():
                    entry.unlink()
                self.lock.rmdir()

    def test_two_starters_racing_clean_once_and_adopt_one_supervisor(self):
        self.crashed_owner()
        with open(self.sock + ".ctl-cleanup.flock", "a") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            sinks = [open(self.dir / f"ctl-{n}.out", "w") for n in (1, 2)]
            ctls = [subprocess.Popen(["/usr/bin/env", "-i", *[f"{k}={v}" for k, v in self.env.items()], sys.executable, "-B", str(CTL), "start", str(self.fake), self.sock, str(self.dir / f"daemon-{n}.pid")], stdout=sink, stderr=subprocess.STDOUT) for n, sink in zip((1, 2), sinks)]
            self.procs.extend(ctls)
            time.sleep(0.5)
        codes = [c.wait(timeout=30) for c in ctls]
        for sink in sinks:
            sink.close()
        outs = [(self.dir / f"ctl-{n}.out").read_text() for n in (1, 2)]
        self.assertEqual(codes, [0, 0], outs)
        winner = self.hello_pid()
        self.assertEqual([int((self.dir / f"daemon-{n}.pid").read_text()) for n in (1, 2)], [winner, winner])
        self.assertEqual(sum(o.count("removed the stale socket lock") for o in outs), 1, outs)
        self.assertEqual(sorted(p.name for p in self.sockdir.iterdir() if p.name.startswith("daemon.sock.lock.")), [])

    def test_a_generation_that_replaces_the_lock_while_it_is_judged_is_never_removed(self):
        ctl = load_ctl()
        self.crashed_owner()
        judge = ctl.owner_gone

        def replaced_while_judged(owner):
            os.rename(self.lock, self.dir / "reclaimed")
            self.owner_lock(os.getpid(), proc_start_id(os.getpid()), token="gen-2")
            return judge(owner)

        with mock.patch.object(ctl, "owner_gone", replaced_while_judged), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertFalse(ctl.clear_dead_lock(self.sock))
        self.assertEqual(json.loads((self.lock / "owner.json").read_text())["token"], "gen-2")
        self.assertIn("another generation replaced it", err.getvalue())

    def test_the_new_owner_is_put_back_when_it_takes_the_path_during_the_rename(self):
        ctl = load_ctl()
        self.crashed_owner()
        rename = ctl.rename_noreplace

        def swapped(old, new):
            if old == str(self.lock):
                os.rename(self.lock, self.dir / "reclaimed")
                self.owner_lock(os.getpid(), proc_start_id(os.getpid()), token="gen-2")
            return rename(old, new)

        with mock.patch.object(ctl, "rename_noreplace", swapped), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertFalse(ctl.clear_dead_lock(self.sock))
        self.assertEqual(json.loads((self.lock / "owner.json").read_text())["token"], "gen-2")
        self.assertIn("another generation replaced it during the rename, so it was put back", err.getvalue())



    def test_a_daemon_still_starting_on_the_socket_keeps_the_lock(self):
        ctl = load_ctl()
        _, ino = self.crashed_owner()
        starting = subprocess.Popen([str(self.fake), "--mode", "daemon", "--daemon-socket", self.sock], env=dict(self.env, FAKE_BEHAVIOR="wait"))
        self.procs.append(starting)
        deadline = time.time() + 10
        while not Path(self.env["FAKE_LOG"]).exists() and time.time() < deadline:
            time.sleep(0.02)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertFalse(ctl.clear_dead_lock(self.sock))
        self.assert_lock_kept(ino)
        self.assertIn(f"prime-agent daemon {starting.pid} still runs on {self.sock}", err.getvalue())

    def test_the_cleanup_waits_for_a_competing_starter_that_holds_the_cleanup_flock(self):
        ctl = load_ctl()
        _, ino = self.crashed_owner()
        result = []
        with open(self.sock + ".ctl-cleanup.flock", "a") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            worker = threading.Thread(target=lambda: result.append(ctl.clear_dead_lock(self.sock)))
            with contextlib.redirect_stderr(io.StringIO()):
                worker.start()
                time.sleep(0.5)
                self.assertEqual(result, [])
                self.assert_lock_kept(ino)
                fcntl.flock(guard, fcntl.LOCK_UN)
                worker.join(timeout=10)
        self.assertEqual(result, [True])
        self.assertFalse(self.lock.exists())

class DaemonUnitTest(unittest.TestCase):
    def test_unit_tracks_the_supervisor_through_the_pidfile(self):
        unit = {}
        for line in UNIT.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                unit.setdefault(key, value)
        self.assertEqual(unit["Type"], "forking")
        self.assertEqual(unit["PIDFile"], "%t/prime-agent-daemon.pid")
        self.assertEqual(unit["KillMode"], "process")
        self.assertEqual(unit["Restart"], "always")
        for key, command, extra in (("ExecStart", "start", []), ("ExecReload", "update", ["%h/.config/sieun-pi/prime-update.env"])):
            argv = unit[key].split()
            self.assertEqual(argv[:2], ["%h/.local/bin/prime-agent-daemon-ctl", command])
            self.assertEqual(argv[3:], ["/tmp/prime-agent-%U/daemon.sock", unit["PIDFile"], *extra])

    def test_a_reload_gets_its_update_args_from_the_env_file_and_no_timeout(self):
        lines = UNIT.read_text().splitlines()
        self.assertIn("EnvironmentFile=-%h/.config/sieun-pi/prime-update.env", lines)
        self.assertIn("TimeoutStartSec=infinity", lines)
        self.assertFalse([line for line in lines if line.startswith(("TimeoutSec=", "TimeoutReloadSec="))])


FAKE_SYSTEMCTL = textwrap.dedent(
    """\
    #!/bin/bash
    S=$FAKE_STATE
    case "$*" in
      *"-p MainPID"*) echo "$FAKE_MAINPID";;
      *"-p ActiveState"*) [ -e $S/reloading ] && echo reloading || echo active;;
      *"reload --no-block"*)
        touch $S/reloading; cp ~/.config/sieun-pi/prime-update.env $S/env-at-reload
        setsid -f bash -c "sleep $FAKE_RELOAD_SECONDS; echo \\"${FAKE_RESULT_LINE:-prime-agent-daemon-ctl: result=ok updated}\\" >> $S/journal; : > ~/.config/sieun-pi/prime-update.env; rm $S/reloading" < /dev/null > /dev/null 2>&1;;
      *list-jobs*) ;;
      *is-active*) echo active;;
    esac
    """
)


@unittest.skipUnless(sys.platform.startswith("linux"), "the script reads /proc and runs only on the Linux box")
class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="pad-install-", dir="/tmp")
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "home"
        self.state = Path(tmp.name) / "state"
        self.feed = Path(tmp.name) / "feed"
        for d in (self.home / ".local/bin", self.home / ".config/sieun-pi", self.state, self.feed):
            d.mkdir(parents=True)
        fakes = {"systemctl": FAKE_SYSTEMCTL, "journalctl": f"#!/bin/bash\ncat {self.state}/journal 2>/dev/null\n", "prime-agent": "#!/bin/bash\necho fake-prime\n"}
        for name, text in fakes.items():
            (self.home / ".local/bin" / name).write_text(text)
            (self.home / ".local/bin" / name).chmod(0o755)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "FAKE_STATE": str(self.state), "FAKE_MAINPID": str(os.getpid()), "FAKE_RELOAD_SECONDS": "8", "PRIME_INSTALL_UNIT": "pad-fake", "PRIME_INSTALL_FEED_PORT": str(self.port)}

    def wait_for_result(self, log):
        result = Path(f"{log}.result")
        deadline = time.time() + 30
        while not result.exists() and time.time() < deadline:
            time.sleep(0.2)
        return result.read_text()

    def test_a_run_survives_its_caller_being_killed_5_s_in_as_prime_prepare_does(self):
        caller = subprocess.Popen(["bash", "-c", f"{INSTALL} {self.feed} python; sleep 60"], env=self.env, stdout=subprocess.PIPE, text=True, start_new_session=True)
        log = Path(caller.stdout.readline().strip())
        time.sleep(5)
        os.killpg(caller.pid, signal.SIGTERM)
        caller.wait(timeout=10)
        caller.stdout.close()
        self.assertFalse(Path(f"{log}.result").exists(), "the update must still be running when the caller dies")
        self.assertIn("PRIME_UPDATE_ARGS=--force", (self.state / "env-at-reload").read_text())
        self.assertEqual(self.wait_for_result(log), "result=ok rc=0\n", log.read_text())
        self.assertIn("daemon on new build", log.read_text())
        self.assertEqual((self.home / ".config/sieun-pi/prime-update.env").read_text(), "")
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", self.port)), 0, "the feed server must stop with the run")

    def test_an_adopted_successor_after_a_failed_restore_is_never_reported_ok(self):
        # chat-057a, 10-18: a healthy unit after the 06:47Z restore of 0 of 91 sessions is not a successful update.
        line = "prime-agent-daemon-ctl: result=restore-failed-successor-adopted restored 0 of 91; the coordinator failed, supervisor 1 owns s"
        env = dict(self.env, FAKE_RELOAD_SECONDS="1", FAKE_RESULT_LINE=line)
        out = subprocess.run([str(INSTALL), str(self.feed), "python"], env=env, capture_output=True, text=True, timeout=30)
        log = Path(out.stdout.splitlines()[0])
        self.assertEqual(self.wait_for_result(log), "result=restore-failed-successor-adopted rc=1\n", log.read_text())
        self.assertIn("the coordinator's restore failed (restored 0 of 91)", log.read_text())

    def test_a_good_update_deletes_the_releases_nothing_runs(self):
        # 10-18: us-metal02 held six Prime releases of about 165 MB each, and nothing ran four of them.
        releases = self.home / ".local/share/prime-agent/releases"
        for name in ("old", "previous", "current", "in-use"):
            (releases / name).mkdir(parents=True)
        bin_dir = self.home / ".local/share/prime-agent/bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "prime-agent").symlink_to("../releases/current/prime-agent")
        (bin_dir / "previous").symlink_to("../releases/previous/prime-agent")
        user = subprocess.Popen(["sleep", "60"], cwd=releases / "in-use")
        self.addCleanup(user.kill)
        out = subprocess.run([str(INSTALL), str(self.feed), "python"], env=dict(self.env, FAKE_RELOAD_SECONDS="1"), capture_output=True, text=True, timeout=30)
        log = Path(out.stdout.splitlines()[0])
        self.assertEqual(self.wait_for_result(log), "result=ok rc=0\n", log.read_text())
        self.assertEqual(sorted(p.name for p in releases.iterdir()), ["current", "in-use", "previous"])
        self.assertIn("removed release old, which nothing runs", log.read_text())


class ChatUnitTest(unittest.TestCase):
    def test_a_chat_stop_kills_the_helpers_it_left_and_never_starts_a_daemon(self):
        lines = CHAT_UNIT.read_text().splitlines()
        self.assertIn("KillMode=mixed", lines)
        self.assertIn("Environment=SIEUN_PI_CHAT_START_DAEMON=0", lines)


if __name__ == "__main__":
    unittest.main()
