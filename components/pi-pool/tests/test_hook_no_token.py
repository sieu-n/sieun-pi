"""The token hook writes why it gave no token to the pool log. From 10-16 08:44Z to
10-17 19:45Z every Prime hook run gave no token and pi-pool.log had no line for any
of them, because Prime drops the hook's stderr."""
import json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(SOURCE, "bin", "pi-pool-token")


def events(pool):
    try:
        with open(os.path.join(pool, "pi-pool.log")) as f:
            return [json.loads(line) for line in f]
    except FileNotFoundError:
        return []


class HookNoToken(unittest.TestCase):
    def run_hook(self, accounts):
        home = tempfile.mkdtemp(prefix="pi-pool-empty-home-")
        self.addCleanup(shutil.rmtree, home, True)
        pool = os.path.join(home, ".config", "pi-pool")
        tm = os.path.join(home, ".config", "tokenmaxxing")
        os.makedirs(pool)
        os.makedirs(os.path.join(tm, "stores"))
        if accounts is not None:
            with open(os.path.join(tm, "accounts.json"), "w") as f:
                json.dump(accounts, f)
        env = dict(os.environ, HOME=home, PI_POOL_DIR=pool, TOKENMAXXING_HOME=tm, PI_POOL_SECRETS="file",
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-empty")
        run = subprocess.run([sys.executable, "-B", HOOK], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        no_token = [e for e in events(pool) if e["event"] == "hook_no_token"]
        self.assertEqual(len(no_token), 1, events(pool))
        self.assertEqual((no_token[0]["provider"], no_token[0]["session"]), ("anthropic", "fixture-empty"))
        return no_token[0]["reason"]

    def test_an_empty_store_in_a_temp_home_logs_why_no_token_came(self):
        self.assertEqual(self.run_hook({"version": 2, "accounts": []}), "RuntimeError: no anthropic account can serve this session")

    def test_a_missing_store_index_logs_why_no_token_came(self):
        self.assertEqual(self.run_hook(None), "RuntimeError: tokenmaxxing accounts.json unreadable")

    def test_a_kill_while_vend_loads_is_logged(self):
        root = tempfile.mkdtemp(prefix="pi-pool-slow-load-")
        self.addCleanup(shutil.rmtree, root, True)
        os.makedirs(os.path.join(root, "bin"))
        shutil.copy(HOOK, os.path.join(root, "bin", "pi-pool-token"))
        with open(os.path.join(root, "vend.py"), "w") as f:
            f.write("import sys, time\nprint('loading', file=sys.stderr, flush=True)\ntime.sleep(30)\n")
        pool = os.path.join(root, "state")
        os.makedirs(pool)
        env = dict(os.environ, PI_POOL_DIR=pool, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-slow")
        hook = subprocess.Popen([sys.executable, "-B", os.path.join(root, "bin", "pi-pool-token"), "--provider", "openai-codex"], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(hook.stderr.readline(), "loading\n")
            hook.send_signal(signal.SIGTERM)
            out, _ = hook.communicate(timeout=10)
        finally:
            if hook.poll() is None:
                hook.kill()
                hook.communicate()
        self.assertEqual((hook.returncode, out), (128 + signal.SIGTERM, ""))
        [e] = events(pool)
        self.assertEqual((e["event"], e["provider"], e["session"]), ("hook_no_token", "openai-codex", "fixture-slow"))
        self.assertEqual(e["reason"], f"killed by signal {signal.SIGTERM} while vend.py loaded")


if __name__ == "__main__":
    unittest.main()
