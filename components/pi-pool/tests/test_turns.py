"""The machine-wide turn queue (pool/turns.py): admit, release, owner-turn, queue --json,
borrowing, class order, aging, the stale sweep, and a replay of the 10-14 02 KST burst.
"""
import calendar, collections, heapq, json, os, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE
from vend.pool import base, turns


def setUpModule():
    isolate_test_module()


ME = os.getpid()
DEAD = 2 ** 22 + 12345  # above macOS's pid_max of 99,998, so never a live process


def entry(tree="t", parent=None, klass="normal", since=0.0, pid=ME, waiter=None):
    return {"tree": tree, "parent": parent, "class": klass, "since": since, "pid": pid, "waiter": waiter}


def queue_up(t, now, mac=16, tree=8, aging=18, **entries):
    for session, e in entries.items():
        t["queued"][session] = e
    return turns.admit_pass(t, now, mac, tree, aging)


def read(path):
    with open(path) as f:
        return json.load(f)


def fill(t, n, tree="busy"):
    for i in range(n):
        t["working"][f"w{i}"] = dict(entry(tree=f"{tree}{i}"), kind="slot")


class Order(unittest.TestCase):
    def test_free_slots_go_by_class_then_longest_wait(self):
        t = turns.empty()
        fill(t, 3)
        queue_up(t, 10, mac=3, low=entry(klass="low", since=1), n1=entry(since=5, tree="a"), n0=entry(since=3, tree="b"),
                 high=entry(klass="high", since=9, tree="c"))
        self.assertEqual(turns.order(t["queued"], 10, 18), ["high", "n0", "n1", "low"])
        del t["working"]["w0"], t["working"]["w1"]
        self.assertEqual(turns.admit_pass(t, 10, 3, 8, 18), [("high", "slot"), ("n0", "slot")])

    def test_a_queued_turn_moves_up_one_class_per_aging_period(self):
        q = {"low": entry(klass="low", since=0), "normal": entry(since=10), "high": entry(klass="high", since=30)}
        self.assertEqual(turns.order(q, 17, 18), ["high", "normal", "low"])
        self.assertEqual(turns.order(q, 18, 18), ["high", "low", "normal"], "low waited 18 s and is normal now, ahead by its wait")
        self.assertEqual(turns.order(q, 30, 18), ["normal", "high", "low"], "normal waited 20 s and is high, ahead by its wait")
        self.assertEqual(turns.order(q, 36, 18), ["low", "normal", "high"])
        self.assertEqual(turns.rank(q["low"], 1000, 18), 2, "aging stops at high")

    def test_the_tree_limit_skips_a_full_tree_and_admits_the_next(self):
        t = turns.empty()
        for i in range(2):
            t["working"][f"a{i}"] = dict(entry(tree="A"), kind="slot")
        got = queue_up(t, 5, mac=16, tree=2, a2=entry(tree="A", klass="high", since=1), b0=entry(tree="B", since=2))
        self.assertEqual(got, [("b0", "slot")])
        self.assertIn("a2", t["queued"])

    def test_a_borrow_takes_no_slot(self):
        """10-14 11:02 KST: 7 of 30 working turns were borrows, and each one kept a
        queued run off a free slot."""
        t = turns.empty()
        fill(t, 14)
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        t["working"]["kid"] = dict(entry(tree="P", parent="parent"), kind="borrow", lender="parent")
        self.assertEqual(queue_up(t, 1, job=entry(tree="j")), [("job", "slot")], "15 slots in use, so the 16th is free")
        self.assertEqual(queue_up(t, 2, late=entry(tree="l")), [])
        self.assertEqual((len(turns.in_slots(t["working"])), len(t["working"])), (16, 17))

    def test_a_borrow_does_not_count_toward_its_trees_limit(self):
        t = turns.empty()
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        t["working"]["kid"] = dict(entry(tree="P", parent="parent"), kind="borrow", lender="parent")
        self.assertEqual(queue_up(t, 1, tree=2, other=entry(tree="P")), [("other", "slot")])

    def test_every_working_turn_counts_toward_the_mac_limit(self):
        t = turns.empty()
        fill(t, 15)
        t["working"]["boss"] = dict(entry(tree="owner"), kind="owner")
        self.assertEqual(queue_up(t, 1, job=entry(tree="j")), [], "an owner turn fills the 16th slot")
        del t["working"]["w0"]
        self.assertEqual(turns.admit_pass(t, 2, 16, 8, 18), [("job", "slot")])


class Borrow(unittest.TestCase):
    def test_a_parent_that_spawns_six_children_lends_one_slot(self):
        t = turns.empty()
        fill(t, 15)
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        kids = {f"kid{i}": entry(tree="P", parent="parent", since=i) for i in range(6)}
        got = queue_up(t, 10, **kids)
        self.assertEqual(got, [("kid0", "borrow")])
        self.assertEqual(sorted(t["queued"]), ["kid1", "kid2", "kid3", "kid4", "kid5"])
        self.assertEqual(len(t["working"]), 17, "the borrow is the one turn over the limit")
        del t["working"]["kid0"]
        self.assertEqual(turns.admit_pass(t, 11, 16, 8, 18), [("kid1", "borrow")], "the lent slot passes to the next child")
        self.assertEqual(sum(e["kind"] == "borrow" for e in t["working"].values()), 1)

    def test_a_child_takes_a_free_slot_before_it_borrows(self):
        t = turns.empty()
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        self.assertEqual(queue_up(t, 1, kid=entry(tree="P", parent="parent")), [("kid", "slot")])

    def test_a_child_of_an_idle_parent_waits(self):
        t = turns.empty()
        fill(t, 16)
        self.assertEqual(queue_up(t, 1, kid=entry(tree="P", parent="parent")), [])

    def test_a_borrowing_child_keeps_running_after_its_parent_ends(self):
        t = turns.empty()
        fill(t, 16)
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        queue_up(t, 1, kid=entry(tree="P", parent="parent"))
        del t["working"]["parent"]
        turns.admit_pass(t, 2, 16, 8, 18)
        self.assertEqual(t["working"]["kid"]["kind"], "borrow")


class Sweep(unittest.TestCase):
    def test_a_gone_process_frees_its_slot_and_its_queue_place(self):
        t = turns.empty()
        t["working"]["crashed"] = dict(entry(pid=DEAD), kind="slot")
        t["working"]["live"] = dict(entry(), kind="slot")
        t["queued"]["waiter_gone"] = entry(waiter=DEAD)
        t["queued"]["fine"] = entry(waiter=ME)
        gone = turns.sweep(t, 10)
        self.assertEqual(sorted(g["session"] for g in gone), ["crashed", "waiter_gone"])
        self.assertEqual((sorted(t["working"]), sorted(t["queued"])), (["live"], ["fine"]))

    def test_a_slot_lapses_when_its_lease_runs_out(self):
        t = turns.empty()
        t["working"]["quiet"] = dict(entry(), kind="slot", lease_until=100)
        t["working"]["busy"] = dict(entry(), kind="slot", lease_until=200)
        gone = turns.sweep(t, 150)
        self.assertEqual([(g["session"], g["why"]) for g in gone], [("quiet", "lease ran out")])

    def test_an_unused_owner_mark_expires(self):
        t = turns.empty()
        t["owner"] = {"old": 0, "new": turns.OWNER_MARK_TTL_SEC}
        turns.sweep(t, turns.OWNER_MARK_TTL_SEC + 1)
        self.assertEqual(list(t["owner"]), ["new"])


def ask_args(session, tree="t", parent=None, klass=None, renew=False):
    return {"session": session, "tree": tree, "parent": parent, "class": klass, "pid": ME, "wait": False, "renew": renew}


class Lease(unittest.TestCase):
    CFG = dict(base.DEFAULTS, working_max=1)

    def test_a_run_that_calls_the_model_every_300_s_keeps_its_slot(self):
        """A 3,000 s run, longer than lease_s, whose model calls renew every 300 s;
        another session waits the whole time."""
        t = turns.empty()
        self.assertEqual(turns.ask(t, {}, ask_args("long"), 0, self.CFG)[1]["state"], "admitted")
        self.assertEqual(turns.ask(t, {}, ask_args("other", tree="o"), 1, self.CFG)[1]["state"], "queued")
        for now in range(300, 3001, 300):
            turns.sweep(t, now)
            self.assertEqual(list(t["working"]), ["long"], now)
            self.assertEqual(turns.ask(t, {}, ask_args("long", renew=True), now, self.CFG)[1]["kind"], "slot")
        self.assertEqual(list(t["queued"]), ["other"])

    def test_a_renewal_after_a_lapse_runs_at_once_and_never_queues(self):
        t = turns.empty()
        turns.ask(t, {}, ask_args("asleep"), 0, self.CFG)
        later = base.DEFAULTS["lease_s"] + 60
        turns.sweep(t, later)
        self.assertEqual(turns.ask(t, {}, ask_args("other", tree="o"), later, self.CFG)[1]["state"], "admitted")
        changed, answer, events = turns.ask(t, {}, ask_args("asleep", renew=True), later + 1, self.CFG)
        self.assertEqual(answer, {"state": "admitted", "kind": "slot", "position": None, "total": None})
        self.assertEqual(sorted(t["working"]), ["asleep", "other"], "the Mac runs one over its limit rather than stop a run")
        self.assertIn("turn_renewed_after_lapse", [e for e, _ in events])

    def test_a_run_stuck_in_one_tool_call_frees_its_slot_after_lease_s(self):
        """10-14 11:02 KST: 01a137fe held an owner slot 2,887 s inside one bash call
        (`devstack.mjs logs`) and three aside_browser cells held slots 2,653 to 2,937 s,
        each kept by a timer renewal with no model call. With renewals only from model
        calls the lease runs out, the queued run takes the slot, and the stuck run's next
        model call works again at once."""
        t = turns.empty()
        turns.ask(t, {}, ask_args("stuck"), 0, self.CFG)
        self.assertEqual(turns.ask(t, {}, ask_args("other", tree="o"), 1, self.CFG)[1]["state"], "queued")
        lease = base.DEFAULTS["lease_s"]
        changed, answer, events = turns.ask(t, {}, ask_args("third", tree="x"), lease + 1, self.CFG)
        self.assertIn(("turn_swept", {"session": "stuck", "part": "working", "why": "lease ran out"}), events)
        self.assertEqual(list(t["working"]), ["other"])
        self.assertEqual(turns.ask(t, {}, ask_args("stuck", renew=True), 2887, self.CFG)[1]["state"], "admitted")

    def test_without_renew_a_lapsed_session_queues_like_a_new_run(self):
        t = turns.empty()
        turns.ask(t, {}, ask_args("other", tree="o"), 0, self.CFG)
        self.assertEqual(turns.ask(t, {}, ask_args("next"), 1, self.CFG)[1]["state"], "queued")


def kst(clock):
    """Epoch seconds of 10-14 `clock` KST."""
    return calendar.timegm(time.strptime(f"2026-10-14 {clock}", "%Y-%m-%d %H:%M:%S")) - 9 * 3600


class OwnerLog(unittest.TestCase):
    """pi-pool.log on 10-14 had 25 owner admits that waited, up to 712.7 s. Each one
    was owner-turn starting an agent run already in the queue, logged as the owner's
    with that run's wait, and 15 of the 25 marks came from the extension's input hook
    on a [job] or [brief check] notice, not from the owner."""
    CFG = dict(base.DEFAULTS, working_max=16)

    def full(self):
        t = turns.empty()
        fill(t, 16)
        return t

    def test_frontend_bro_1021_the_owners_board_answer_never_waits(self):
        """01a11ba8: an agent-message wake queued at 10:09:15 behind 16 working turns.
        The owner answered a board todo at 10:21:07, which the log showed as an owner
        admit that waited 712.7 s. That run ended at 10:21:15 and the owner's own run
        started at 10:21:16."""
        t, chat = self.full(), "01a11ba8-9d2c-727c-8ded-38f819ca9f29"
        self.assertEqual(turns.ask(t, {}, ask_args(chat, tree=chat, klass="high"), kst("10:09:15"), self.CFG)[1]["state"], "queued")
        answer, events = turns.mark_owner(t, chat, kst("10:21:07"), 1800)
        self.assertEqual(answer["state"], "marked")
        self.assertEqual(events[-1], ("turn_admitted", {"session": chat, "tree": chat, "kind": "ahead", "waited_s": 712.0}))
        del t["working"][chat]
        changed, answer, events = turns.ask(t, {}, ask_args(chat, tree=chat), kst("10:21:16"), self.CFG)
        self.assertEqual(answer["kind"], "owner")
        self.assertEqual([f for e, f in events if e == "turn_admitted"], [{"session": chat, "tree": chat, "kind": "owner", "waited_s": 0.0}])
        self.assertEqual(t["owner"], {}, "the owner's run took the mark")

    def test_launch_main_bro_0935_a_job_notice_is_no_owner_turn(self):
        """01a11bd7: a run queued at 09:31:11, and a [job] notice at 09:35:44 made the
        input hook call owner-turn, so the log showed an owner admit that waited
        273.2 s. Without a mark the notice's run keeps its place in the queue."""
        t, chat = self.full(), "01a11bd7-072f-7591-ad1d-f123c276cde5"
        turns.ask(t, {}, ask_args(chat, tree=chat, klass="high"), kst("09:31:11"), self.CFG)
        changed, answer, events = turns.ask(t, {}, ask_args(chat, tree=chat, klass="high"), kst("09:35:44"), self.CFG)
        self.assertEqual((answer["state"], [e for e, _ in events if e == "turn_admitted"]), ("queued", []))
        del t["working"]["w0"]
        self.assertEqual(turns.admit_pass(t, kst("09:35:50"), 16, 8, 18), [(chat, "slot")])

    def test_a_mark_on_a_working_session_waits_for_its_next_run(self):
        """The owner's prompt to a session in flight starts the next run: 107 of 107
        owner prompts on 10-14 08:06-11:02 KST did."""
        t = turns.empty()
        turns.ask(t, {}, ask_args("chat"), 0, self.CFG)
        turns.mark_owner(t, "chat", 5, 1800)
        self.assertEqual(t["working"]["chat"]["kind"], "slot")
        del t["working"]["chat"]
        self.assertEqual(turns.ask(t, {}, ask_args("chat"), 40, self.CFG)[1]["kind"], "owner")
        self.assertEqual(turns.ask(t, {}, ask_args("wake", tree="w"), 41, self.CFG)[1]["kind"], "slot")


class Class(unittest.TestCase):
    def cls(self, sessions, **kw):
        t = turns.empty()
        fill(t, 16)
        turns.ask(t, sessions, ask_args("s", tree="T", **kw), 0, dict(base.DEFAULTS))
        return t["queued"]["s"]["class"]

    def test_a_child_of_a_high_chat_queues_as_normal(self):
        self.assertEqual(self.cls({"T": {"priority": "high"}}, parent="chat"), "normal")

    def test_a_child_of_a_tree_the_owner_labeled_high_queues_as_high(self):
        self.assertEqual(self.cls({"T": {"priority": "high", "priority_label": "high"}}, parent="chat"), "high")

    def test_a_root_takes_its_trees_priority(self):
        self.assertEqual(self.cls({"T": {"priority": "low"}}), "low")
        self.assertEqual(self.cls({}), "normal")

    def test_an_explicit_class_wins(self):
        self.assertEqual(self.cls({"T": {"priority_label": "high"}}, parent="chat", klass="low"), "low")


class Top(unittest.TestCase):
    """The top class queues above every class. 10-15: with 60 to 77 turns queued, every entry aged to high within 36 s and
    the chat service's check-in keys waited up to 381 s behind them."""
    KEY = "duty:01a11bd7-072f-7591-ad1d-f123c276cde5:checkin"

    def test_a_top_turn_goes_first_and_aging_never_reaches_it(self):
        q = {"old": entry(klass="normal", since=0, tree="a"), self.KEY: entry(klass=turns.TOP, since=900, tree=self.KEY)}
        self.assertEqual(turns.order(q, 1000, 18), [self.KEY, "old"], "a normal turn aged to high for 1,000 s still queues behind it")
        self.assertGreater(turns.rank(q[self.KEY], 1000, 18), turns.rank(q["old"], 10 ** 6, 18))

    def test_the_caller_names_the_top_class_for_any_key(self):
        for session in (self.KEY, "01a13f01-43ec-7528-bb71-4382a7c6d730"):
            self.assertEqual(turns.parse([session, "--class", "top", "--wait"])["class"], turns.TOP)
        with self.assertRaises(SystemExit):
            turns.parse([self.KEY, "--class", "checkin"])

    def test_queue_json_shows_a_top_turn_as_high(self):
        t = turns.empty()
        t["queued"][self.KEY] = entry(klass=turns.TOP, since=0, tree=self.KEY)
        shown = turns.view(t, 5, dict(base.DEFAULTS))["queued"][0]
        self.assertEqual((shown["class"], shown["base_class"]), ("high", "high"))


class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-turns-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        self.set("working_max", "2")

    def run_cli(self, *args, check=True):
        done = subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), *args],
                              env=self.env, capture_output=True, text=True, timeout=30)
        if check and done.returncode:
            raise AssertionError(done.stderr or done.stdout)
        return done

    def set(self, key, value):
        self.run_cli("set", key, value)

    def admit(self, session, *extra):
        return json.loads(self.run_cli("admit", session, "--pid", str(ME), *extra).stdout.splitlines()[-1])

    def queue(self):
        return json.loads(self.run_cli("queue", "--json").stdout)

    def test_admit_queue_release_and_the_queue_view(self):
        self.assertEqual(self.admit("a", "--tree", "A", "--class", "high"), {"state": "admitted", "kind": "slot", "position": None, "total": None})
        self.admit("b", "--tree", "B")
        self.assertEqual(self.admit("c", "--tree", "C", "--class", "low"), {"state": "queued", "kind": None, "position": 1, "total": 1})
        self.assertEqual(self.admit("c", "--tree", "C", "--class", "low")["position"], 1, "asking again keeps the place")
        view = self.queue()
        self.assertEqual((view["enabled"], view["working_max"], view["tree_working_max"]), (True, 2, 8))
        self.assertEqual([w["session"] for w in view["working"]], ["a", "b"])
        self.assertEqual(set(view["working"][0]), {"session", "tree", "parent", "class", "kind", "since"})
        q = view["queued"][0]
        self.assertEqual(set(q), {"session", "tree", "parent", "class", "base_class", "position", "total", "since", "wait_s"})
        self.assertEqual((q["session"], q["class"], q["base_class"], q["position"], q["total"]), ("c", "low", "low", 1, 1))
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": True})
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": False}, "release is idempotent")
        self.assertEqual([w["session"] for w in self.queue()["working"]], ["b", "c"], "the release admitted c")

    def test_set_records_who_and_when_in_config_and_the_log(self):
        before = round(time.time())
        self.run_cli("set", "working_max", "30", "--by", "the Settings pane")
        record = self.queue()["working_max_set"]
        self.assertEqual(record["by"], "the Settings pane")
        self.assertGreaterEqual(record["at"], before)
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            logged = [json.loads(line) for line in f if '"event": "set"' in line][-1]
        self.assertEqual({k: logged[k] for k in ("key", "value", "was", "by")},
                         {"key": "working_max", "value": 30, "was": 2, "by": "the Settings pane"})
        self.env[base.SESSION_ENV] = "01a-root"
        self.set("working_max", "16")
        self.assertEqual(self.queue()["working_max_set"]["by"], "Prime session 01a-root")

    def test_a_value_with_no_set_record_shows_the_file_time_and_the_default_shows_none(self):
        path = os.path.join(self.dir, "config.json")
        with open(path, "w") as f:
            json.dump({"agent_queue_on": 1, "working_max": 30}, f)
        os.utime(path, (1791942343, 1791942343))
        self.assertEqual(self.queue()["working_max_set"], {"by": None, "at": 1791942343})
        with open(path, "w") as f:
            json.dump({"agent_queue_on": 1}, f)
        self.assertIsNone(self.queue()["working_max_set"])

    def test_priority_label_marks_the_tree_and_a_plain_priority_clears_it(self):
        self.run_cli("priority", "high", "--label", "--session", "01a00000-0000-0000-0000-000000000001")
        rec = read(os.path.join(self.dir, "state.json"))["sessions"]["01a00000-0000-0000-0000-000000000001"]
        self.assertEqual((rec["priority"], rec["priority_label"]), ("high", "high"))
        self.run_cli("priority", "high", "--session", "01a00000-0000-0000-0000-000000000001")
        rec = read(os.path.join(self.dir, "state.json"))["sessions"]["01a00000-0000-0000-0000-000000000001"]
        self.assertNotIn("priority_label", rec)

    def test_renew_never_queues(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        self.assertEqual(self.admit("c", "--tree", "C", "--renew")["state"], "admitted")
        self.assertEqual(self.run_cli("admit", "c", "--wait", "--renew", check=False).returncode != 0, True)

    def test_the_class_defaults_to_the_trees_pool_priority(self):
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump({"version": 2, "providers": {}, "sessions": {"T": {"priority": "low"}}}, f)
        self.admit("x", "--tree", "T")
        self.admit("y", "--tree", "U")
        self.admit("z", "--tree", "T")
        self.assertEqual(self.queue()["queued"][0]["base_class"], "low")

    def test_an_owner_turn_never_waits_and_counts(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        self.run_cli("owner-turn", "boss")
        self.assertEqual(self.admit("boss", "--tree", "O"), {"state": "admitted", "kind": "owner", "position": None, "total": None})
        self.assertEqual(self.admit("job", "--tree", "J")["state"], "queued")
        self.run_cli("release", "a")
        self.assertEqual(self.queue()["queued"][0]["session"], "job", "3 working of 2: a release admits nobody")
        self.run_cli("release", "boss")
        self.assertEqual([w["session"] for w in self.queue()["working"]], ["b", "job"])

    def test_an_owner_turn_starts_a_queued_agent_run_ahead_and_keeps_the_mark(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        self.admit("chat", "--tree", "C")
        self.assertEqual(json.loads(self.run_cli("owner-turn", "chat").stdout), {"session": "chat", "state": "marked", "ahead": True})
        self.assertEqual({w["session"]: w["kind"] for w in self.queue()["working"]}["chat"], "ahead")
        self.run_cli("release", "chat")
        self.assertEqual(self.admit("chat", "--tree", "C")["kind"], "owner")
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            logged = [json.loads(line) for line in f if '"turn_admitted"' in line and '"chat"' in line]
        self.assertEqual([e["kind"] for e in logged], ["ahead", "owner"])
        self.assertEqual(logged[1]["waited_s"], 0.0)

    def test_off_admits_everything_records_nothing_and_keeps_the_limit(self):
        self.set("agent_queue_on", "0")
        saved = read(os.path.join(self.dir, "config.json"))
        self.assertEqual({k: v for k, v in saved.items() if k != "set_by"}, {"working_max": 2, "agent_queue_on": 0})
        for s in "abc":
            self.assertEqual(self.admit(s)["state"], "off")
        view = self.queue()
        self.assertEqual((view["enabled"], view["working_max"], view["working"]), (False, 2, []))

    def test_asking_again_while_working_renews_the_lease(self):
        self.admit("a")
        first = read(os.path.join(self.dir, "state.json"))["turns"]["working"]["a"]["lease_until"]
        time.sleep(0.05)
        self.assertEqual(self.admit("a")["kind"], "slot")
        again = read(os.path.join(self.dir, "state.json"))["turns"]["working"]["a"]["lease_until"]
        self.assertGreater(again, first)
        self.assertAlmostEqual(again - time.time(), base.DEFAULTS["lease_s"], delta=5)

    def test_wait_blocks_until_a_release_admits_it(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        waiter = subprocess.Popen(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), "admit", "w", "--tree", "W",
                                   "--pid", str(ME), "--wait"], env=self.env, stdout=subprocess.PIPE, text=True)
        first = json.loads(waiter.stdout.readline())
        self.assertEqual((first["state"], first["position"]), ("queued", 1))
        time.sleep(1.5)
        self.assertIsNone(waiter.poll(), "still waiting while both slots work")
        started = time.monotonic()
        self.run_cli("release", "a")
        out, _ = waiter.communicate(timeout=10)
        self.assertEqual(waiter.returncode, 0)
        self.assertEqual(json.loads(out.splitlines()[-1]), {"state": "admitted", "kind": "slot", "position": None, "total": None})
        self.assertLess(time.monotonic() - started, 3)

    def test_wait_ends_and_drops_its_place_when_the_queue_turns_off(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        waiter = subprocess.Popen(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), "admit", "w", "--pid", str(ME), "--wait"],
                                  env=self.env, stdout=subprocess.PIPE, text=True)
        waiter.stdout.readline()
        self.set("agent_queue_on", "0")
        out, _ = waiter.communicate(timeout=10)
        self.assertEqual((waiter.returncode, json.loads(out.splitlines()[-1])["state"]), (0, "off"))
        self.set("agent_queue_on", "1")
        self.assertEqual(self.queue()["queued"], [])

    def test_a_killed_waiter_leaves_no_queue_entry(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        waiter = subprocess.Popen(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), "admit", "w", "--pid", str(ME), "--wait"],
                                  env=self.env, stdout=subprocess.PIPE, text=True)
        waiter.stdout.readline()
        waiter.kill()
        waiter.wait()
        waiter.stdout.close()
        self.assertEqual(self.queue()["queued"], [])

    def test_a_turn_whose_process_is_gone_frees_its_slot(self):
        self.admit("a", "--tree", "A")
        json.loads(self.run_cli("admit", "crashed", "--pid", str(DEAD)).stdout)
        self.assertEqual(self.admit("next", "--tree", "N")["state"], "admitted")


class Burst(unittest.TestCase):
    """Replay of every turn that started 10-14 02:00-03:00 KST, when load reached
    208 at 02:56: 852 turns of 185 sessions, 122 of them starting a turn inside one
    5-minute window, and up to 51 turns in flight at once with no queue. Each turn
    asks at its recorded start (or when the session's previous turn ends, if later),
    and runs its recorded length once admitted. Nobody is the owner. At most 16 turns
    run on slots; the rest are children that run on a parent's lent slot, at most one
    per parent, while that parent's turn is in flight."""

    def test_the_burst_never_gives_more_than_16_slots(self):
        with open(os.path.join(os.path.dirname(__file__), "burst_1014_02kst.json")) as f:
            fixture = json.load(f)["turns"]
        cfg = dict(base.DEFAULTS)
        mac, tree_max, aging = turns.limits(cfg)
        self.assertEqual((mac, tree_max), (16, 8))
        by_session = collections.defaultdict(collections.deque)
        for i, turn in enumerate(sorted(fixture, key=lambda x: x["start"])):
            by_session[turn["session"]].append(dict(turn, id=i))
        events, t = [], turns.empty()
        for session, queue in by_session.items():
            first = queue[0]
            heapq.heappush(events, (first["start"], 1, first["id"], session))
        length = {}
        peak_working = peak_slots = peak_borrows = admitted = 0
        waits = []

        def admit_all(now):
            nonlocal admitted
            for session, kind in turns.admit_pass(t, now, mac, tree_max, aging):
                admitted += 1
                waits.append(now - t["working"][session]["queued_since"])
                heapq.heappush(events, (now + length[session], 0, 0, session))

        while events:
            now, arriving, _, session = heapq.heappop(events)
            if arriving:
                turn = by_session[session][0]
                length[session] = turn["secs"]
                t["queued"][session] = entry(tree=turn["tree"], parent=turn["parent"], since=now,
                                             klass="high" if turn["depth"] == 0 else "normal")
            else:
                del t["working"][session]
                by_session[session].popleft()
                if by_session[session]:
                    nxt = by_session[session][0]
                    heapq.heappush(events, (max(now, nxt["start"]), 1, nxt["id"], session))
            admit_all(now)
            kinds = collections.Counter(e["kind"] for e in t["working"].values())
            lenders = collections.Counter(e["lender"] for e in t["working"].values() if e["kind"] == "borrow")
            self.assertLessEqual(kinds["slot"], 16)
            self.assertLessEqual(len(t["working"]), 16 + kinds["borrow"])
            self.assertTrue(all(n == 1 for n in lenders.values()), "a parent lends one slot at a time")
            peak_working = max(peak_working, len(t["working"]))
            peak_slots = max(peak_slots, kinds["slot"])
            peak_borrows = max(peak_borrows, kinds["borrow"])
        self.assertEqual(admitted, len(fixture), "every turn ran")
        self.assertEqual(peak_slots, 16)
        self.assertEqual((peak_working, peak_borrows), (27, 11), "turns over 16 are only children on a lent slot")
        waits.sort()
        print(f"\nburst replay: {admitted} turns, peak {peak_working} working, {peak_borrows} borrows at once, "
              f"median wait {waits[len(waits) // 2]:.0f} s, p90 {waits[int(len(waits) * 0.9)]:.0f} s", file=sys.stderr)

class Limit(unittest.TestCase):
    """The working limit is working_max, the number the owner set, whatever the machine's memory reads (owner, c88 on 10-16)."""

    def test_the_limit_is_the_set_number(self):
        t = turns.empty()
        cfg = dict(base.DEFAULTS, working_max=30, tree_working_max=30)
        for i in range(40):
            t["queued"][f"q{i}"] = entry(tree=f"t{i}", since=float(i), klass="low")
        changed, _, admitted, _ = turns.step(t, 100, cfg)
        self.assertTrue(changed)
        self.assertEqual((len(admitted), len(t["working"]), len(t["queued"])), (30, 30, 10))
        view = turns.view(t, 100, cfg)
        self.assertNotIn("pressure", view)
        self.assertEqual(view["working_max"], 30)


class Requeue(unittest.TestCase):
    """A session that asks again within REQUEUE_GRACE_S of its run's release keeps its place in line."""

    def test_a_chained_run_keeps_its_line_and_a_late_one_does_not(self):
        cfg = dict(base.DEFAULTS, working_max=1, prod_turns_on=0)
        t = turns.empty()
        t["working"]["job"] = dict(entry(tree="job", since=0.0), kind="slot", queued_since=0.0, lease_until=10 ** 9)
        t["queued"]["other"] = entry(tree="other", since=5.0)
        turns.leave(t, "job", 100.0, cfg)
        self.assertIn("other", t["working"])
        turns.ask(t, {}, ask_args("job", tree="job"), 110.0, cfg)
        self.assertEqual(turns.line(t["queued"]["job"]), 0.0)
        t["queued"]["new"] = entry(tree="new", since=50.0)
        self.assertEqual(turns.order(t["queued"], 110.0, 18), ["job", "new"])
        turns.leave(t, "other", 200.0, cfg)
        self.assertIn("job", t["working"])
        turns.leave(t, "job", 300.0, cfg)
        turns.ask(t, {}, ask_args("job", tree="job"), 300.0 + turns.REQUEUE_GRACE_S + 1, cfg)
        self.assertNotIn("line", t["queued"].get("job", t["working"].get("job", {})))


if __name__ == "__main__":
    unittest.main()
