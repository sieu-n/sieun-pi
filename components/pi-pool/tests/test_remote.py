"""pool/remote.py: one machine's pi-pool asks another machine's `pi-pool serve` for tokens
and account commands, and keeps turn slots to itself."""
import json, os, shutil, socket, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()
    os.environ["PI_POOL_TEST_ALLOW_LOOPBACK"] = "1"


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(SOURCE, "bin", "pi-pool-token")
CLI = os.path.join(SOURCE, "bin", "pi-pool")
SECRET = "fixture-secret-0123456789"

HOLDER_HOOK = """import json, os, sys, time
key = json.loads(os.environ.get("PI_POOL_SESSION_KEY") or "null")
if key and key["key"] == "fixture-slow":
    time.sleep(12)
if key and key["key"] == "fixture-slot":
    sys.stderr.write("pi-pool-token: no token (slot_wait)\\n")
    if os.environ.get("PRIME_CREDENTIAL_COMMAND_PROTOCOL") == "1":
        sys.stdout.write(json.dumps({"retryAt": 1792410455, "message": "waiting for an account slot"}))
        sys.exit(75)
    sys.exit(1)
if key and key["key"] == "fixture-waits":
    sys.stderr.write("pi-pool-token: no token (no_account)\\n")
    sys.exit(1)
sys.stdout.write("sk-ant-oat-fixture-" + json.dumps([sys.argv[1:], key, os.environ.get("PI_POOL_REMOTE")]))
"""
HOLDER_CLI = """import json, os, sys
given = sys.stdin.read()
print(json.dumps({"argv": sys.argv[1:], "key": json.loads(os.environ.get("PI_POOL_SESSION_KEY") or "null"),
                  **({"stdin": given} if given else {})}))
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def events(pool):
    try:
        with open(os.path.join(pool, "pi-pool.log")) as f:
            return [json.loads(line) for line in f]
    except FileNotFoundError:
        return []


class Remote(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="pi-pool-remote-")
        holder = os.path.join(cls.root, "holder")
        os.makedirs(os.path.join(holder, "bin"))
        for name, text in (("pi-pool-token", HOLDER_HOOK), ("pi-pool", HOLDER_CLI)):
            with open(os.path.join(holder, "bin", name), "w") as f:
                f.write(text)
        cls.port = free_port()
        with open(os.path.join(holder, "serve.json"), "w") as f:
            json.dump({"host": "127.0.0.1", "port": cls.port, "secret": SECRET, "root": holder}, f)
        env = dict(os.environ, PI_POOL_DIR=holder)
        cls.server = subprocess.Popen([sys.executable, "-B", CLI, "serve"], env=env, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 20
        while True:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=1).close()
                break
            except OSError:
                if cls.server.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError("pi-pool serve did not start: " + cls.server.stderr.read().decode())
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(10)
        cls.server.stderr.close()
        shutil.rmtree(cls.root, True)

    def client(self, secret=SECRET, port=None):
        pool = tempfile.mkdtemp(prefix="client-", dir=self.root)
        with open(os.path.join(pool, "remote.json"), "w") as f:
            json.dump({"url": f"http://127.0.0.1:{port or self.port}", "secret": secret}, f)
        return pool

    def run_on(self, pool, argv, session="fixture-box", cwd=None, protocol=None):
        env = dict(os.environ, PI_POOL_DIR=pool,
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=session)
        env.pop("PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL", None)
        env.pop("PRIME_CREDENTIAL_COMMAND_PROTOCOL", None)
        if protocol:
            env["PRIME_CREDENTIAL_COMMAND_PROTOCOL"] = protocol
        return subprocess.run([sys.executable, "-B", *argv], env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60, cwd=cwd)

    def no_token_reason(self, pool):
        [e] = [e for e in events(pool) if e["event"] == "hook_no_token"]
        return e["reason"]

    def test_the_token_comes_from_the_holder_with_this_machines_session_key(self):
        run = self.run_on(self.client(), [HOOK, "--provider", "openai-codex"])
        self.assertEqual(run.returncode, 0, run.stderr)
        prefix = "sk-ant-oat-fixture-"
        self.assertTrue(run.stdout.startswith(prefix), run.stdout)
        argv, key, remote = json.loads(run.stdout[len(prefix):])
        self.assertEqual(argv, ["--provider", "openai-codex"])
        self.assertEqual(key, {"key": "fixture-box", "uuid": None, "active": "fixture-box"})
        self.assertEqual(remote, "off")

    def test_an_account_command_runs_on_the_holder(self):
        run = self.run_on(self.client(), [CLI, "who", "--json"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {"argv": ["who", "--json"], "key": {"key": "fixture-box", "uuid": None, "active": "fixture-box"}})

    def test_turn_slots_stay_on_this_machine(self):
        pool = self.client(port=free_port())
        run = self.run_on(pool, [CLI, "queue", "--json"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("working", json.loads(run.stdout))

    def test_the_holders_reason_is_logged_here_when_it_gives_no_token(self):
        pool = self.client()
        run = self.run_on(pool, [HOOK], session="fixture-waits")
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "")
        self.assertEqual(self.no_token_reason(pool), "no_account")

    def test_the_holders_slot_wait_reaches_a_prime_that_reads_exit_75(self):
        pool = self.client()
        run = self.run_on(pool, [HOOK, "--provider", "openai-codex"], session="fixture-slot", protocol="1")
        self.assertEqual((run.returncode, json.loads(run.stdout)),
                         (75, {"retryAt": 1792410455, "message": "waiting for an account slot"}))
        self.assertEqual(self.no_token_reason(pool), "slot_wait")

    def test_the_holders_slot_wait_stays_exit_1_for_an_older_prime(self):
        pool = self.client()
        run = self.run_on(pool, [HOOK, "--provider", "openai-codex"], session="fixture-slot")
        self.assertEqual((run.returncode, run.stdout, run.stderr), (1, "", "pi-pool-token: no token (slot_wait)\n"))
        self.assertEqual(self.no_token_reason(pool), "slot_wait")

    def test_a_wrong_secret_gets_no_token_and_logs_why(self):
        pool = self.client(secret="wrong")
        run = self.run_on(pool, [HOOK])
        self.assertEqual((run.returncode != 0, run.stdout), (True, ""))
        self.assertEqual(self.no_token_reason(pool), "remote_refused")

    def test_an_unreachable_holder_gets_no_token_and_logs_why(self):
        pool = self.client(port=free_port())
        run = self.run_on(pool, [HOOK])
        self.assertEqual((run.returncode != 0, run.stdout), (True, ""))
        self.assertEqual(self.no_token_reason(pool), "remote_unreachable")

    def test_a_holder_slower_than_the_hook_limit_gets_no_token_and_logs_why(self):
        pool = self.client()
        run = self.run_on(pool, [HOOK], session="fixture-slow")
        self.assertEqual((run.returncode != 0, run.stdout), (True, ""))
        self.assertEqual(self.no_token_reason(pool), "remote_timeout")

    def test_a_terminal_command_is_refused_by_the_holder(self):
        run = self.run_on(self.client(), [CLI, "watch"])
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("HTTP 400", run.stderr)

    def test_a_login_filed_from_another_machine_reaches_the_holder_on_stdin_only(self):
        code = ("import importlib.util, json, os, sys; s = importlib.util.spec_from_file_location('vend', 'vend.py'); "
                "m = importlib.util.module_from_spec(s); sys.modules['vend'] = m; s.loader.exec_module(m); r = m.pool.remote; "
                "print(json.dumps(r.ask(r.client(), ['--cli', 'file-login'], stdin=os.environ['FIXTURE_STDIN'])))")
        os.environ["FIXTURE_STDIN"] = '{"secret": 1}'
        self.addCleanup(os.environ.pop, "FIXTURE_STDIN")
        run = self.run_on(self.client(), ["-c", code], cwd=SOURCE)
        self.assertEqual(run.returncode, 0, run.stderr)
        exit_code, out, _ = json.loads(run.stdout)
        self.assertEqual((exit_code, json.loads(out)["argv"], json.loads(out)["stdin"]), (0, ["file-login"], '{"secret": 1}'))


if __name__ == "__main__":
    unittest.main()
