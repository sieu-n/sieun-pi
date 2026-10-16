"""Prod turns (pool/prod.py): a tree that owns a running prod deploy and a chat the alert bridge
woke for a firing prod alert never wait in the turn queue. Replays the queue of 10-15 09:59Z,
when promote 10 try 3 ran and the release owner sat 58th of 60."""
import json, os, subprocess, tempfile, unittest

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


def load_fixture():
    with open(os.path.join(HERE, "live_1015_1859kst.json")) as f:
        return json.load(f)


def runs_cache(*runs):
    """A ci-runs.json the way ci-cache writes it: {runs: {id: {run, runReadAt, jobs}}}."""
    return {"version": 1, "repo": "sieu-n/auto-sns-agent", "intervalSeconds": 30,
            "runs": {str(r["id"]): {"run": r, "runReadAt": 1, "jobs": [{"name": "deploy", "status": r["status"]}]} for r in runs}}


def bridge(*alerts):
    return {"v": 1, "alerts": {f"k{i}@x": {"chat": chat, "step": None, "alertname": name, "startsAt": "x", "wokeAt": 0, "firstWokeAt": 0}
                               for i, (chat, name) in enumerate(alerts)}}


class Files(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-prod-")
        self.cfg = dict(base.DEFAULTS, prod_runs_file=os.path.join(self.dir, "ci-runs.json"),
                        alert_bridge_file=os.path.join(self.dir, "alert-bridge.json"))
        self.promote = load_fixture()["promote_run"]

    def write(self, key, value):
        with open(self.cfg[key], "w") as f:
            json.dump(value, f, separators=(",", ":"))


class Deploys(Files):
    def test_a_promote_run_in_progress_makes_both_owner_trees_prod(self):
        self.write("prod_runs_file", runs_cache(self.promote))
        rec = prod.read(self.cfg, 5)
        self.assertEqual(rec["trees"], {RELEASE: "promote.yml run 38708750431", METAL: "promote.yml run 38708750431"})
        self.assertEqual(rec["sessions"], {})

    def test_a_completed_run_or_another_workflow_makes_nothing_prod(self):
        done = dict(self.promote, status="completed", conclusion="success")
        other = dict(self.promote, id=1, path=".github/workflows/metal-deploy-tests.yml", name="metal-deploy-tests")
        self.write("prod_runs_file", runs_cache(done, other))
        self.assertEqual(prod.read(self.cfg, 5)["trees"], {})

    def test_a_queued_metal_deploy_makes_metal_prod(self):
        run = dict(self.promote, id=7, path=".github/workflows/metal-deploy.yml", name="metal-deploy", status="queued")
        self.write("prod_runs_file", runs_cache(run))
        self.assertEqual(prod.read(self.cfg, 5)["trees"], {METAL: "metal-deploy.yml run 7"})

    def test_a_missing_or_broken_cache_makes_nothing_prod(self):
        self.assertEqual(prod.read(self.cfg, 5), {"at": 5, "trees": {}, "sessions": {}})
        with open(self.cfg["prod_runs_file"], "w") as f:
            f.write('{"runs":{"1":{"run":{"id":1,"path":".github/workflows/promote.yml","status":"in_pro')
        self.assertEqual(prod.read(self.cfg, 5)["trees"], {})


class Alerts(Files):
    def test_only_prod_alerts_from_the_bridge_make_the_woken_chat_prod(self):
        """The alert names the bridge tracked on 10-15 at 11:05Z."""
        self.write("alert_bridge_file", bridge(
            (CRAWLER, "Production stream entry waiting over 1 hour"),
            (CRAWLER, "Staging engage fleet under its serving line"),
            ("chat-b", "B2 influencer-dev inventory missing, incomplete or older than 36 hours"),
            ("chat-c", "B2 influencer-prod inventory missing, incomplete or older than 36 hours"),
            (METAL, "us-metal01 filesystem fills within 30 days"),
            ("chat-d", "Staging Instagram posts missing from content search")))
        rec = prod.read(self.cfg, 5)
        self.assertEqual(rec["sessions"], {CRAWLER: "alert Production stream entry waiting over 1 hour",
                                           "chat-c": "alert B2 influencer-prod inventory missing, incomplete or older than 36 hours"})
        self.assertEqual(rec["trees"], {})

    def test_the_woken_chat_runs_at_once_and_its_jobs_still_queue(self):
        t = turns.empty()
        t["prod"] = {"at": 0, "trees": {}, "sessions": {CRAWLER: "alert Production crawler health read over 2 s"}}
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
        self.dir = tempfile.mkdtemp(prefix="pi-pool-prod-")
        self.cfg = dict(base.DEFAULTS, prod_runs_file=os.path.join(self.dir, "ci-runs.json"),
                        alert_bridge_file=os.path.join(self.dir, "none.json"))
        with open(self.cfg["prod_runs_file"], "w") as f:
            json.dump(runs_cache(self.fx["promote_run"]), f)

    def test_without_prod_turns_the_release_owner_sits_58th_of_60(self):
        snap = self.fx["snapshots"][0]
        t = self.state(snap)
        self.assertEqual((len(t["working"]), len(t["queued"])), (14, 60))
        self.assertEqual(turns.order(t["queued"], snap["at"], 18).index(RELEASE) + 1, 58)
        self.assertEqual(turns.admit_pass(t, snap["at"], 12, 8, 18), [], "12 slots are taken, so nobody starts")

    def test_with_promote_running_both_owner_roots_start_at_once_and_nobody_else_does(self):
        snap = self.fx["snapshots"][0]
        t = self.state(snap)
        self.assertEqual(turns.order(t["queued"], snap["at"], 18).index(METAL) + 1, 16)
        self.assertTrue(turns.prod_watch(t, snap["at"], self.cfg)[0])
        got = turns.admit_pass(t, snap["at"], 12, 8, 18)
        self.assertEqual(got, [(METAL, "prod"), (RELEASE, "prod")])
        self.assertEqual(t["working"][RELEASE]["why"], "promote.yml run 38708750431")
        self.assertEqual(len(t["queued"]), 58)

    def test_metal_queued_again_63rd_of_69_and_starts_at_once_through_admit(self):
        snap = self.fx["snapshots"][1]
        t = self.state(snap)
        mine = t["queued"].pop(METAL)
        self.assertEqual(turns.order(dict(t["queued"], **{METAL: mine}), snap["at"], 18).index(METAL) + 1, 63)
        cfg = dict(self.cfg, mac_working_max=12)
        ask = {"session": METAL, "tree": METAL, "parent": None, "class": None, "pid": ME, "renew": False}
        sessions = {METAL: {"priority": "high"}}
        _, answer, events = turns.ask(t, sessions, ask, snap["at"], cfg)
        self.assertEqual(answer, {"state": "admitted", "kind": "prod", "position": None, "total": None})
        self.assertIn(("prod_turns", {"trees": {RELEASE: "promote.yml run 38708750431", METAL: "promote.yml run 38708750431"}, "sessions": {}}), events)
        self.assertEqual([s for s, e in t["working"].items() if e["kind"] == "prod"], [RELEASE, METAL],
                         "the release owner, queued since 09:58:59Z, started on the same pass")

    def test_after_the_run_completes_the_next_read_queues_them_again(self):
        snap = self.fx["snapshots"][0]
        t = self.state(snap)
        turns.prod_watch(t, snap["at"], self.cfg)
        with open(self.cfg["prod_runs_file"], "w") as f:
            json.dump(runs_cache(dict(self.fx["promote_run"], status="completed", conclusion="success")), f)
        self.assertEqual(turns.prod_watch(t, snap["at"] + turns.PROD_TTL_SEC - 1, self.cfg), (False, []), "one read serves 30 s")
        refreshed, events = turns.prod_watch(t, snap["at"] + turns.PROD_TTL_SEC, self.cfg)
        self.assertEqual((refreshed, events), (True, [("prod_turns", {"trees": {}, "sessions": {}})]))
        self.assertEqual(turns.admit_pass(t, snap["at"] + 30, 12, 8, 18), [])

    def test_the_off_switch_drops_the_record(self):
        t = self.state(self.fx["snapshots"][0])
        turns.prod_watch(t, 0, self.cfg)
        self.assertEqual(turns.prod_watch(t, 1, dict(self.cfg, prod_turns_on=0)), (True, []))
        self.assertNotIn("prod", t)
        self.assertEqual(turns.admit_pass(t, 1, 12, 8, 18), [])


class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-prod-cli-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        promote = load_fixture()["promote_run"]
        with open(os.path.join(self.dir, "ci-runs.json"), "w") as f:
            json.dump(runs_cache(promote), f)
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump({"mac_working_max": 1, "prod_deploy_owners": {"promote.yml": ["R"]},
                       "prod_runs_file": os.path.join(self.dir, "ci-runs.json"), "alert_bridge_file": os.path.join(self.dir, "none.json")}, f)

    def run_cli(self, *args):
        done = subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), *args],
                              env=self.env, capture_output=True, text=True, timeout=30)
        if done.returncode:
            raise AssertionError(done.stderr or done.stdout)
        return done.stdout

    def test_a_turn_of_a_deploying_tree_is_admitted_as_prod_and_queue_json_names_why(self):
        self.assertEqual(json.loads(self.run_cli("admit", "a", "--tree", "A", "--pid", str(ME)))["kind"], "slot")
        self.assertEqual(json.loads(self.run_cli("admit", "j", "--tree", "J", "--pid", str(ME)))["state"], "queued")
        self.assertEqual(json.loads(self.run_cli("admit", "kid", "--tree", "R", "--parent", "R", "--pid", str(ME))),
                         {"state": "admitted", "kind": "prod", "position": None, "total": None})
        view = json.loads(self.run_cli("queue", "--json"))
        self.assertEqual(view["prod"], {"trees": {"R": "promote.yml run 38708750431"}, "sessions": {}})
        self.assertEqual([w["session"] for w in view["working"]], ["a", "kid"])
