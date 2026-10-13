"""The extension's turn-queue wiring: a run takes its slot in the `context` handler,
an interactive prompt to a depth-0 session is the owner's, Stop drops a queued run,
and agent_end gives the slot back. The handlers run in queue_driver.mjs against the
real pool CLI in a pool folder of their own."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent
EXTENSION = TESTS.parent / "app" / "extension" / "index.ts"
CLI = TESTS.parent / "bin" / "pi-pool"


class Wiring(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-ext-queue-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for key in ("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"):
            self.env.pop(key, None)
        self.cli("set", "mac_working_max", "1")
        self.cli("admit", "blocker", "--tree", "B", "--pid", str(os.getpid()))

    def cli(self, *args):
        done = subprocess.run(["/usr/bin/python3", "-B", str(CLI), *args], env=self.env, capture_output=True, text=True, timeout=30)
        if done.returncode:
            raise AssertionError(done.stdout + done.stderr)
        return done.stdout

    def queue(self):
        return json.loads(self.cli("queue", "--json"))

    def drive(self, *steps):
        done = subprocess.run(["node", str(TESTS / "queue_driver.mjs"), str(EXTENSION), json.dumps(steps)],
                              env=self.env, capture_output=True, text=True, timeout=60)
        if done.returncode:
            raise AssertionError(done.stdout + done.stderr)
        return json.loads(done.stdout.strip().splitlines()[-1])

    def test_a_typed_prompt_to_a_root_session_is_the_owners_and_never_waits(self):
        run = self.drive({"op": "start", "name": "tui"}, {"op": "input", "name": "tui", "source": "interactive"},
                         {"op": "context", "name": "tui"}, {"op": "wait", "name": "tui", "ms": 5000, "label": "first"},
                         {"op": "queue", "label": "q"})
        self.assertIsNotNone(run["context"]["first"], "the owner's run went at once")
        self.assertEqual({w["session"]: w["kind"] for w in run["queues"]["q"]["working"]}, {"blocker": "slot", "tui": "owner"})

    def test_a_queued_run_waits_until_a_release_and_gives_its_slot_back_at_agent_end(self):
        script = [{"op": "start", "name": "job"}, {"op": "input", "name": "job", "source": "rpc"},
                  {"op": "context", "name": "job"}, {"op": "wait", "name": "job", "ms": 2500, "label": "full"}]
        release = subprocess.Popen(["/bin/sh", "-c", f'sleep 4 && /usr/bin/python3 -B "{CLI}" release blocker'], env=self.env,
                                   stdout=subprocess.DEVNULL)
        run = self.drive(*script, {"op": "wait", "name": "job", "ms": 10000, "label": "freed"},
                         {"op": "queue", "label": "running"}, {"op": "end", "name": "job"}, {"op": "queue", "label": "ended"})
        release.wait()
        self.assertIsNone(run["context"]["full"], "a run waits while the Mac is full")
        self.assertIsNotNone(run["context"]["freed"])
        self.assertEqual(run["entries"], [{"session": "job", "type": "pi-pool-queue", "text": "Queued for a working slot, 1st of 1"}])
        self.assertEqual([w["session"] for w in run["queues"]["running"]["working"]], ["job"])
        self.assertEqual(run["queues"]["ended"]["working"], [], "agent_end released the slot")

    def test_stop_drops_a_queued_run(self):
        run = self.drive({"op": "start", "name": "job"}, {"op": "context", "name": "job"},
                         {"op": "wait", "name": "job", "ms": 2000, "label": "queued"}, {"op": "queue", "label": "before"},
                         {"op": "abort", "name": "job"}, {"op": "wait", "name": "job", "ms": 5000, "label": "stopped"},
                         {"op": "queue", "label": "after"})
        self.assertIsNone(run["context"]["queued"])
        self.assertEqual([e["session"] for e in run["queues"]["before"]["queued"]], ["job"])
        self.assertIsNotNone(run["context"]["stopped"])
        self.assertEqual(run["queues"]["after"]["queued"], [])

    def test_a_child_borrows_its_running_parents_slot_and_a_typed_prompt_there_is_no_owner_mark(self):
        self.cli("release", "blocker")
        run = self.drive({"op": "start", "name": "chat"}, {"op": "context", "name": "chat"},
                         {"op": "wait", "name": "chat", "ms": 5000, "label": "chat"},
                         {"op": "start", "name": "kid", "depth": 1, "parent": "chat"}, {"op": "input", "name": "kid", "source": "interactive"},
                         {"op": "context", "name": "kid"}, {"op": "wait", "name": "kid", "ms": 5000, "label": "kid"},
                         {"op": "queue", "label": "q"})
        self.assertIsNotNone(run["context"]["kid"])
        self.assertEqual({w["session"]: w["kind"] for w in run["queues"]["q"]["working"]}, {"chat": "slot", "kid": "borrow"})

    def test_a_pool_that_fails_lets_the_run_go(self):
        self.env["PI_POOL_DIR"] = str(TESTS.parent / "inside-the-source")
        run = self.drive({"op": "start", "name": "job"}, {"op": "context", "name": "job"},
                         {"op": "wait", "name": "job", "ms": 5000, "label": "open"})
        self.assertIsNotNone(run["context"]["open"])


if __name__ == "__main__":
    unittest.main()
