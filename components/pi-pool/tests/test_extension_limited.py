"""A 429 the pool cannot record still loses the vendor reset. On 10-19 35 of 1,927 anthropic 429s on us-metal02
kept the vendor text: each `pi-pool limited` call met a pool flock busy past STATE_LOCK_TIMEOUT, exited 1 with no
log line, and the session slept until the reset, up to 4.2 h. The handler runs against the real CLI in a pool
folder of its own, with this process holding the pool lock."""
import fcntl, json, os, shutil, subprocess, tempfile, time, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent
EXTENSION = TESTS.parent / "app" / "extension" / "index.ts"
A, B = "aaaa1111-0000-0000-0000-000000000000", "bbbb2222-0000-0000-0000-000000000000"
SESSION = "01a1-ext-429-tree"
RESET_MS = 3 * 3600 * 1000


class LimitedLockBusy(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
