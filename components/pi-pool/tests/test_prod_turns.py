"""Prod turns (pool/prod.py): a tree or session the caller marked as on prod work never waits in the
turn queue. Replays the queue of 10-15 09:59Z, when promote 10 try 3 ran and the release owner sat
58th of 60."""
import json, os, subprocess, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE
from vend.pool import base, prod, turns


def setUpModule():
    isolate_test_module()


ME = os.getpid()
HERE = os.path.dirname(os.path.abspath(__file__))
RELEASE = "01a10810-34b5-710f-88fe-3d369f89a8c9"
METAL = "01a11d24-ac9b-757d-ac51-9b2b7598782f"
CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048"
PROMOTE = "promote.yml run 38708750431"


def load_fixture():
    with open(os.path.join(HERE, "live_1015_1859kst.json")) as f:
        return json.load(f)


def record(trees=None, sessions=None, until=10 ** 10, at=0):
    return {"at": at, "until": until, "trees": trees or {}, "sessions": sessions or {}}


class Record(unittest.TestCase):
    def test_set_takes_trees_sessions_and_until_and_nothing_else(self):
        rec = prod.parse(json.dumps({"trees": {RELEASE: PROMOTE}, "until": 90}), 5)
        self.assertEqual(rec, {"at": 5, "until": 90.0, "trees": {RELEASE: PROMOTE}, "sessions": {}})
        for bad in ("[]", "{}", '{"until": "soon"}', '{"until": 9, "trees": {"a": 1}}', '{"until": 9, "files": {}}', "nope"):
            with self.assertRaises(SystemExit):
                prod.parse(bad, 5)

    def test_a_record_holds_until_its_time_and_names_trees_and_sessions(self):
        rec = record({RELEASE: PROMOTE}, {CRAWLER: "alert Production crawler down"}, until=100)
        self.assertEqual(prod.why(rec, "kid", {"tree": RELEASE}, 100), PROMOTE)
        self.assertEqual(prod.why(rec, CRAWLER, {"tree": "x"}, 50), "alert Production crawler down")
        self.assertIsNone(prod.why(rec, "kid", {"tree": RELEASE}, 101), "a caller that stops sending lets it lapse")
        self.assertIsNone(prod.why(None, "kid", {"tree": RELEASE}, 0))

    def test_the_woken_chat_runs_at_once_and_its_jobs_still_queue(self):
        t = turns.empty()
        t["prod"] = record(sessions={CRAWLER: "alert Production crawler health read over 2 s"})
        for i in range(12):
            t["working"][f"w{i}"] = {"tree": f"busy{i}", "parent": None, "class": "normal", "since": 0, "pid": ME, "kind": "slot"}
        t["queued"][CRAWLER] = {"tree": CRAWLER, "parent": None, "class": "high", "since": 9, "pid": ME}
        t["queued"]["job"] = {"tree": CRAWLER, "parent": CRAWLER, "class": "high", "since": 1, "pid": ME}
        self.assertEqual(turns.admit_pass(t, 10, 12, 8, 18), [(CRAWLER, "prod"), ("job", "borrow")],
                         "the job only borrows its in-flight parent's slot, as any child does")
        self.assertEqual(t["working"][CRAWLER]["why"], "alert Production crawler health read over 2 s")
        t["queued"]["job2"] = {"tree": CRAWLER, "parent": CRAWLER, "class": "high", "since": 11, "pid": ME}
        self.assertEqual(turns.admit_pass(t, 12, 12, 8, 18), [])


class Replay0959(unittest.TestCase):
    """The queue at 09:59:00Z on 10-15: 14 working, 60 queued, at a limit of 12."""

    def state(self, snap):
        t = turns.empty()
        for w in snap["working"]:
            t["working"][w["session"]] = {"tree": w["tree"], "parent": w["parent"], "class": "normal", "since": snap["at"] - 30,
                                          "pid": ME, "kind": w["kind"], "lease_until": snap["at"] + 1800,
                                          **({"lender": w["parent"]} if w["kind"] == "borrow" else {})}
        for q in snap["queued"]:
            t["queued"][q["session"]] = {"tree": q["tree"], "parent": q["parent"], "class": q["class"], "since": q["since"], "pid": ME}
        return t

    def setUp(self):
        self.fx = load_fixture()
        self.cfg = dict(base.DEFAULTS)
        self.promote = record({RELEASE: PROMOTE, METAL: PROMOTE}, until=200)

    def test_without_prod_turns_the_release_owner_sits_58th_of_60(self):
        snap = self.fx["snapshots"][0]
        t = self.state(snap)
        self.assertEqual((len(t["working"]), len(t["queued"])), (14, 60))
        self.assertEqual(turns.order(t["queued"], snap["at"], 18).index(RELEASE) + 1, 58)
        self.assertEqual(turns.admit_pass(t, snap["at"], 12, 8, 18), [], "12 slots are taken, so nobody starts")

    def test_with_promote_marked_both_owner_roots_start_at_once_and_nobody_else_does(self):
        snap = self.fx["snapshots"][0]
        t = self.state(snap)
        t["prod"] = self.promote
        self.assertEqual(turns.order(t["queued"], snap["at"], 18).index(METAL) + 1, 16)
        got = turns.admit_pass(t, snap["at"], 12, 8, 18)
        self.assertEqual(got, [(METAL, "prod"), (RELEASE, "prod")])
        self.assertEqual(t["working"][RELEASE]["why"], PROMOTE)
        self.assertEqual(len(t["queued"]), 58)

    def test_metal_queued_again_63rd_of_69_and_starts_at_once_through_admit(self):
        snap = self.fx["snapshots"][1]
        t = self.state(snap)
        t["prod"] = self.promote
        mine = t["queued"].pop(METAL)
        self.assertEqual(turns.order(dict(t["queued"], **{METAL: mine}), snap["at"], 18).index(METAL) + 1, 63)
        cfg = dict(self.cfg, working_max=12)
        ask = {"session": METAL, "tree": METAL, "parent": None, "class": None, "pid": ME, "renew": False}
        _, answer, _ = turns.ask(t, {METAL: {"priority": "high"}}, ask, snap["at"], cfg)
        self.assertEqual(answer, {"state": "admitted", "kind": "prod", "position": None, "total": None})
        self.assertEqual([s for s, e in t["working"].items() if e["kind"] == "prod"], [RELEASE, METAL],
                         "the release owner, queued since 09:58:59Z, started on the same pass")

    def test_a_lapsed_record_is_dropped_and_they_queue_again(self):
        t = self.state(self.fx["snapshots"][0])
        t["prod"] = self.promote
        self.assertEqual(turns.prod_watch(t, 200, self.cfg), (False, []))
        self.assertEqual(turns.prod_watch(t, 201, self.cfg), (True, [("prod_turns", {"trees": {}, "sessions": {}})]))
        self.assertNotIn("prod", t)
        self.assertEqual(turns.admit_pass(t, 201, 12, 8, 18), [])

    def test_the_off_switch_drops_the_record(self):
        t = self.state(self.fx["snapshots"][0])
        t["prod"] = self.promote
        self.assertEqual(turns.prod_watch(t, 1, dict(self.cfg, prod_turns_on=0)), (True, [("prod_turns", {"trees": {}, "sessions": {}})]))
        self.assertNotIn("prod", t)
        self.assertEqual(turns.admit_pass(t, 1, 12, 8, 18), [])


class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-prod-cli-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump({"working_max": 1}, f)

    def run_cli(self, *args):
        done = subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), *args],
                              env=self.env, capture_output=True, text=True, timeout=30)
        if done.returncode:
            raise AssertionError(done.stderr or done.stdout)
        return done.stdout

    def test_prod_set_admits_the_queued_turn_it_names_and_queue_json_names_why(self):
        self.assertEqual(json.loads(self.run_cli("admit", "a", "--tree", "A", "--pid", str(ME)))["kind"], "slot")
        self.assertEqual(json.loads(self.run_cli("admit", "j", "--tree", "J", "--pid", str(ME)))["state"], "queued")
        self.assertEqual(json.loads(self.run_cli("admit", "r", "--tree", "R", "--pid", str(ME)))["state"], "queued")
        until = time.time() + 60
        out = json.loads(self.run_cli("prod", "set", json.dumps({"trees": {"R": PROMOTE}, "until": until})))
        self.assertEqual((out["prod"]["trees"], out["admitted"]), ({"R": PROMOTE}, ["r"]))
        self.assertEqual(json.loads(self.run_cli("admit", "kid", "--tree", "R", "--parent", "R", "--pid", str(ME))),
                         {"state": "admitted", "kind": "prod", "position": None, "total": None})
        view = json.loads(self.run_cli("queue", "--json"))
        self.assertEqual(view["prod"], {"trees": {"R": PROMOTE}, "sessions": {}})
        self.assertEqual([w["session"] for w in view["working"]], ["a", "r", "kid"])
        self.assertEqual(json.loads(self.run_cli("prod"))["until"], until)
        self.run_cli("prod", "clear")
        self.assertIsNone(json.loads(self.run_cli("prod")))
        self.assertEqual(json.loads(self.run_cli("admit", "r2", "--tree", "R", "--pid", str(ME)))["state"], "queued")
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            logged = [json.loads(line)["trees"] for line in f if '"event": "prod_turns"' in line]
        self.assertEqual(logged, [{"R": PROMOTE}, {}])


if __name__ == "__main__":
    unittest.main()
