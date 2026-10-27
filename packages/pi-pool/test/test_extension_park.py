"""The extension's side of a parked run (pool/turns.py `park`): a run still queued after PARK_AFTER_MS parks its queue
entry and hands Prime a credential wait, so Prime can park the turn and let the worker go; its next model call takes the
slot the pool started for it. At 05:10Z on 10-27, 34 workers on us-metal02 whose sessions were only queued held 15.06 GB.
The handlers run in queue_driver.mjs against the real pool CLI, with a fake `prime-agent` on PATH."""
import json, os, stat, subprocess, sys, tempfile, time, unittest
from pathlib import Path

from fixture_isolation import isolate_test_module
from prime_extension import EXTENSION
from test_turns_park import FakePrime


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent
CLI = TESTS.parent / "bin" / "pi-pool"
PARK_AFTER_MS = 60_000


@unittest.skipUnless(sys.platform.startswith("linux"), "pi-pool parks only on Linux")
class ParkWiring(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-ext-park-")
        self.prime = FakePrime(self.dir)
        self.env = dict(os.environ, PI_POOL_DIR=self.dir, PATH=self.prime.bin + os.pathsep + os.environ["PATH"],
                        FAKE_PRIME_RECORD=self.prime.record, FAKE_WAKE_OUT='{"woke": "park"}', FAKE_WAKE_CODE="0")
        for key in ("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"):
            self.env.pop(key, None)
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump({"memory_governor_on": 0}, f)
        self.cli("set", "working_max", "1")
        self.cli("admit", "blocker", "--tree", "B", "--pid", str(os.getpid()))

    def cli(self, *args):
        done = subprocess.run(["/usr/bin/python3", "-B", str(CLI), *args], env=self.env, capture_output=True, text=True, timeout=30)
        if done.returncode:
            raise AssertionError(done.stdout + done.stderr)
        return done.stdout

    def drive(self, *steps):
        done = subprocess.run(["node", str(TESTS / "queue_driver.mjs"), str(EXTENSION), json.dumps(steps)],
                              env=self.env, capture_output=True, text=True, timeout=60)
        if done.returncode:
            raise AssertionError(done.stdout + done.stderr)
        return json.loads(done.stdout.strip().splitlines()[-1])

    def parked(self, credential=True):
        return [{"op": "start", "name": "job", "credentialApi": credential}, {"op": "context", "name": "job"},
                {"op": "wait", "name": "job", "ms": 2000, "label": "queued"}, {"op": "clock", "ms": PARK_AFTER_MS + 1000},
                {"op": "wait", "name": "job", "ms": 4000, "label": "parked"}, {"op": "queue", "label": "parked"}]

    def test_a_run_still_queued_after_park_after_hands_prime_a_credential_wait_and_keeps_its_place(self):
        run = self.drive(*self.parked(), {"op": "end", "name": "job"}, {"op": "queue", "label": "ended"})
        self.assertIsNone(run["context"]["queued"])
        self.assertIsNotNone(run["context"]["parked"], "the model call goes, into Prime's credential wait")
        [wait] = run["credential"]
        self.assertEqual(wait["session"], "job")
        self.assertGreater(wait["retryAtMs"] - time.time() * 1000, 15 * 60_000, "past idleEvictionMinutes, so Prime parks")
        self.assertIn("place 1 of 1", wait["message"])
        self.assertEqual([(q["session"], q.get("parked")) for q in run["queues"]["parked"]["queued"]], [("job", True)])
        self.assertEqual([(q["session"], q.get("parked")) for q in run["queues"]["ended"]["queued"]], [("job", True)],
                         "the parked turn's agent_end leaves its place in line")

    def test_a_prime_without_the_credential_wait_keeps_the_run_waiting_in_its_worker(self):
        run = self.drive(*self.parked(credential=False))
        self.assertIsNone(run["context"]["parked"])
        self.assertEqual(run["credential"], [])
        self.assertEqual([(q["session"], q.get("parked")) for q in run["queues"]["parked"]["queued"]], [("job", None)])

    def test_the_next_model_call_of_a_woken_run_takes_the_slot_the_pool_started(self):
        run = self.drive(*self.parked(), {"op": "end", "name": "job"}, {"op": "cli", "args": ["release", "blocker"]},
                         {"op": "sleep", "ms": 3000}, {"op": "queue", "label": "woken"},
                         {"op": "context", "name": "job"}, {"op": "wait", "name": "job", "ms": 4000, "label": "resumed"},
                         {"op": "queue", "label": "running"})
        self.assertEqual(self.prime.calls(1)[0]["argv"], ["wake", "job"])
        self.assertEqual([w["session"] for w in run["queues"]["woken"]["working"]], ["job"])
        self.assertIsNotNone(run["context"]["resumed"], "the resumed turn's model call finds its slot")
        self.assertEqual([w["session"] for w in run["queues"]["running"]["working"]], ["job"])
        with open(os.path.join(self.dir, "turns.json")) as f:
            slot = json.load(f)["working"]["job"]
        self.assertNotIn("parked", slot)
        self.assertIsNotNone(slot["pid"])

    def test_a_run_prime_kept_in_its_worker_asks_again_when_the_wake_ends_its_timer(self):
        """Prime keeps a credential wait in the worker, on a timer, while the session awaits a child (_credentialWaitCanPark)."""
        self.env.update(FAKE_WAKE_OUT='{"woke": "timer"}')
        run = self.drive(*self.parked(), {"op": "cli", "args": ["release", "blocker"]}, {"op": "sleep", "ms": 3000},
                         {"op": "context", "name": "job"}, {"op": "wait", "name": "job", "ms": 4000, "label": "resumed"},
                         {"op": "queue", "label": "running"})
        self.assertIsNotNone(run["context"]["resumed"])
        self.assertEqual([w["session"] for w in run["queues"]["running"]["working"]], ["job"])


if __name__ == "__main__":
    unittest.main()
