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

HOLDER_HOOK = """import json, os, sys
key = json.loads(os.environ.get("PI_POOL_SESSION_KEY") or "null")
if key and key["key"] == "fixture-waits":
    sys.stderr.write("pi-pool-token: no token (no_account)\\n")
    sys.exit(1)
sys.stdout.write("sk-ant-oat-fixture-" + json.dumps([sys.argv[1:], key, os.environ.get("PI_POOL_REMOTE")]))
"""
HOLDER_CLI = """import json, os, sys
print(json.dumps({"argv": sys.argv[1:], "key": json.loads(os.environ.get("PI_POOL_SESSION_KEY") or "null")}))
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

    def run_on(self, pool, argv, session="fixture-box"):
        env = dict(os.environ, PI_POOL_DIR=pool,
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=session)
        env.pop("PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL", None)
        return subprocess.run([sys.executable, "-B", *argv], env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60)

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

    def test_a_terminal_command_is_refused_by_the_holder(self):
        run = self.run_on(self.client(), [CLI, "login"])
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("HTTP 400", run.stderr)


if __name__ == "__main__":
    unittest.main()
