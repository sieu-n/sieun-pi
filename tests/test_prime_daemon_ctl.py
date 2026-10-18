import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
import json
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
FEED = ("PRIME_AGENT_DOWNLOAD_BASE_URL", "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS")

FAKE = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, socket, subprocess, sys, time
    log = os.environ["FAKE_LOG"]
    with open(log, "a") as f:
        f.write(json.dumps({"pid": os.getpid(), "argv": sys.argv[1:]}) + "\\n")
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
            with open(status_path, "w") as f:
                json.dump({"phase": phase, "counts": {"total": 1, "restored": 1, "resumed": 1, "failed": 0}, **extra}, f)
        if mode == "prepare":
            status("failed", message="Could not prepare daemon sessions for automatic resume; the previous daemon is still running (Cannot prepare update restart while resident worker 6acc196dee81 is failed and disconnected (session s))")
            sys.exit(1)
        if mode == "restart-failed":
            status("failed", message="Could not stop the predecessor daemon on x")
            sys.exit(1)
        old = int(open(os.environ["FAKE_PIDS"]).read().split()[-1])
        os.kill(old, 15)
        while os.path.exists(sock):
            time.sleep(0.01)
        env = dict(os.environ, FAKE_BEHAVIOR="serve", FAKE_LISTEN_DELAY=os.environ.get("FAKE_SUCCESSOR_DELAY", "2") if mode == "slow-successor" else "0")
        subprocess.Popen([sys.argv[0], "--mode", "daemon", "--daemon-socket", sock], env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if mode == "slow-successor":
            status("failed", message=f"Timed out waiting for daemon to start on {sock}.", counts={"total": 3, "restored": 0, "resumed": 0, "failed": 0})
            sys.exit(1)
        status("complete")
        sys.exit(0)
    sock = sys.argv[sys.argv.index("--daemon-socket") + 1]
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
    server = socket.socket(socket.AF_UNIX)
    server.bind(sock)
    server.listen(8)
    with open(os.environ["FAKE_PIDS"], "a") as f:
        f.write(f"{os.getpid()}\\n")
    import signal
    def stop(*_):
        os.unlink(sock)
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
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
        # A restart failure whose successor start() adopts exits 0, so systemd keeps the unit active and reads the PIDFile.
        cases = (("busy", 3, "result=busy-refused"), ("prepare", 4, "result=prepare-refused"), ("restart-failed", 0, "result=restore-failed-successor-adopted restored 1 of 1"))
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


class ChatUnitTest(unittest.TestCase):
    def test_a_chat_stop_kills_the_helpers_it_left_and_never_starts_a_daemon(self):
        lines = CHAT_UNIT.read_text().splitlines()
        self.assertIn("KillMode=mixed", lines)
        self.assertIn("Environment=SIEUN_PI_CHAT_START_DAEMON=0", lines)


if __name__ == "__main__":
    unittest.main()
