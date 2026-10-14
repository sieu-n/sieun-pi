"""The extension's turn-queue wiring: a run takes its slot in the `context` handler,
renews it from later model calls, marks no owner turn, Stop drops a queued run, and
agent_end gives the slot back. The handlers run in queue_driver.mjs against the
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
        self.cli("set", "memory_governor_on", "0")
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

    def test_an_interactive_prompt_to_a_root_session_marks_no_owner_turn(self):
        """Every prompt the daemon delivers reads as interactive, [job] notices and duty
        briefs included, so only the chat service's owner-turn marks the owner's."""
        run = self.drive({"op": "start", "name": "chat"}, {"op": "input", "name": "chat", "source": "interactive"},
                         {"op": "context", "name": "chat"}, {"op": "wait", "name": "chat", "ms": 2500, "label": "notice"},
                         {"op": "queue", "label": "q"})
        self.assertIsNone(run["context"]["notice"], "the notice's run waits while the Mac is full")
        self.assertEqual([q["session"] for q in run["queues"]["q"]["queued"]], ["chat"])

    def test_the_chat_services_mark_runs_the_owners_prompt_at_once(self):
        self.cli("owner-turn", "chat")
        run = self.drive({"op": "start", "name": "chat"}, {"op": "context", "name": "chat"},
                         {"op": "wait", "name": "chat", "ms": 5000, "label": "first"}, {"op": "queue", "label": "q"})
        self.assertIsNotNone(run["context"]["first"])
        self.assertEqual({w["session"]: w["kind"] for w in run["queues"]["q"]["working"]}, {"blocker": "slot", "chat": "owner"})

    def test_a_model_call_renews_a_slot_that_lapsed_during_a_long_tool_call(self):
        """The lease lapses with no model call (a release stands in for the sweep). A
        model call sooner than QUEUE_RENEW_MS after the last renewal sends none, and the
        next one after it takes the slot back at once."""
        self.cli("release", "blocker")
        run = self.drive({"op": "start", "name": "job"}, {"op": "context", "name": "job"},
                         {"op": "wait", "name": "job", "ms": 5000, "label": "first"},
                         {"op": "cli", "args": ["release", "job"]},
                         {"op": "context", "name": "job"}, {"op": "wait", "name": "job", "ms": 5000, "label": "soon"},
                         {"op": "queue", "label": "lapsed"},
                         {"op": "clock", "ms": 5 * 60_000 + 1000},
                         {"op": "context", "name": "job"}, {"op": "wait", "name": "job", "ms": 5000, "label": "later"},
                         {"op": "queue", "label": "renewed"})
        self.assertIsNotNone(run["context"]["soon"])
        self.assertEqual(run["queues"]["lapsed"]["working"], [])
        self.assertIsNotNone(run["context"]["later"])
        self.assertEqual({w["session"]: w["kind"] for w in run["queues"]["renewed"]["working"]}, {"job": "slot"})

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

    def test_a_child_borrows_its_running_parents_slot(self):
        self.cli("release", "blocker")
        run = self.drive({"op": "start", "name": "chat"}, {"op": "context", "name": "chat"},
                         {"op": "wait", "name": "chat", "ms": 5000, "label": "chat"},
                         {"op": "start", "name": "kid", "depth": 1, "parent": "chat"}, {"op": "input", "name": "kid", "source": "interactive"},
                         {"op": "context", "name": "kid"}, {"op": "wait", "name": "kid", "ms": 5000, "label": "kid"},
                         {"op": "queue", "label": "q"})
        self.assertIsNotNone(run["context"]["kid"])
        self.assertEqual({w["session"]: w["kind"] for w in run["queues"]["q"]["working"]}, {"chat": "slot", "kid": "borrow"})

    def test_a_pool_that_fails_lets_the_run_go(self):
        # The pool refuses a folder inside the code root of the CLI the extension calls,
        # which for a staged release is current's (poolBin), not the staged folder.
        root = TESTS.parent
        if root.parent.name == "releases":
            root = root.parent.parent / "current"
        self.env["PI_POOL_DIR"] = str(Path(os.path.realpath(root)) / "inside-the-source")
        run = self.drive({"op": "start", "name": "job"}, {"op": "context", "name": "job"},
                         {"op": "wait", "name": "job", "ms": 5000, "label": "open"})
        self.assertIsNotNone(run["context"]["open"])


if __name__ == "__main__":
    unittest.main()
