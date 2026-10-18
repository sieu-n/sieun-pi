import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CTL = ROOT / "deploy/linux/prime-agent-daemon-ctl"
UNIT = ROOT / "deploy/linux/prime-agent-daemon.service"
CHAT_UNIT = ROOT / "deploy/linux/sieun-pi-chat.service"

FAKE = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, socket, subprocess, sys, time
    log = os.environ["FAKE_LOG"]
    with open(log, "a") as f:
        f.write(json.dumps({"pid": os.getpid(), "argv": sys.argv[1:]}) + "\\n")
    if sys.argv[1] == "update":
        keys = ("TMPDIR", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "PRIME_AGENT_INTERNAL_DAEMON_WORKER", "PRIME_AGENT_INTERACTIVE_SELF_UPDATE", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", "PRIME_UPDATE_ARGS")
        with open(os.environ["FAKE_ENV_LOG"], "w") as f:
            json.dump({k: os.environ.get(k) for k in keys}, f)
        mode = os.environ.get("FAKE_UPDATE_MODE", "restart")
        if mode == "busy":
            print("Prime Agent has 1 busy session. After the update installs, it will stop it, restart its background service, and resume interrupted work. Re-run with --force to proceed.", file=sys.stderr)
            sys.exit(1)
        if mode == "prepare":
            print("Updated Prime Agent from v1 to v2")
            print("Warning: Updated, but could not restart the daemon (Could not prepare daemon sessions for automatic resume; the previous daemon is still running (Cannot prepare update restart while resident worker 6acc196dee81 is failed and disconnected (session s)))).", file=sys.stderr)
            sys.exit(0)
        if mode == "restart-failed":
            print("Warning: Updated, but could not restart the daemon (Could not stop the predecessor daemon on x).", file=sys.stderr)
            sys.exit(0)
        if "--daemon-socket" in sys.argv:
            print("Package updates moved to the package command.", file=sys.stderr)
            sys.exit(1)
        sock = os.environ["PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET"]
        old = int(open(os.environ["FAKE_PIDS"]).read().split()[-1])
        os.kill(old, 15)
        while os.path.exists(sock):
            time.sleep(0.01)
        env = dict(os.environ, FAKE_BEHAVIOR="serve")
        subprocess.Popen([sys.argv[0], "--mode", "daemon", "--daemon-socket", sock], env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(int(os.environ.get("FAKE_UPDATE_CODE", "0")))
    sock = sys.argv[sys.argv.index("--daemon-socket") + 1]
    with open(os.environ["FAKE_ENV_LOG"] + ".daemon", "w") as f:
        json.dump({"TMPDIR": os.environ.get("TMPDIR"), "socket": os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET")}, f)
    behavior = os.environ.get("FAKE_BEHAVIOR", "serve")
    if behavior.startswith("exit"):
        sys.exit(int(behavior[4:]))
    if behavior == "wait":
        time.sleep(60)
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
        )
        for key in ("PRIME_UPDATE_ARGS", "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET", "PRIME_AGENT_INTERACTIVE_SELF_UPDATE"):
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

    def env_seen(self, suffix=""):
        return json.loads(Path(self.env["FAKE_ENV_LOG"] + suffix).read_text())

    def test_update_forwards_prime_update_args_and_tracks_the_successor(self):
        old = self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, PRIME_UPDATE_ARGS="--rollback --force"))
        self.assertEqual(result.returncode, 0, result.stdout)
        updates = [c for c in self.calls() if c["argv"][0] == "update"]
        self.assertEqual(updates[0]["argv"], ["update", "--rollback", "--force"])
        new = self.pid_in_file()
        self.assertNotEqual(new, old.pid)
        self.assertEqual(int(Path(self.env["FAKE_PIDS"]).read_text().split()[-1]), new)
        self.assertIn("result=ok", result.stdout)
        self.assertIsNone(self.env_seen()["PRIME_UPDATE_ARGS"])

    def test_update_without_prime_update_args_runs_a_plain_update(self):
        self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual([c["argv"] for c in self.calls() if c["argv"][0] == "update"], [["update"]])

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
                "PRIME_AGENT_INTERACTIVE_SELF_UPDATE": None,
                "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR": str(self.dir / "owners"),
                "PRIME_UPDATE_ARGS": None,
            },
        )

    def test_start_pins_the_daemon_it_launches_to_the_socket_argument(self):
        wrong = dict(self.env, TMPDIR="/tmp/pad-wrong-tmp", PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET="/tmp/pad-wrong/daemon.sock")
        result = self.ctl("start", str(self.fake), self.sock, self.pidfile, env=wrong)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.env_seen(".daemon"), {"TMPDIR": str(self.dir), "socket": None})

    def test_update_refuses_args_other_than_force_and_rollback(self):
        self.serve()
        result = self.ctl("update", str(self.fake), self.sock, self.pidfile, env=dict(self.env, PRIME_UPDATE_ARGS="--force --daemon-socket /tmp/x"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("result=usage", result.stdout)
        self.assertEqual([c for c in self.calls() if c["argv"][0] == "update"], [])

    def test_update_reports_a_busy_session_refusal_apart_from_a_prepare_refusal(self):
        cases = (("busy", 3, "result=busy-refused"), ("prepare", 4, "result=prepare-refused"), ("restart-failed", 5, "result=restart-failed"))
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
        for key, command in (("ExecStart", "start"), ("ExecReload", "update")):
            argv = unit[key].split()
            self.assertEqual(argv[:2], ["%h/.local/bin/prime-agent-daemon-ctl", command])
            self.assertEqual(argv[3:], ["/tmp/prime-agent-%U/daemon.sock", unit["PIDFile"]])

    def test_a_reload_gets_its_update_args_from_the_env_file_and_no_timeout(self):
        lines = UNIT.read_text().splitlines()
        self.assertIn("EnvironmentFile=-%h/.config/sieun-pi/prime-update.env", lines)
        self.assertIn("TimeoutStartSec=infinity", lines)
        self.assertFalse([line for line in lines if line.startswith(("TimeoutSec=", "TimeoutReloadSec="))])


class ChatUnitTest(unittest.TestCase):
    def test_a_chat_stop_kills_the_helpers_it_left_and_never_starts_a_daemon(self):
        lines = CHAT_UNIT.read_text().splitlines()
        self.assertIn("KillMode=mixed", lines)
        self.assertIn("Environment=SIEUN_PI_CHAT_START_DAEMON=0", lines)


if __name__ == "__main__":
    unittest.main()
