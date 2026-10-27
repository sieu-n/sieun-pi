"""Parked runs in the turn queue (pool/turns.py `park` and `wake-parked`): a run still queued after the extension's
PARK_AFTER_MS keeps its place with no process, so Prime can park its turn and let its worker go, and the pool wakes it
with `prime-agent wake` when its slot starts. At 05:10Z on 10-27, 34 workers on us-metal02 whose sessions were only
queued held 15.06 GB, and their 55 kernels 3.25 GB.
"""
import fcntl, json, os, stat, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE

from vend.pool import base, remote, turns


def setUpModule():
    isolate_test_module()


ME = os.getpid()
CFG = dict(base.DEFAULTS, working_max=1)


def ask_args(session, tree="t", renew=False, pid=ME):
    return {"session": session, "tree": tree, "pid": pid, "wait": False, "renew": renew}


def line(t, now=100):
    """blocker works on the one slot; job asked at 10, then late at 20."""
    turns.ask(t, ask_args("blocker", tree="B"), 0, CFG)
    turns.ask(t, ask_args("job", tree="J"), 10, CFG)
    turns.ask(t, ask_args("late", tree="L"), 20, CFG)
    return turns.park(t, "job", now, CFG)


class Park(unittest.TestCase):
    def test_a_parked_run_keeps_its_place_with_no_process_and_the_sweep_keeps_it(self):
        t = turns.empty()
        changed, answer, events = line(t)
        self.assertTrue(changed)
        self.assertEqual((answer["state"], answer["position"], answer["retry_at"]), ("parked", 1, 100 + turns.PARK_BACKSTOP_SEC))
        self.assertEqual(t["queued"]["job"]["pid"], None)
        self.assertEqual([e for e, _ in events], ["turn_parked"])
        self.assertEqual(turns.sweep(t, 100 + turns.PARK_BACKSTOP_SEC), [], "the entry has no process and stays")
        self.assertEqual(turns.order(t), ["job", "late"])
        self.assertEqual(turns.reply(t, "job"), {"state": "queued", "kind": None, "position": 1, "total": 2})

    def test_a_run_whose_slot_came_first_is_admitted_instead_of_parked(self):
        t = turns.empty()
        turns.ask(t, ask_args("job", tree="J"), 10, CFG)
        changed, answer, events = turns.park(t, "job", 100, CFG)
        self.assertEqual(answer["state"], "admitted")
        self.assertNotIn("parked", t["working"]["job"])

    def test_a_parked_run_whose_session_never_asks_again_leaves_after_its_backstop(self):
        """A Stop of a parked session cancels Prime's park and tells nobody; the entry must not hold a place forever."""
        t = turns.empty()
        line(t)
        gone = turns.sweep(t, 100 + 2 * turns.PARK_BACKSTOP_SEC + 1)
        self.assertIn({"session": "job", "part": "queued", "why": "park ended"}, gone)
        self.assertNotIn("job", t["queued"])

    def test_a_release_drops_a_parked_run(self):
        t = turns.empty()
        line(t)
        changed, answer, events = turns.leave(t, "job", 200, CFG, reason="release")
        self.assertEqual((answer, list(t["queued"])), ({"released": True}, ["late"]))


class Wake(unittest.TestCase):
    def test_a_parked_run_gets_its_slot_on_a_wake_lease_and_its_ask_takes_it(self):
        t = turns.empty()
        line(t)
        changed, answer, events = turns.leave(t, "blocker", 300, CFG)
        admitted = [f for e, f in events if e == "turn_admitted"]
        self.assertEqual([(f["session"], f.get("wake")) for f in admitted], [("job", True)], "late waits behind the parked run's place")
        slot = t["working"]["job"]
        self.assertEqual((slot["pid"], slot["lease_until"], slot["place"]), (None, 300 + turns.WAKE_LEASE_SEC, 10))
        self.assertEqual(turns.sweep(t, 300 + turns.WAKE_LEASE_SEC - 1), [])
        changed, answer, events = turns.ask(t, ask_args("job", tree="J"), 310, CFG)
        self.assertEqual(answer["state"], "admitted")
        self.assertEqual((t["working"]["job"]["pid"], t["working"]["job"]["lease_until"]), (ME, 310 + CFG["lease_s"]))
        self.assertNotIn("parked", t["working"]["job"])

    def test_a_wake_slot_nobody_takes_goes_back_to_its_place_and_waits_for_the_session(self):
        t = turns.empty()
        line(t)
        turns.leave(t, "blocker", 300, CFG)
        gone = turns.sweep(t, 300 + turns.WAKE_LEASE_SEC + 1)
        self.assertEqual([(g["session"], g.get("requeued")) for g in gone], [("job", True)])
        self.assertEqual(t["queued"]["job"]["since"], 10)
        self.assertEqual(turns.admit_pass(t, 400, 1, 8, 1800), [("late", "slot")], "the pass skips a run whose wake failed")
        changed, answer, events = turns.ask(t, ask_args("job", tree="J"), 100 + turns.PARK_BACKSTOP_SEC, CFG)
        self.assertEqual((answer["state"], answer["position"]), ("queued", 1), "at retry_at the session asks with its old place")
        self.assertNotIn("parked", t["queued"]["job"])

    def test_an_owner_prompt_to_a_parked_session_starts_it_ahead_and_wakes_it(self):
        t = turns.empty()
        line(t)
        answer, events = turns.mark_owner(t, "job", 150, CFG["lease_s"])
        self.assertTrue(answer["ahead"])
        self.assertEqual([(f["session"], f["kind"], f.get("wake")) for e, f in events if e == "turn_admitted"], [("job", "ahead", True)])


class FakePrime:
    """A `prime-agent` on PATH that records its argv, whether turns.lock was free and any Prime worker key it got."""
    SCRIPT = """#!/usr/bin/python3
import fcntl, json, os, sys
fd = os.open(os.path.join(os.environ["PI_POOL_DIR"], "turns.lock"), os.O_CREAT | os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    free = True
except OSError:
    free = False
with open(os.environ["FAKE_PRIME_RECORD"], "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "lock_free": free, "internal": sorted(k for k in os.environ if k.startswith("PRIME_AGENT_INTERNAL_"))}) + "\\n")
print(os.environ["FAKE_WAKE_OUT"])
sys.exit(int(os.environ["FAKE_WAKE_CODE"]))
"""

    def __init__(self, folder):
        self.bin = os.path.join(folder, "fake-bin")
        os.makedirs(self.bin)
        path = os.path.join(self.bin, "prime-agent")
        with open(path, "w") as f:
            f.write(self.SCRIPT)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        self.record = os.path.join(folder, "prime-calls.jsonl")

    def calls(self, n, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if os.path.exists(self.record):
                with open(self.record) as f:
                    got = [json.loads(x) for x in f]
                if len(got) >= n:
                    return got
            time.sleep(0.1)
        raise AssertionError(f"prime-agent ran fewer than {n} times")


@unittest.skipUnless(sys.platform.startswith("linux"), "pi-pool parks only on Linux")
class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-park-")
        self.prime = FakePrime(self.dir)
        self.env = dict(os.environ, PI_POOL_DIR=self.dir, PATH=self.prime.bin + os.pathsep + os.environ["PATH"],
                        FAKE_PRIME_RECORD=self.prime.record, FAKE_WAKE_OUT='{"woke": "park"}', FAKE_WAKE_CODE="0",
                        PRIME_AGENT_INTERNAL_DAEMON_WORKER="1")
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        self.run_cli("set", "working_max", "1")
        self.admit("blocker", "B")

    def run_cli(self, *args, env=None):
        done = subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), *args],
                              env=env or self.env, capture_output=True, text=True, timeout=30)
        if done.returncode:
            raise AssertionError(done.stderr or done.stdout)
        return json.loads(done.stdout.splitlines()[-1]) if args[0] != "set" else None

    def admit(self, session, tree):
        return self.run_cli("admit", session, "--tree", tree, "--pid", str(ME))

    def log(self, event):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with open(os.path.join(self.dir, "pi-pool.log")) as f:
                got = [json.loads(x) for x in f if f'"{event}"' in x]
            if got:
                return got
            time.sleep(0.1)
        raise AssertionError(f"no {event} line")

    def test_queue_json_lists_a_parked_run_as_queued(self):
        self.admit("job", "J")
        answer = self.run_cli("park", "job")
        self.assertEqual((answer["state"], answer["position"]), ("parked", 1))
        view = self.run_cli("queue", "--json")
        self.assertEqual([(q["session"], q["position"], q.get("parked")) for q in view["queued"]], [("job", 1, True)])

    def test_queue_json_gives_a_lapsed_slot_to_the_next_run_as_the_next_locked_call_would(self):
        self.admit("job", "J")
        self.run_cli("park", "job")
        gone = subprocess.Popen(["/bin/true"])
        gone.wait()
        path = os.path.join(self.dir, "turns.json")
        with open(path) as f:
            saved = json.load(f)
        saved["working"]["blocker"]["pid"] = gone.pid
        with open(path, "w") as f:
            json.dump(saved, f)
        view = self.run_cli("queue", "--json")
        self.assertEqual(([w["session"] for w in view["working"]], view["queued"]), (["job"], []))

    def test_the_release_that_frees_the_slot_wakes_the_parked_run_outside_the_lock(self):
        self.admit("job", "J")
        self.run_cli("park", "job")
        self.run_cli("release", "blocker")
        [call] = self.prime.calls(1)
        self.assertEqual(call, {"argv": ["wake", "job"], "lock_free": True, "internal": []})
        self.assertEqual(self.log("turn_wake")[0]["woke"], "park")
        self.assertEqual([w["session"] for w in self.run_cli("queue", "--json")["working"]], ["job"])

    def test_a_failed_wake_puts_the_run_back_at_its_place_and_frees_the_slot(self):
        self.env.update(FAKE_WAKE_OUT='{"woke": "none"}', FAKE_WAKE_CODE="3")
        self.admit("job", "J")
        self.run_cli("park", "job")
        self.admit("late", "L")
        self.run_cli("release", "blocker")
        self.prime.calls(1)
        self.assertEqual(self.log("turn_wake")[0]["woke"], "none")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not self.run_cli("queue", "--json")["working"]:
            time.sleep(0.1)
        view = self.run_cli("queue", "--json")
        self.assertEqual([w["session"] for w in view["working"]], ["late"], "the slot went to the next run")
        self.assertEqual([(q["session"], q["position"]) for q in view["queued"]], [("job", 1)])
        self.run_cli("release", "late")
        self.assertEqual(self.admit("job", "J")["state"], "admitted", "at retry_at the session asks and takes the next slot")

    def test_a_box_without_prime_agent_never_parks(self):
        self.admit("job", "J")
        env = dict(self.env, PATH="/usr/bin:/bin")
        answer = self.run_cli("park", "job", env=env)
        self.assertEqual((answer["state"], answer.get("park")), ("queued", "unsupported"))
        self.assertNotIn("parked", self.run_cli("queue", "--json")["queued"][0])

    def test_park_and_wake_stay_on_this_machine_with_a_remote_pool(self):
        self.assertFalse(remote.forwards(["--cli", "park", "job"]))
        self.assertFalse(remote.forwards(["--cli", "wake-parked", "job"]))


if __name__ == "__main__":
    unittest.main()
