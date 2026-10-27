"""Prime kills a hook that runs past its 10 s timeout with SIGTERM and drops its
stderr, so the kill has to land in the pool log."""
import json, os, signal, subprocess, sys, tempfile, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHILD = """
import runpy, sys, time
vend = runpy.run_path(sys.argv[1], run_name="vend")
def waiting_for_the_lock():
    print("ready", flush=True)
    time.sleep(30)
vend["log_when_killed"]("openai-codex")
waiting_for_the_lock()
"""


class HookKilled(unittest.TestCase):
    def test_a_killed_hook_logs_where_it_was_and_for_how_long(self):
        pool = tempfile.mkdtemp(prefix="pi-pool-killed-")
        env = dict(os.environ, PI_POOL_DIR=pool, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-killed")
        hook = subprocess.Popen([sys.executable, "-B", "-c", CHILD, os.path.join(SOURCE, "vend.py")], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(hook.stdout.readline(), "ready\n", hook.stderr.read() if hook.poll() is not None else "")
            hook.send_signal(signal.SIGTERM)
            hook.communicate(timeout=10)
        finally:
            if hook.poll() is None:
                hook.kill()
                hook.communicate()
        self.assertEqual(hook.returncode, 128 + signal.SIGTERM)
        with open(os.path.join(pool, "pi-pool.log")) as f:
            events = [json.loads(line) for line in f]
        self.assertEqual([e["event"] for e in events], ["hook_killed"])
        e = events[0]
        self.assertEqual((e["provider"], e["signal"], e["session"]), ("openai-codex", signal.SIGTERM, "fixture-killed"))
        self.assertTrue(0 <= e["awake_sec"] <= e["wall_sec"] + 0.1 and e["wall_sec"] < 10, e)
        self.assertIn("waiting_for_the_lock", " ".join(e["at"]))


if __name__ == "__main__":
    unittest.main()
