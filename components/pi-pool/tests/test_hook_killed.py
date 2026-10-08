"""Prime kills a hook that runs past its 10 s timeout with SIGTERM and drops its
stderr, so the kill has to land in the pool log."""
import fcntl, json, os, signal, subprocess, tempfile, time, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(SOURCE, "bin", "pi-pool-token")


class HookKilled(unittest.TestCase):
    def wait_until_open(self, pid, path, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            listed = subprocess.run(["lsof", "-Fn", "-p", str(pid)], capture_output=True, text=True).stdout
            if "n" + os.path.realpath(path) in listed.splitlines():
                return
            time.sleep(0.05)
        self.fail(f"the hook never opened {path}")

    def test_a_hook_killed_while_it_waits_logs_where_and_for_how_long(self):
        root = tempfile.mkdtemp(prefix="pi-pool-killed-")
        pool, tm = os.path.join(root, "pool"), os.path.join(root, "tm")
        os.makedirs(pool)
        os.makedirs(tm)
        with open(os.path.join(tm, "codex-accounts.json"), "w") as f:
            json.dump({"version": 2, "accounts": []}, f)
        env = dict(os.environ, HOME=root, PI_POOL_DIR=pool, TOKENMAXXING_HOME=tm,
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-killed")
        lock = os.open(os.path.join(pool, "lock"), os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            hook = subprocess.Popen([HOOK, "--provider", "openai-codex"], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.wait_until_open(hook.pid, os.path.join(pool, "lock"))
            hook.send_signal(signal.SIGTERM)
            out, _ = hook.communicate(timeout=10)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            os.close(lock)
        self.assertEqual((hook.returncode, out), (128 + signal.SIGTERM, b""))
        with open(os.path.join(pool, "pi-pool.log")) as f:
            events = [json.loads(line) for line in f]
        killed = [e for e in events if e["event"] == "hook_killed"]
        self.assertEqual(len(killed), 1, events)
        e = killed[0]
        self.assertEqual((e["provider"], e["signal"], e["session"]), ("openai-codex", signal.SIGTERM, "fixture-killed"))
        self.assertTrue(0 <= e["awake_sec"] <= e["wall_sec"] + 0.1 and e["wall_sec"] < 5, e)
        self.assertTrue(e["at"][0].startswith("__enter__:") and any(f.startswith("vend:") for f in e["at"]), e["at"])


if __name__ == "__main__":
    unittest.main()
