"""The Mac-wide turn queue (pool/turns.py): admit, release, owner-turn, queue --json,
borrowing, class order, aging, the stale sweep, and a replay of the 10-14 02 KST burst.
"""
import calendar, collections, heapq, json, os, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE
from vend.pool import base, pressure, turns


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
    CFG = dict(base.DEFAULTS, mac_working_max=1, memory_governor_on=0)

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
    CFG = dict(base.DEFAULTS, mac_working_max=16, memory_governor_on=0)

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
        turns.ask(t, sessions, ask_args("s", tree="T", **kw), 0, dict(base.DEFAULTS, memory_governor_on=0))
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


GB = 10 ** 9
RAM = 34359738368
# 10-14 18:20 KST on the owner's Mac: the kernel said warn, the compressor held 17.1 GB
# of 34.4 GB RAM, and swap held 45.7 of 46.2 GB.
THRASH = {"kernel": 2, "swap_used": 45661159424, "swap_total": 46170898432, "compressor": 17304076288, "ram": RAM}
WARN = dict(THRASH, compressor=8 * GB, swap_used=20 * GB)
CALM = dict(WARN, kernel=1, compressor=4 * GB)
# ops guy's feed, schema v1, at 10:21Z on 10-14: warn while swap held 45.18 of 46.0 GB,
# 16,191 swapouts a second, kernel_task at 224% and load 145.
FEED_1021 = {"v": 1, "ts": "2026-10-14T10:21:36Z", "interval_s": 10, "pressure": "warn", "pressure_level": 2, "free_pct": 35,
             "mem_gb": {"total": 32.0, "free": 0.05, "compressed": 15.9, "wired": 3.8}, "swap_gb": {"used": 45.18, "total": 46.0},
             "swapins_per_s": 14000.0, "swapouts_per_s": 16191.0, "kernel_task_cpu_pct": 224.0, "load": [145.0, 120.0, 100.0],
             "owner_mem_metric": "footprint", "owners": [], "sampler_ms": 40}


class Readings:
    """A stand-in for pressure.read that counts its calls."""

    def __init__(self, reading):
        self.reading, self.calls = reading, 0

    def __call__(self):
        self.calls += 1
        return self.reading


class PressureLevel(unittest.TestCase):
    def test_the_kernel_level_and_the_compressor_share_set_the_level(self):
        level = pressure.level
        self.assertEqual(level(CALM), "ok")
        self.assertEqual(level(WARN), "high")
        self.assertEqual(level(dict(WARN, kernel=4)), "critical")
        self.assertEqual(level(THRASH), "critical", "18:20 KST: kernel warn, compressor at half of RAM")
        self.assertEqual(level(dict(CALM, compressor=16 * GB)), "critical", "18:00 KST: 16 GB compressor")
        self.assertEqual(level(None), "ok", "a broken probe never holds the Mac's agents")

    def test_full_swap_or_fast_swapouts_read_critical_while_the_kernel_says_warn(self):
        level = pressure.level
        feed = pressure.parse_feed(FEED_1021)
        self.assertEqual(level(dict(WARN, **feed)), "critical", "10:21Z: warn, swap 98% full, 16,191 swapouts a second")
        self.assertEqual(level(dict(WARN, swap_used=int(0.96 * WARN["swap_total"]))), "critical", "swap over 95% alone")
        self.assertEqual(level(dict(WARN, swapouts=6210)), "critical", "the slowest swapout rate measured while kernel_task paged")
        self.assertEqual(level(dict(WARN, swapouts=5999)), "high")
        self.assertEqual(level(dict(CALM, swap_total=0, swap_used=0)), "ok", "no swap file is no full swap")

    @unittest.skipUnless(sys.platform == "darwin", "reads this Mac's kernel")
    def test_a_read_on_this_mac_gives_every_value(self):
        reading = pressure.read()
        self.assertEqual(set(reading), {"kernel", "swap_used", "swap_total", "compressor", "ram", "source"})
        self.assertIn(reading["kernel"], (1, 2, 4))
        self.assertLessEqual(reading["swap_used"], reading["swap_total"])
        self.assertLess(0, reading["compressor"])
        self.assertLess(reading["compressor"], reading["ram"])
        self.assertIn(pressure.level(reading), pressure.LEVELS)



class PressureFeed(unittest.TestCase):
    """ops guy's ~/.cache/virev/mac-pressure.json replaces the kernel's level and
    compressor size while it is fresh and parses; anything else falls back."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-feed-")
        self.path = os.path.join(self.dir, "mac-pressure.json")

    def write(self, text, age=0):
        with open(self.path, "w") as f:
            f.write(text)
        at = time.time() - age
        os.utime(self.path, (at, at))

    def test_a_fresh_feed_gives_the_level_the_compressor_the_swap_and_the_swapouts(self):
        self.write(json.dumps(FEED_1021), age=9)
        self.assertEqual(pressure.read_feed(self.path), {"kernel": 2, "compressor": int(15.9 * 2 ** 30), "swap_used": int(45.18 * 2 ** 30),
                                                          "swap_total": int(46.0 * 2 ** 30), "swapouts": 16191.0})
        self.write(json.dumps(dict(FEED_1021, pressure_level=4)))
        self.assertEqual(pressure.read_feed(self.path)["kernel"], 4)

    @unittest.skipUnless(sys.platform == "darwin", "reads this Mac's kernel")
    def test_a_fresh_feed_sets_the_level_and_marks_its_source(self):
        self.write(json.dumps(dict(FEED_1021, pressure_level=1, mem_gb=dict(FEED_1021["mem_gb"], compressed=0.5),
                                   swap_gb={"used": 1.0, "total": 4.0}, swapouts_per_s=0)))
        reading = pressure.read(self.path)
        self.assertEqual((reading["source"], reading["kernel"], reading["compressor"], reading["swapouts"]), ("feed", 1, 2 ** 29, 0))
        self.assertEqual(pressure.level(reading), "ok")
        self.write(json.dumps(FEED_1021))
        self.assertEqual(pressure.level(pressure.read(self.path)), "critical")

    def test_a_stale_feed_is_ignored(self):
        self.write(json.dumps(FEED_1021), age=31)
        self.assertIsNone(pressure.read_feed(self.path))
        if sys.platform == "darwin":
            self.assertEqual(pressure.read(self.path)["source"], "sysctl")

    def test_a_missing_or_malformed_feed_is_ignored(self):
        self.assertIsNone(pressure.read_feed(os.path.join(self.dir, "absent.json")))
        bad = [dict(FEED_1021, v=2), dict(FEED_1021, pressure_level="purple"), dict(FEED_1021, pressure_level=True),
               dict(FEED_1021, mem_gb={"compressed": "16"}), dict(FEED_1021, mem_gb={"compressed": -1}), dict(FEED_1021, swap_gb=None),
               dict(FEED_1021, swap_gb={"used": 1}), dict(FEED_1021, swapouts_per_s=None), {k: v for k, v in FEED_1021.items() if k != "mem_gb"}]
        for text in ["", "{", "[]", "null", '{"pressure_level": 2, "compressed_gb": 1}', b"\xff".decode("latin-1")] + [json.dumps(b) for b in bad]:
            self.write(text)
            self.assertIsNone(pressure.read_feed(self.path), text)
            if sys.platform == "darwin":
                self.assertEqual(pressure.read(self.path)["source"], "sysctl", text)


class Governor(unittest.TestCase):
    """Under memory pressure the queue admits fewer turns and holds the low ones."""
    CFG = dict(base.DEFAULTS, mac_working_max=30)
    SESSIONS = {"normal-job": {"priority": "normal"}, "high-chat": {"priority": "high"}, "labeled": {"priority": "normal", "priority_label": "high"}}

    def ask(self, t, session, now, read, **kw):
        return turns.ask(t, self.SESSIONS, ask_args(session, **kw), now, self.CFG, read=read)[1]

    def test_a_full_limit_holds_duties_and_normal_jobs_behind_the_rest_never_an_owner_turn(self):
        """A held turn takes a free slot under the lower limit only after every turn that is
        not held, one per tree each pass, so every chat's check-in still runs."""
        t, read = turns.empty(), Readings(WARN)
        fill(t, 16)
        turns.mark_owner(t, "owner-chat", 0, 1800)
        self.assertEqual(self.ask(t, "owner-chat", 1, read, tree="normal-job")["kind"], "owner", "16 of 16, and the owner runs")
        self.assertEqual(self.ask(t, "duty", 2, read, tree="duty:c1:checkin", klass="low")["state"], "queued")
        self.assertEqual(self.ask(t, "duty-2", 3, read, tree="duty:c1:checkin", klass="low")["state"], "queued")
        self.assertEqual(self.ask(t, "job", 4, read, tree="normal-job")["state"], "queued")
        self.assertEqual(self.ask(t, "kid", 5, read, tree="high-chat", parent="high-chat")["state"], "queued")
        self.assertEqual(turns.view(t, 5, self.CFG, self.SESSIONS)["pressure"]["held"], 3)
        for i in range(5):
            del t["working"][f"w{i}"]
        admitted = turns.step(t, self.SESSIONS, 6, self.CFG, read)[2]
        self.assertEqual([s for s, _ in admitted], ["kid", "job", "duty"], "the High chat's turn first, then one held turn per tree")
        self.assertEqual(sorted(t["queued"]), ["duty-2"], "a slot stays free for the next pass")
        self.assertEqual(turns.step(t, self.SESSIONS, 7, self.CFG, read)[2], [("duty-2", "slot")])

    def test_a_held_turn_waits_at_most_hold_max_s_then_queues_like_any_other(self):
        t, read = turns.empty(), Readings(THRASH)
        fill(t, 12)
        self.assertEqual(self.ask(t, "duty", 0, read, tree="duty:c1:checkin", klass="low")["state"], "queued")
        self.assertEqual(turns.view(t, turns.HOLD_MAX_S - 1, self.CFG, self.SESSIONS)["pressure"]["held"], 1)
        self.assertEqual(turns.view(t, turns.HOLD_MAX_S, self.CFG, self.SESSIONS)["pressure"]["held"], 0)
        self.assertEqual(self.ask(t, "kid", turns.HOLD_MAX_S, read, tree="high-chat", parent="high-chat", klass="high")["state"], "queued")
        del t["working"]["w0"]
        self.assertEqual(turns.step(t, self.SESSIONS, turns.HOLD_MAX_S + 1, self.CFG, read)[2], [("duty", "slot")],
                         "past its hold the duty has aged to high and waited longest")
        self.assertEqual(turns.HOLD_MAX_S, 141)
    def test_the_limit_drops_to_16_when_high_and_12_when_critical(self):
        t, read = turns.empty(), Readings(CALM)
        fill(t, 16, tree="high-chat")
        self.assertEqual(self.ask(t, "a", 0, read, tree="high-chat", klass="high")["state"], "admitted", "17 of 30")
        read.reading = THRASH
        self.assertEqual(self.ask(t, "b", 31, read, tree="high-chat", klass="high")["state"], "queued", "17 of 12")
        self.assertEqual((t["pressure"]["level"], t["pressure"]["limit"]), ("critical", 12))
        del t["working"]["w0"], t["working"]["w1"]
        read.reading = WARN
        self.assertEqual(turns.step(t, self.SESSIONS, 62, self.CFG, read)[2], [("b", "slot")], "16 of 16")
        self.assertEqual((t["pressure"]["level"], t["pressure"]["limit"]), ("high", 16))

    def test_a_held_child_takes_its_in_flight_parents_lent_slot_when_the_limit_is_full(self):
        """ops guy's review of db7b8bf: a normal job's parent that waits on its child in a cell
        would hold its slot for the whole pressure spell if the held child could not borrow."""
        t, read = turns.empty(), Readings(THRASH)
        fill(t, 11)
        t["working"]["parent"] = dict(entry(tree="normal-job"), kind="slot")
        kid = self.ask(t, "kid", 0, read, tree="normal-job", parent="parent")
        self.assertEqual((t["pressure"]["level"], kid["state"]), ("critical", "admitted"), "12 of 12 and no borrow yet")
        self.assertEqual(t["working"]["kid"]["kind"], "borrow", "12 of 12 in use, and the held child adds no slot")
        self.assertEqual(len(turns.in_slots(t["working"])), 12)
        self.assertEqual(self.ask(t, "kid2", 1, read, tree="normal-job", parent="parent")["state"], "queued", "a parent lends one slot")
        self.assertEqual(self.ask(t, "orphan", 2, read, tree="normal-job", parent="gone")["state"], "queued", "no parent in flight, no borrow")
        self.assertEqual(sorted(t["queued"]), ["kid2", "orphan"])

    def test_at_critical_borrows_put_at_most_pressure_borrows_turns_over_the_limit(self):
        """10-15 08:15Z: the governor read critical with 16 slots and 6 borrows in use, and
        kernel_task read 152.3%. At high the cap is the same 2 over high's limit."""
        t, read = turns.empty(), Readings(THRASH)
        for i in range(12):
            t["working"][f"p{i}"] = dict(entry(tree=f"T{i}"), kind="slot")
        states = [self.ask(t, f"kid{i}", i, read, tree=f"T{i}", parent=f"p{i}")["state"] for i in range(6)]
        self.assertEqual(states, ["admitted"] * turns.PRESSURE_BORROWS + ["queued"] * (6 - turns.PRESSURE_BORROWS))
        self.assertEqual(len(t["working"]), 12 + turns.PRESSURE_BORROWS)
        del t["working"]["kid0"]
        self.assertEqual(turns.step(t, self.SESSIONS, 7, self.CFG, read)[2], [("kid2", "borrow")], "an ended borrow passes its place on")
        read.reading = WARN
        self.assertEqual(turns.step(t, self.SESSIONS, 40, self.CFG, read)[2], [("kid3", "slot"), ("kid4", "slot"), ("kid5", "slot")],
                         "at high the limit climbs to 16 and the children take free slots")
        turns.mark_owner(t, "boss", 41, 1800)
        read.reading = THRASH
        self.assertEqual(self.ask(t, "boss", 80, read, tree="boss")["kind"], "owner", "an owner turn never waits")

    def test_a_level_change_is_recorded_with_its_reading_and_logged(self):
        t, read = turns.empty(), Readings(CALM)
        self.ask(t, "a", 0, read, tree="high-chat")
        self.assertIsNone(t["pressure"]["changed"])
        read.reading = WARN
        changed, gone, admitted, events = turns.step(t, self.SESSIONS, 31, self.CFG, read)
        record = {"from": "ok", "to": "high", "at": 31, "limit_from": 30, "limit_to": 16, "reading": WARN}
        self.assertEqual(t["pressure"]["changed"], record)
        self.assertEqual(events, [("pressure_level", record)])
        self.assertTrue(changed, "a fresh reading is saved")
        self.assertEqual(turns.step(t, self.SESSIONS, 62, self.CFG, read)[3], [], "the same level logs nothing")
        self.assertEqual((t["pressure"]["since"], t["pressure"]["changed"]["at"]), (31, 31))

    def test_one_read_serves_30_s_and_a_lost_record_is_read_again(self):
        t, read = turns.empty(), Readings(WARN)
        fill(t, 16)
        for now in range(0, 30, 3):
            self.ask(t, f"s{now}", now, read, tree="normal-job")
        self.assertEqual(read.calls, 1)
        del t["pressure"]
        self.assertEqual(self.ask(t, "after-restart", 31, read, tree="normal-job")["state"], "queued")
        self.assertEqual((read.calls, t["pressure"]["level"]), (2, "high"))
        self.assertEqual(turns.view(t, 31, self.CFG, self.SESSIONS)["pressure"]["held"], 11)
    def test_a_failed_read_and_the_off_switch_leave_the_limit(self):
        t = turns.empty()
        fill(t, 20, tree="high-chat")
        self.assertEqual(self.ask(t, "a", 0, Readings(None), tree="normal-job", klass="low")["state"], "admitted")
        off = dict(self.CFG, memory_governor_on=0)
        read = Readings(THRASH)
        self.assertEqual(turns.ask(t, self.SESSIONS, ask_args("b", tree="normal-job", klass="low"), 1, off, read=read)[1]["state"], "admitted")
        self.assertEqual((read.calls, t["pressure"]["level"], t["pressure"]["limit"]), (0, "ok", 30))

    def test_queue_json_carries_the_level_the_reading_the_limit_and_the_held_count(self):
        t, read = turns.empty(), Readings(WARN)
        fill(t, 16)
        self.ask(t, "duty", 0, read, tree="duty:x", klass="low")
        p = turns.view(t, 0, self.CFG, self.SESSIONS)["pressure"]
        self.assertEqual({k: p[k] for k in ("level", "on", "limit", "held", "reading")},
                         {"level": "high", "on": True, "limit": 16, "held": 1, "reading": WARN})
        self.assertEqual(set(p), {"level", "on", "at", "since", "reading", "limit", "changed", "held", "memory_trees"})
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-turns-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        self.set("mac_working_max", "2")
        self.set("memory_governor_on", "0")

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
        self.assertEqual((view["enabled"], view["mac_working_max"], view["tree_working_max"]), (True, 2, 8))
        self.assertEqual([w["session"] for w in view["working"]], ["a", "b"])
        self.assertEqual(set(view["working"][0]), {"session", "tree", "parent", "class", "kind", "since"})
        q = view["queued"][0]
        self.assertEqual(set(q), {"session", "tree", "parent", "class", "base_class", "position", "total", "since", "wait_s"})
        self.assertEqual((q["session"], q["class"], q["base_class"], q["position"], q["total"]), ("c", "low", "low", 1, 1))
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": True})
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": False}, "release is idempotent")
        self.assertEqual([w["session"] for w in self.queue()["working"]], ["b", "c"], "the release admitted c")

    def test_queue_json_reads_this_macs_pressure_when_the_governor_is_on(self):
        self.set("memory_governor_on", "1")
        p = self.queue()["pressure"]
        self.assertIn(p["level"], turns.pressure.LEVELS)
        self.assertEqual(p["limit"], 2 if p["level"] == "ok" else min(2, base.DEFAULTS["pressure_working_max"][p["level"]]))
        self.assertEqual(p["held"], 0)

    def test_set_records_who_and_when_in_config_and_the_log(self):
        before = round(time.time())
        self.run_cli("set", "mac_working_max", "30", "--by", "the Settings pane")
        record = self.queue()["mac_working_max_set"]
        self.assertEqual(record["by"], "the Settings pane")
        self.assertGreaterEqual(record["at"], before)
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            logged = [json.loads(line) for line in f if '"event": "set"' in line][-1]
        self.assertEqual({k: logged[k] for k in ("key", "value", "was", "by")},
                         {"key": "mac_working_max", "value": 30, "was": 2, "by": "the Settings pane"})
        self.env["RLM_SESSION_DIR"] = os.path.expanduser("~/.prime/agent/session-artifacts/01a-root/sub-x")
        self.set("mac_working_max", "16")
        self.assertEqual(self.queue()["mac_working_max_set"]["by"], "agent 01a-root/sub-x")

    def test_a_value_with_no_set_record_shows_the_file_time_and_the_default_shows_none(self):
        path = os.path.join(self.dir, "config.json")
        with open(path, "w") as f:
            json.dump({"agent_queue_on": 1, "mac_working_max": 30}, f)
        os.utime(path, (1791942343, 1791942343))
        self.assertEqual(self.queue()["mac_working_max_set"], {"by": None, "at": 1791942343})
        with open(path, "w") as f:
            json.dump({"agent_queue_on": 1}, f)
        self.assertIsNone(self.queue()["mac_working_max_set"])

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
        self.assertEqual({k: v for k, v in saved.items() if k != "set_by"}, {"mac_working_max": 2, "memory_governor_on": 0, "agent_queue_on": 0})
        for s in "abc":
            self.assertEqual(self.admit(s)["state"], "off")
        view = self.queue()
        self.assertEqual((view["enabled"], view["mac_working_max"], view["working"]), (False, 2, []))

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

class CriticalMinutes(unittest.TestCase):
    """The feed minutes the governor read critical from 10-14 20:31Z to 10-15 08:25Z, with the
    most slots, borrows and working turns pi-pool.log shows in each."""

    def test_no_minute_at_the_limit_plus_pressure_borrows_read_over_a_core(self):
        with open(os.path.join(os.path.dirname(__file__), "critical_minutes_1014_1015.json")) as f:
            rows = json.load(f)["minutes"]
        top = base.DEFAULTS["pressure_working_max"]["critical"] + turns.PRESSURE_BORROWS
        within = [r for r in rows if r["total"] <= top]
        hot = [r for r in rows if r["kernel_task_pct"] >= 100]
        self.assertEqual((len(rows), len(within), len(hot)), (101, 13, 22))
        self.assertEqual(max(r["kernel_task_pct"] for r in within), 84.8)
        self.assertTrue(all(r["total"] > top and r["slots"] >= 15 and r["borrows"] >= 2 for r in hot))
        self.assertIn({"at": "2026-10-15T08:15", "kernel_task_pct": 152.3, "slots": 16, "borrows": 6, "total": 22}, rows)



class UsableMinutes(unittest.TestCase):
    """The Mac usable watch minutes from 10-14 20:31Z to 10-15 08:51Z with pi-pool's level and
    working turns: at the limit plus PRESSURE_BORROWS for its level or under, no minute was unusable."""

    def test_no_minute_at_or_under_its_levels_top_was_unusable(self):
        with open(os.path.join(os.path.dirname(__file__), "usable_minutes_1014_1015.json")) as f:
            rows = json.load(f)["minutes"]
        cfg = dict(base.DEFAULTS, mac_working_max=30)
        top = {level: turns.working_limit(cfg, level) + (0 if level == "ok" else turns.PRESSURE_BORROWS) for level in ("ok", "high", "critical")}
        self.assertEqual((top["high"], top["critical"]), (18, 14))
        within = [r for r in rows if r["level"] != "ok" and r["working"] <= top[r["level"]]]
        over = [r for r in rows if r["level"] != "ok" and r["working"] > top[r["level"]]]
        self.assertEqual((len(rows), len(within), len(over)), (721, 124, 88))
        self.assertEqual([r for r in within if r["unusable"]], [])
        self.assertEqual(sum(r["unusable"] for r in over), 30)

class Replay1014Evening(unittest.TestCase):
    """The governor against the turns pi-pool logged on 10-14 from 21:07 to 22:48 KST, while
    the Mac read critical: under the old rule 21 low turns sat held, the oldest 2,541 s. At the
    critical limit of 12 the 90th percentile turn waits about 5 min, the cost of a usable Mac."""

    def test_held_turns_wait_about_hold_max_s_and_every_tree_with_one_gets_through(self):
        with open(os.path.join(os.path.dirname(__file__), "live_1014_2107_2248kst.json")) as f:
            arrivals = json.load(f)["turns"]
        cfg = dict(base.DEFAULTS, mac_working_max=30)
        limit = turns.working_limit(cfg, "critical")
        t, waits, keys, seen, i = turns.empty(), {}, {}, collections.Counter(), 0
        for now in range(max(a["t"] for a in arrivals) + 6000):
            while i < len(arrivals) and arrivals[i]["t"] <= now:
                a = arrivals[i]
                i += 1
                seen[a["session"]] += 1
                t["queued"][f"{a['session']}#{seen[a['session']]}"] = dict(entry(tree=a["tree"], parent=a["parent"], klass=a["class"], since=a["t"]),
                                                                           holdable=a["holdable"], dur=a["dur"], base=a["session"])
            for s, e in list(t["working"].items()):
                if now >= e["since"] + e["dur"]:
                    del t["working"][s]
                    keys.pop(e["base"], None)
            for e in t["queued"].values():
                e["parent"] = keys.get(e["parent"], e["parent"])
            hold = lambda e, now=now: e["holdable"] and now - e["since"] < turns.HOLD_MAX_S
            for s, _ in turns.admit_pass(t, now, limit, int(cfg["tree_working_max"]), int(cfg["queue_aging_s"]), 10 ** 9, hold):
                w = t["working"][s]
                waits[s] = (now - w["queued_since"], w["holdable"], w["tree"])
                keys[w["base"]] = s
            if i == len(arrivals) and not t["queued"]:
                break
        held = sorted(w for w, h, _ in waits.values() if h)
        everyone = sorted(w for w, _, _ in waits.values())
        p90 = lambda xs: xs[int(0.9 * (len(xs) - 1))]
        self.assertEqual((len(waits), len(t["queued"])), (len(arrivals), 0), "every turn ran")
        self.assertEqual(len(held), 113)
        p99 = lambda xs: xs[int(0.99 * (len(xs) - 1))]
        print(f"\n10-14 evening replay at {limit}: p90 wait held {p90(held)} s, all {p90(everyone)} s, p99 all {p99(everyone)} s", file=sys.stderr)
        self.assertLessEqual(p90(held), 260, "at 16 this was 150 s; 12 is what keeps critical minutes usable (UsableMinutes)")
        self.assertLessEqual(p90(everyone), 310, "at 16 this was 60 s")
        self.assertEqual({tree for _, h, tree in waits.values() if h}, {a["tree"] for a in arrivals if a["holdable"]})


class Replay1015Flap(unittest.TestCase):
    """The governor against the turns pi-pool logged on 10-15 from 08:57 to 09:27 KST, while its
    level changed 25 times. One ok read at 09:17:28 between two critical ones put the limit from
    16 to 30, 11 queued turns started in that second, and kernel_task read 146% of a core."""

    def replay(self):
        with open(os.path.join(os.path.dirname(__file__), "live_1015_0857_0926kst.json")) as f:
            fixture = json.load(f)
        arrivals, reads = fixture["turns"], fixture["reads"]
        cfg = dict(base.DEFAULTS, mac_working_max=30, lease_s=10 ** 9)
        reading = lambda now: [r for r in reads if r["t"] <= now][-1]["reading"]
        t, keys, seen, per_second, limits = turns.empty(), {}, collections.Counter(), collections.Counter(), {}
        first = reads[1]["t"] - turns.PRESSURE_TTL_SEC
        t["pressure"] = {"level": "high", "at": first, "since": first, "reading": reading(first), "limit": 16, "changed": None, "on": True}
        pending = sorted(arrivals, key=lambda a: (min(a["t"], a["admitted"]), a["session"]))
        for a in [a for a in pending if a["admitted"] < 0]:
            seen[a["session"]] += 1
            key = f"{a['session']}#{seen[a['session']]}"
            t["working"][key] = dict(entry(tree=a["tree"], parent=a["parent"], klass=a["class"], since=a["admitted"]),
                                     kind="slot", queued_since=a["t"], lease_until=10 ** 9, dur=a["dur"], base=a["session"])
            keys[a["session"]] = key
        pending, i = [a for a in pending if a["admitted"] >= 0], 0
        for now in range(0, 1800):
            while i < len(pending) and pending[i]["t"] <= now:
                a = pending[i]
                i += 1
                seen[a["session"]] += 1
                t["queued"][f"{a['session']}#{seen[a['session']]}"] = dict(entry(tree=a["tree"], parent=a["parent"], klass=a["class"], since=a["t"]),
                                                                           dur=a["dur"], base=a["session"])
            for s, e in list(t["working"].items()):
                if now >= e["since"] + e["dur"]:
                    del t["working"][s]
                    keys.pop(e["base"], None)
            for e in t["queued"].values():
                e["parent"] = keys.get(e["parent"], e["parent"])
            admitted = turns.step(t, {}, now, cfg, lambda now=now: reading(now))[2]
            for s, kind in admitted:
                keys[t["working"][s]["base"]] = s
            per_second[now] = sum(1 for s, kind in admitted if kind == "slot" and t["working"][s]["queued_since"] < now)
            limits[now] = t["pressure"]["limit"]
        return per_second, limits

    def test_one_ok_read_between_critical_ones_opens_4_slots_not_14(self):
        step = turns.LIMIT_STEP
        try:
            turns.LIMIT_STEP = 30
            old, old_limits = self.replay()
        finally:
            turns.LIMIT_STEP = step
        new, new_limits = self.replay()
        at_0917 = range(1228, 1260)
        self.assertGreaterEqual(max(old[s] for s in at_0917), 11, "the old rule starts the 09:17:28 burst again")
        self.assertEqual(max(old_limits[s] for s in at_0917), 30)
        self.assertLessEqual(max(new.values()), turns.LIMIT_STEP + 1, "the most queued turns any one second starts")
        self.assertEqual(max(new_limits[s] for s in at_0917), 12 + turns.LIMIT_STEP)
        print(f"\n10-15 flap replay: the most queued turns started in one second, old {max(old.values())}, new {max(new.values())}", file=sys.stderr)

    def test_a_calm_mac_reaches_the_owners_30_in_five_reads(self):
        t, read = turns.empty(), Readings(THRASH)
        cfg = dict(base.DEFAULTS, mac_working_max=30)
        turns.step(t, {}, 0, cfg, read)
        read.reading = CALM
        climb = [(turns.step(t, {}, now, cfg, read), t["pressure"]["limit"])[1] for now in range(30, 180, 30)]
        self.assertEqual(climb, [16, 20, 24, 28, 30])
        self.assertEqual(turns.step(t, {}, 180, cfg, read)[3], [], "a limit at the ceiling logs nothing")
        read.reading = THRASH
        turns.step(t, {}, 210, cfg, read)
        self.assertEqual(t["pressure"]["limit"], 12, "a pressured read drops the limit at once")


if __name__ == "__main__":
    unittest.main()
