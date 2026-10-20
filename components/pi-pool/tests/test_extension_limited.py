"""A 429 the pool cannot record still loses the vendor reset. On 10-19 35 of 1,927 anthropic 429s on us-metal02
kept the vendor text: each `pi-pool limited` call met a pool flock busy past STATE_LOCK_TIMEOUT, exited 1 with no
log line, and the session slept until the reset, up to 4.2 h. The handler runs against the real CLI in a pool
folder of its own, with this process holding the pool lock."""
import fcntl, json, os, shutil, subprocess, sys, tempfile, time, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent
EXTENSION = TESTS.parent / "app" / "extension" / "index.ts"
VEND = TESTS.parent / "vend.py"
A, B = "aaaa1111-0000-0000-0000-000000000000", "bbbb2222-0000-0000-0000-000000000000"
SESSION = "01a1-ext-429-tree"
RESET_MS = 3 * 3600 * 1000


class PoolFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pi-pool-ext-limited-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.pool = os.path.join(self.root, "pool")
        os.makedirs(os.path.join(self.pool, "accounts"))
        for provider, accounts in (("anthropic", [A, B]), ("openai-codex", [])):
            with open(os.path.join(self.pool, "accounts", f"{provider}.json"), "w") as f:
                json.dump({"version": 1, "accounts": [{"id": i, "email": i[0] + "@x", "label": i[0] + "@x", "windows": []} for i in accounts]}, f)
        now = time.time()
        with open(os.path.join(self.pool, "state.json"), "w") as f:
            json.dump({"version": 2, "providers": {p: {"pin": None, "cooldowns": {}, "disabled": {}} for p in ("anthropic", "openai-codex")},
                       "sessions": {SESSION: {"uuid": SESSION, "active_id": None, "last_seen": now, "pins": {},
                                              "vends": {"anthropic": {"account_id": A, "email": "a@x", "at": now - 60, "n": 3}}}}}, f)
        self.env = dict(os.environ, HOME=self.root, PI_POOL_DIR=self.pool, PI_POOL_SECRETS="file",
                        PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=SESSION)
        self.env.pop("PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL", None)

    def message_end(self):
        done = subprocess.run(["node", str(TESTS / "limited_driver.mjs"), str(EXTENSION), str(RESET_MS)],
                              env=self.env, capture_output=True, text=True, timeout=60)
        if done.returncode:
            raise AssertionError(done.stdout + done.stderr)
        return json.loads(done.stdout.strip().splitlines()[-1])

    def hold_lock(self):
        fd = os.open(os.path.join(self.pool, "lock"), os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        return lambda: fcntl.flock(fd, fcntl.LOCK_UN)

    def cli(self, *args, code=None):
        done = subprocess.run([sys.executable, "-B", str(VEND), "--cli", *args], env=self.env, capture_output=True, text=True, timeout=60)
        if code is not None:
            self.assertEqual(done.returncode, code, done.stdout + done.stderr)
        return done

    def python(self, code):
        """`code` in a fresh process with this pool's package as `pool`; returns the exit code."""
        prelude = f"import os, sys\nsys.path.insert(0, {str(TESTS.parent)!r})\nimport vend\npool = vend.pool\n"
        return subprocess.run([sys.executable, "-B", "-c", prelude + code], env=self.env, capture_output=True, text=True, timeout=60)

    def events(self, *names):
        try:
            with open(os.path.join(self.pool, "pi-pool.log")) as f:
                return [e for e in map(json.loads, f) if e["event"] in names]
        except FileNotFoundError:
            return []

    def state(self):
        with open(os.path.join(self.pool, "state.json")) as f:
            return json.load(f)

    def spooled(self):
        folder = os.path.join(self.pool, "limited-spool")
        if not os.path.isdir(folder):
            return []
        out = []
        for name in sorted(os.listdir(folder)):
            with open(os.path.join(folder, name)) as f:
                out.append(json.load(f))
        return out


class LimitedLockBusy(PoolFixture):
    def test_a_free_lock_moves_the_retry_to_another_account(self):
        message = self.message_end()
        self.assertIn("pi-pool: a@x is limited until", message["errorMessage"])
        self.assertNotIn("retryAfterMs", message["diagnostics"][0]["details"])

    def test_a_busy_lock_still_drops_the_vendor_reset(self):
        fd = os.open(os.path.join(self.pool, "lock"), os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        message = self.message_end()
        self.assertIn("pi-pool:", message["errorMessage"])
        self.assertNotIn("retryAfterMs", message["diagnostics"][0]["details"])
        self.assertEqual(message["diagnostics"][0]["details"]["status"], 429)


class LimitedSpool(PoolFixture):
    """A 429 whose `limited` run meets a busy pool flock goes to the limited spool (pool/limited.py), and the next
    holder of the flock applies it once."""

    def spool_a_429(self):
        release = self.hold_lock()
        message = self.message_end()
        return message, release

    def test_an_auto_429_under_a_busy_lock_gets_the_pools_next_account(self):
        message, _ = self.spool_a_429()
        self.assertIn("pi-pool: a@x is limited until", message["errorMessage"])
        self.assertIn("the retry uses b@x", message["errorMessage"])
        self.assertNotIn("retryAfterMs", message["diagnostics"][0]["details"])
        [event] = self.spooled()
        self.assertEqual((event["provider"], event["account_id"], event["tree"]), ("anthropic", A, SESSION))
        self.assertAlmostEqual(event["until"], time.time() + RESET_MS / 1000, delta=120)
        self.assertEqual(event["wait"]["account"], B)
        self.assertNotIn("limits", self.state()["providers"]["anthropic"])
        # Readers without the lock see the spooled limit: the tree's next account is b@x and a@x reads as limited.
        who = json.loads(self.cli("who", "--json", code=0).stdout)["providers"]["anthropic"]
        self.assertEqual((who["account"], who["current"]["next"]), (B, "b@x"))
        rows = {r["id"]: r for r in json.loads(self.cli("ls", "--json", code=0).stdout)["rows"]}
        self.assertTrue(rows[A]["reason"].startswith("limited"), rows[A])
        self.assertEqual([e["account"] for e in self.events("limited_spooled")], ["a@x"])
        self.assertEqual(self.events("limited"), [])

    def test_the_next_locked_run_drains_the_429_once_and_logs_it(self):
        _, release = self.spool_a_429()
        [event] = self.spooled()
        release()
        self.cli("model", "fable", "--provider", "anthropic", "--source", SESSION, code=0)
        limits = self.state()["providers"]["anthropic"]["limits"]
        self.assertEqual(limits[A]["until"], event["until"])
        self.assertEqual(self.spooled(), [])
        self.cli("model", "--clear", "--source", SESSION, code=0)
        self.cli("probe", code=0)
        drained = self.events("limited")
        self.assertEqual([(e["account"], e["spool"]) for e in drained], [("a@x", event["id"])])
        self.assertEqual(self.state()["providers"]["anthropic"]["limits"][A], limits[A])

    def test_a_limited_run_killed_after_its_spool_write_loses_nothing(self):
        release = self.hold_lock()
        killed = self.python(
            "write = pool.limited.write\n"
            "def write_then_die(event):\n    write(event)\n    os._exit(9)\n"
            "pool.limited.write = write_then_die\n"
            "import time\n"
            "sys.argv = ['vend.py', '--cli', 'limited', '--provider', 'anthropic', '--until', str(time.time() + 3600), '--since', str(time.time() - 1)]\n"
            "sys.exit(vend.cli(sys.argv[2:]))\n")
        self.assertEqual(killed.returncode, 9, killed.stdout + killed.stderr)
        [event] = self.spooled()
        release()
        self.cli("probe", code=0)
        self.assertEqual(self.state()["providers"]["anthropic"]["limits"][A]["until"], event["until"])
        self.assertEqual([e["spool"] for e in self.events("limited")], [event["id"]])

    def test_a_drain_killed_after_its_state_write_never_applies_the_429_twice(self):
        _, release = self.spool_a_429()
        [event] = self.spooled()
        release()
        died = self.python("pool.limited.os.remove = lambda path: os._exit(9)\nwith pool.limited.pool_lock():\n    pass\n")
        self.assertEqual(died.returncode, 9, died.stdout + died.stderr)
        self.assertEqual([e["id"] for e in self.spooled()], [event["id"]])
        first, first_wait = self.state()["providers"]["anthropic"], self.state()["sessions"][SESSION].get("wait")
        self.assertIn(A, first["limits"])
        # A reader without the lock sees the limit once, from state.json, while the file still stands.
        self.assertEqual(json.loads(self.cli("who", "--json", code=0).stdout)["providers"]["anthropic"]["account"], B)
        self.cli("probe", code=0)
        self.cli("probe", code=0)
        self.assertEqual(self.spooled(), [])
        self.assertEqual(self.state()["providers"]["anthropic"]["limits"], first["limits"])
        self.assertEqual(self.state()["sessions"][SESSION].get("wait"), first_wait)
        self.assertEqual([e["spool"] for e in self.events("limited")], [event["id"]])

    def test_manual_keeps_the_vendor_reset_and_still_records_the_429(self):
        state = self.state()
        state["sessions"][SESSION]["pins"] = {"anthropic": {"account_id": A, "at": time.time() - 60, "by": "test"}}
        with open(os.path.join(self.pool, "state.json"), "w") as f:
            json.dump(state, f)
        message, release = self.spool_a_429()
        self.assertEqual(message["diagnostics"][0]["details"]["retryAfterMs"], RESET_MS)
        self.assertIn("Please try again later.", message["errorMessage"])
        self.assertRegex(message["errorMessage"], r"pi-pool: Manual .* remains selected")
        self.assertNotIn("the retry uses", message["errorMessage"])
        [event] = self.spooled()
        self.assertEqual(event["account_id"], A)
        release()
        self.cli("probe", code=0)
        self.assertIn(A, self.state()["providers"]["anthropic"]["limits"])
        [line] = self.events("limited")
        self.assertEqual((line["next"], line["retry_at"]), (None, None))

    def test_the_hook_under_a_busy_lock_does_not_vend_the_spooled_account(self):
        secrets = os.path.join(self.pool, "accounts", "secrets")
        os.makedirs(secrets, mode=0o700)
        for account in (A, B):
            with open(os.path.join(secrets, f"pi-pool.anthropic.{account}"), "w") as f:
                json.dump({"claudeAiOauth": {"accessToken": f"token-{account[0]}", "refreshToken": "r",
                                             "expiresAt": (time.time() + 86400) * 1000}}, f)
        self.spool_a_429()
        hook = subprocess.run([sys.executable, "-B", str(TESTS.parent / "bin" / "pi-pool-token")], env=self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertNotIn("token-a", hook.stdout)
        self.assertNotEqual(hook.returncode, 0, hook.stdout)

    def test_a_spool_that_cannot_be_written_keeps_the_e6f11e98_fallback(self):
        with open(os.path.join(self.pool, "limited-spool"), "w") as f:
            f.write("not a folder")
        message, _ = self.spool_a_429()
        self.assertIn("pi-pool: the pool did not record this 429", message["errorMessage"])
        self.assertNotIn("retryAfterMs", message["diagnostics"][0]["details"])
        [failed] = self.events("limited_spool_failed")
        self.assertEqual(failed["account"], "a@x")


if __name__ == "__main__":
    unittest.main()
