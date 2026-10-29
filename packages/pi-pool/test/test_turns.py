"""The turn queue of this machine (pool/turns.py): admit, release, owner-turn, queue --json,
first-asked first-in order, the owner's turns, the stale sweep, the lease, the move out of
state.json, and a replay of the 10-14 02 KST burst.
"""
import calendar, collections, heapq, json, os, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module
from test_core import SOURCE
from unittest import mock

from vend.pool import base, sched, turns


def setUpModule():
    isolate_test_module()


ME = os.getpid()
DEAD = 2 ** 22 + 12345  # above macOS's pid_max of 99,998, so never a live process


def entry(tree="t", since=0.0, pid=ME, waiter=None):
    return {"tree": tree, "since": since, "pid": pid, "waiter": waiter}


def queue_up(t, now, mac=16, tree=8, **entries):
    for session, e in entries.items():
        t["queued"][session] = e
    return turns.admit_pass(t, now, mac, tree, 1800)


def read(path):
    with open(path) as f:
        return json.load(f)


def fill(t, n, tree="busy"):
    for i in range(n):
        t["working"][f"w{i}"] = dict(entry(tree=f"{tree}{i}"), kind="slot")


class Order(unittest.TestCase):
    def test_free_slots_go_to_the_longest_wait(self):
        t = turns.empty()
        fill(t, 3)
        queue_up(t, 10, mac=3, late=entry(since=9, tree="c"), mid=entry(since=5, tree="a"), first=entry(since=1, tree="b"))
        self.assertEqual(turns.order(t), ["first", "mid", "late"])
        del t["working"]["w0"], t["working"]["w1"]
        self.assertEqual(turns.admit_pass(t, 10, 3, 8, 1800), [("first", "slot"), ("mid", "slot")])

    def test_the_tree_limit_skips_a_full_tree_and_admits_the_next(self):
        t = turns.empty()
        for i in range(2):
            t["working"][f"a{i}"] = dict(entry(tree="A"), kind="slot")
        got = queue_up(t, 5, mac=16, tree=2, a2=entry(tree="A", since=1), b0=entry(tree="B", since=2))
        self.assertEqual(got, [("b0", "slot")])
        self.assertIn("a2", t["queued"])

    def test_every_working_turn_counts_toward_the_limit(self):
        t = turns.empty()
        fill(t, 15)
        t["working"]["boss"] = dict(entry(tree="owner"), kind="owner")
        self.assertEqual(queue_up(t, 1, job=entry(tree="j")), [], "an owner turn fills the 16th slot")
        del t["working"]["w0"]
        self.assertEqual(turns.admit_pass(t, 2, 16, 8, 1800), [("job", "slot")])

    def test_a_lead_run_that_asked_last_takes_the_next_free_slot(self):
        """10-21: a chat head's run waited behind 100 to 180 job runs, p90 426 s (~/work/pool-smooth/BASELINE.md)."""
        t = turns.empty()
        fill(t, 3)
        jobs = {f"job{i}": entry(since=i, tree=f"j{i}") for i in range(5)}
        queue_up(t, 10, mac=3, head=entry(since=9, tree="H"), **jobs)
        t["lead"] = ["head"]
        self.assertEqual(turns.order(t)[0], "head")
        self.assertEqual(turns.reply(t, "head")["position"], 1)
        del t["working"]["w0"]
        self.assertEqual(turns.admit_pass(t, 10, 3, 8, 1800), [("head", "slot")])

    def test_two_lead_runs_keep_the_order_they_asked_in(self):
        t = turns.empty()
        fill(t, 3)
        queue_up(t, 10, mac=3, job=entry(since=1, tree="j"), late=entry(since=8, tree="L"), early=entry(since=5, tree="E"))
        t["lead"] = ["late", "early"]
        self.assertEqual(turns.order(t), ["early", "late", "job"])

    def test_a_lead_run_still_waits_for_its_tree_limit(self):
        t = turns.empty()
        t["working"]["h0"] = dict(entry(tree="H"), kind="slot")
        t["lead"] = ["head"]
        self.assertEqual(queue_up(t, 5, mac=16, tree=1, head=entry(tree="H", since=1), job=entry(tree="J", since=2)), [("job", "slot")])

    def test_a_child_waits_in_line_behind_older_asks(self):
        """No run borrows a slot: a child of a working parent queues like any run."""
        t = turns.empty()
        fill(t, 15)
        t["working"]["parent"] = dict(entry(tree="P"), kind="slot")
        self.assertEqual(queue_up(t, 1, kid=entry(tree="P", since=1)), [])


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


def ask_args(session, tree="t", renew=False):
    return {"session": session, "tree": tree, "pid": ME, "wait": False, "renew": renew}


class Lease(unittest.TestCase):
    CFG = dict(base.DEFAULTS, working_max=1)

    def test_a_run_that_calls_the_model_every_300_s_keeps_its_slot(self):
        """A 3,000 s run, longer than lease_s, whose model calls renew every 300 s;
        another session waits the whole time."""
        t = turns.empty()
        self.assertEqual(turns.ask(t, ask_args("long"), 0, self.CFG)[1]["state"], "admitted")
        self.assertEqual(turns.ask(t, ask_args("other", tree="o"), 1, self.CFG)[1]["state"], "queued")
        for now in range(300, 3001, 300):
            turns.sweep(t, now)
            self.assertEqual(list(t["working"]), ["long"], now)
            self.assertEqual(turns.ask(t, ask_args("long", renew=True), now, self.CFG)[1]["kind"], "slot")
        self.assertEqual(list(t["queued"]), ["other"])

    def test_a_renewal_after_a_lapse_runs_at_once_and_never_queues(self):
        t = turns.empty()
        turns.ask(t, ask_args("asleep"), 0, self.CFG)
        later = base.DEFAULTS["lease_s"] + 60
        turns.sweep(t, later)
        self.assertEqual(turns.ask(t, ask_args("other", tree="o"), later, self.CFG)[1]["state"], "admitted")
        changed, answer, events = turns.ask(t, ask_args("asleep", renew=True), later + 1, self.CFG)
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
        turns.ask(t, ask_args("stuck"), 0, self.CFG)
        self.assertEqual(turns.ask(t, ask_args("other", tree="o"), 1, self.CFG)[1]["state"], "queued")
        lease = base.DEFAULTS["lease_s"]
        changed, answer, events = turns.ask(t, ask_args("third", tree="x"), lease + 1, self.CFG)
        self.assertIn(("turn_swept", {"session": "stuck", "part": "working", "why": "lease ran out"}), events)
        self.assertEqual(list(t["working"]), ["other"])
        self.assertEqual(turns.ask(t, ask_args("stuck", renew=True), 2887, self.CFG)[1]["state"], "admitted")

    def test_without_renew_a_lapsed_session_queues_like_a_new_run(self):
        t = turns.empty()
        turns.ask(t, ask_args("other", tree="o"), 0, self.CFG)
        self.assertEqual(turns.ask(t, ask_args("next"), 1, self.CFG)[1]["state"], "queued")


class AccountWaitPlace(unittest.TestCase):
    """10-22: a d7 check-in run held from 06:24Z to 08:12Z came back from each account wait
    104th, 147th and 179th in line, and 23 trees whose claude8 cells came at 11:30Z then queued
    about 90 min with working_max at 6 (~/work/pool-smooth/reask_replay.py)."""
    CFG = dict(base.DEFAULTS, working_max=1)

    def let_go(self, t, slot_at):
        turns.ask(t, ask_args("d7", tree="D"), 0, self.CFG)
        turns.ask(t, ask_args("job1", tree="j1"), 10, self.CFG)
        turns.leave(t, "job1", 11, self.CFG)
        turns.ask(t, ask_args("job1", tree="j1"), 12, self.CFG)
        changed, answer, events = turns.leave(t, "d7", 20, self.CFG, slot_of=lambda tree: slot_at if tree == "D" else None)
        turns.ask(t, ask_args("job2", tree="j2"), 30, self.CFG)
        turns.leave(t, "job1", 40, self.CFG, slot_of=lambda tree: None)
        return events

    def test_a_run_back_from_an_account_wait_keeps_its_place(self):
        t = turns.empty()
        events = self.let_go(t, 1000)
        self.assertTrue(events[0][1]["account_wait"])
        changed, answer, events = turns.ask(t, ask_args("d7", tree="D"), 1000, self.CFG)
        self.assertEqual(turns.order(t), ["d7"], "job2 took the free slot at 40")
        t["working"].clear()
        turns.ask(t, ask_args("job3", tree="j3"), 1001, self.CFG)
        self.assertEqual(turns.order(t), ["job3"], "d7 started first")
        self.assertEqual(turns.reply(t, "d7")["state"], "admitted")

    def test_the_kept_place_goes_ahead_of_later_asks_and_its_wait_counts_from_its_ask(self):
        t = turns.empty()
        turns.ask(t, ask_args("d7", tree="D"), 0, self.CFG)
        turns.leave(t, "d7", 5, self.CFG, slot_of=lambda tree: 900)
        turns.ask(t, ask_args("busy", tree="b"), 6, self.CFG)
        turns.ask(t, ask_args("job", tree="j"), 100, self.CFG)
        changed, answer, events = turns.ask(t, ask_args("d7", tree="D"), 900, self.CFG)
        self.assertEqual((answer["position"], answer["total"]), (1, 2))
        self.assertEqual([f.get("kept_since") for e, f in events if e == "turn_queued"], [0])
        changed, answer, events = turns.leave(t, "busy", 960, self.CFG, slot_of=lambda tree: None)
        self.assertEqual([f for e, f in events if e == "turn_admitted"], [{"session": "d7", "tree": "D", "kind": "slot", "waited_s": 60.0}])
        self.assertEqual(turns.view(t, 960, self.CFG)["queued"][0]["wait_s"], 860)
        changed, answer, events = turns.leave(t, "d7", 970, self.CFG, slot_of=lambda tree: 2000)
        self.assertEqual(t["kept"]["d7"], {"since": 0, "slot_at": 2000, "tree": "D"}, "a second wait keeps the first place")

    def test_a_run_released_with_no_account_wait_asks_at_the_back(self):
        t = turns.empty()
        turns.ask(t, ask_args("done", tree="D"), 0, self.CFG)
        turns.leave(t, "done", 5, self.CFG, slot_of=lambda tree: None)
        turns.ask(t, ask_args("busy", tree="b"), 6, self.CFG)
        turns.ask(t, ask_args("job", tree="j"), 100, self.CFG)
        turns.ask(t, ask_args("done", tree="D"), 200, self.CFG)
        self.assertEqual(turns.order(t), ["job", "done"])

    def test_the_place_lasts_until_place_keep_sec_after_the_slot(self):
        t = turns.empty()
        t["kept"] = {"old": {"since": 0, "slot_at": 100}, "new": {"since": 0, "slot_at": 200}}
        turns.sweep(t, 150 + sched.PLACE_KEEP_SEC)
        self.assertEqual(list(t["kept"]), ["new"])

    def test_an_owner_turn_drops_the_kept_place(self):
        t = turns.empty()
        t["kept"]["chat"] = {"since": 0, "slot_at": 100}
        turns.mark_owner(t, "chat", 50, 1800)
        turns.ask(t, ask_args("chat"), 51, self.CFG)
        self.assertEqual(t["kept"], {})

    def test_the_tree_waits_while_state_json_has_its_wait(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(base, "STATE", os.path.join(d, "state.json")):
            self.assertIsNone(turns.waiting_slot("D"))
            base.save_json(base.STATE, {"sessions": {"D": {"wait": {"anthropic": {"account": "a", "slot_at": 500.0, "since": 1}, "codex": {"slot_at": 300, "since": 2}}},
                                                     "E": {"vends": {}}}})
            self.assertEqual((turns.waiting_slot("D"), turns.waiting_slot("E")), (500.0, None))


class QueuedInputPlace(unittest.TestCase):
    """10-22: the metal box owner 01a11d24 got 3 runs from 09:57Z to 13:34Z, each after a wait of 2,802 s to 5,799 s
    at the back of the line, and each held its slot for under 70 s, because a steer ends the running run after its
    model step and the session's next run asked again as a new run."""
    CFG = dict(base.DEFAULTS, working_max=1)
    OWNER = "01a11d24-ac9b-757d-ac51-9b2b7598782f"

    def test_a_run_released_with_queued_input_keeps_its_place_for_the_next_run(self):
        t = turns.empty()
        turns.ask(t, ask_args(self.OWNER, tree=self.OWNER), 0, self.CFG)
        turns.ask(t, ask_args("job1", tree="j1"), 10, self.CFG)
        changed, answer, events = turns.leave(t, self.OWNER, 19, self.CFG, slot_of=lambda tree: None, queued_input=True)
        self.assertEqual(events[0], ("turn_released", {"session": self.OWNER, "kind": "slot", "held_s": 19.0, "queued_input": True}))
        self.assertEqual([f["session"] for e, f in events if e == "turn_admitted"], ["job1"], "the freed slot goes to the head of the line")
        turns.ask(t, ask_args("job2", tree="j2"), 19.5, self.CFG)
        changed, answer, events = turns.ask(t, ask_args(self.OWNER, tree=self.OWNER), 20, self.CFG)
        self.assertEqual((answer["position"], answer["total"]), (1, 2))
        self.assertEqual(turns.order(t), [self.OWNER, "job2"])
        changed, answer, events = turns.leave(t, "job1", 80, self.CFG, slot_of=lambda tree: None)
        self.assertEqual([f for e, f in events if e == "turn_admitted"], [{"session": self.OWNER, "tree": self.OWNER, "kind": "slot", "waited_s": 60.0}])

    def test_a_chain_of_cut_runs_keeps_the_first_place(self):
        t = turns.empty()
        turns.ask(t, ask_args("first", tree="F"), 0, self.CFG)
        turns.leave(t, "first", 1, self.CFG, slot_of=lambda tree: None, queued_input=True)
        turns.ask(t, ask_args("first", tree="F"), 2, self.CFG)
        turns.leave(t, "first", 3, self.CFG, slot_of=lambda tree: None, queued_input=True)
        self.assertEqual(t["kept"]["first"], {"since": 0, "slot_at": 3, "tree": "F"})

    def test_a_run_released_with_nothing_queued_asks_at_the_back(self):
        t = turns.empty()
        turns.ask(t, ask_args("done", tree="D"), 0, self.CFG)
        turns.ask(t, ask_args("job", tree="j"), 1, self.CFG)
        changed, answer, events = turns.leave(t, "done", 5, self.CFG, slot_of=lambda tree: None)
        self.assertNotIn("queued_input", events[0][1])
        turns.ask(t, ask_args("late", tree="l"), 6, self.CFG)
        turns.ask(t, ask_args("done", tree="D"), 5 + turns.REASK_SEC + 0.5, self.CFG)
        self.assertEqual(turns.order(t), ["late", "done"])

    def test_a_run_whose_session_asks_again_at_once_keeps_its_place_with_no_flag(self):
        """10-27: the release owner 01a10810 ran on an extension loaded before --queued-input. Its runs released at 01:22:57Z,
        01:56:41Z and 02:27:49Z, each asked again within a second at the back of 67 to 98 queued runs, and the next ones
        waited 1,827 s, 1,514 s and 1,541 s."""
        t = turns.empty()
        owner = "01a10810-34b5-710f-88fe-3d369f89a8c9"
        turns.ask(t, ask_args(owner, tree=owner), 0, self.CFG)
        turns.ask(t, ask_args("job", tree="j"), 1, self.CFG)
        changed, answer, events = turns.leave(t, owner, 184.1, self.CFG, slot_of=lambda tree: None)
        self.assertEqual([f["session"] for e, f in events if e == "turn_admitted"], ["job"])
        turns.ask(t, ask_args("late", tree="l"), 184.5, self.CFG)
        changed, answer, events = turns.ask(t, ask_args(owner, tree=owner), 185.1, self.CFG)
        self.assertEqual(turns.order(t), [owner, "late"])
        self.assertEqual([f.get("kept_since") for e, f in events if e == "turn_queued"], [0])

    def test_queued_input_on_a_run_that_only_queued_keeps_nothing(self):
        t = turns.empty()
        fill(t, 1)
        turns.ask(t, ask_args("waiting", tree="W"), 0, self.CFG)
        turns.leave(t, "waiting", 5, self.CFG, slot_of=lambda tree: None, queued_input=True)
        self.assertEqual(t["kept"], {})


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
        self.assertEqual(turns.ask(t, ask_args(chat, tree=chat), kst("10:09:15"), self.CFG)[1]["state"], "queued")
        answer, events = turns.mark_owner(t, chat, kst("10:21:07"), 1800)
        self.assertEqual(answer["state"], "marked")
        self.assertEqual(events[-1], ("turn_admitted", {"session": chat, "tree": chat, "kind": "ahead", "waited_s": 712.0}))
        del t["working"][chat]
        changed, answer, events = turns.ask(t, ask_args(chat, tree=chat), kst("10:21:16"), self.CFG)
        self.assertEqual(answer["kind"], "owner")
        self.assertEqual([f for e, f in events if e == "turn_admitted"], [{"session": chat, "tree": chat, "kind": "owner", "waited_s": 0.0}])
        self.assertEqual(t["owner"], {}, "the owner's run took the mark")

    def test_launch_main_bro_0935_a_job_notice_is_no_owner_turn(self):
        """01a11bd7: a run queued at 09:31:11, and a [job] notice at 09:35:44 made the
        input hook call owner-turn, so the log showed an owner admit that waited
        273.2 s. Without a mark the notice's run keeps its place in the queue."""
        t, chat = self.full(), "01a11bd7-072f-7591-ad1d-f123c276cde5"
        turns.ask(t, ask_args(chat, tree=chat), kst("09:31:11"), self.CFG)
        changed, answer, events = turns.ask(t, ask_args(chat, tree=chat), kst("09:35:44"), self.CFG)
        self.assertEqual((answer["state"], [e for e, _ in events if e == "turn_admitted"]), ("queued", []))
        del t["working"]["w0"]
        self.assertEqual(turns.admit_pass(t, kst("09:35:50"), 16, 8, 1800), [(chat, "slot")])

    def test_a_mark_on_a_working_session_waits_for_its_next_run(self):
        """The owner's prompt to a session in flight starts the next run: 107 of 107
        owner prompts on 10-14 08:06-11:02 KST did."""
        t = turns.empty()
        turns.ask(t, ask_args("chat"), 0, self.CFG)
        turns.mark_owner(t, "chat", 5, 1800)
        self.assertEqual(t["working"]["chat"]["kind"], "slot")
        del t["working"]["chat"]
        self.assertEqual(turns.ask(t, ask_args("chat"), 40, self.CFG)[1]["kind"], "owner")
        self.assertEqual(turns.ask(t, ask_args("wake", tree="w"), 41, self.CFG)[1]["kind"], "slot")


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
        self.assertEqual(self.admit("a", "--tree", "A"), {"state": "admitted", "kind": "slot", "position": None, "total": None})
        self.admit("b", "--tree", "B", "--parent", "a", "--class", "high")
        self.assertEqual(self.admit("c", "--tree", "C"), {"state": "queued", "kind": None, "position": 1, "total": 1})
        self.assertEqual(self.admit("c", "--tree", "C")["position"], 1, "asking again keeps the place")
        view = self.queue()
        self.assertEqual((view["enabled"], view["working_max"], view["tree_working_max"]), (True, 2, 8))
        self.assertEqual([w["session"] for w in view["working"]], ["a", "b"])
        self.assertEqual(set(view["working"][0]), {"session", "tree", "kind", "since"})
        q = view["queued"][0]
        self.assertEqual(set(q), {"session", "tree", "position", "total", "since", "wait_s", "lead"})
        self.assertEqual((q["session"], q["position"], q["total"]), ("c", 1, 1))
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": True})
        self.assertEqual(json.loads(self.run_cli("release", "a").stdout), {"released": False}, "release is idempotent")
        self.assertEqual([w["session"] for w in self.queue()["working"]], ["b", "c"], "the release admitted c")

    def test_release_with_queued_input_keeps_the_place_and_logs_it(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        self.admit("c", "--tree", "C")
        self.assertEqual(json.loads(self.run_cli("release", "a", "--queued-input").stdout), {"released": True})
        self.admit("d", "--tree", "D")
        self.assertEqual(self.admit("a", "--tree", "A")["position"], 1, "a asks ahead of d, which asked first")
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            released = [json.loads(line) for line in f if '"turn_released"' in line]
        self.assertEqual([(e["session"], e.get("queued_input")) for e in released], [("a", True)])
        self.assertNotEqual(self.run_cli("release", "a", "--keep", check=False).returncode, 0, "an unknown flag is refused")

    def test_log_lines_carry_utc_in_a_process_that_runs_on_kst(self):
        """Until 10-27 `ts` was the writer's local time, and on us-metal02 the KST writers' lines read 9 h ahead of the rest."""
        self.env["TZ"] = "Asia/Seoul"
        self.admit("a", "--tree", "A")
        self.run_cli("release", "a")
        with open(os.path.join(self.dir, "pi-pool.log")) as f:
            stamps = [json.loads(line)["ts"] for line in f]
        self.assertTrue(stamps)
        for ts in stamps:
            self.assertLess(abs(calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%S")) - time.time()), 120, ts)

    def test_lead_replaces_the_list_and_the_same_list_writes_nothing(self):
        for s in "ab":
            self.admit(s, "--tree", s.upper())
        for s in "cde":
            self.admit(s, "--tree", s.upper())
        self.assertEqual(json.loads(self.run_cli("lead", "e", "d", "e").stdout), {"lead": ["d", "e"]})
        view = self.queue()
        self.assertEqual(view["lead"], ["d", "e"])
        self.assertEqual([(q["session"], q["lead"]) for q in view["queued"]], [("d", True), ("e", True), ("c", False)])
        path = os.path.join(self.dir, "turns.json")
        before = os.stat(path).st_mtime_ns
        self.assertEqual(json.loads(self.run_cli("lead", "d", "e").stdout), {"lead": ["d", "e"]})
        self.assertEqual(os.stat(path).st_mtime_ns, before, "the same list again leaves turns.json alone")
        self.run_cli("lead", "c")
        self.assertEqual(self.queue()["lead"], ["c"], "a new list replaces the old one")
        self.run_cli("release", "a")
        self.assertEqual({w["session"] for w in self.queue()["working"]}, {"b", "c"})
        self.run_cli("lead")
        self.assertEqual((self.queue()["lead"], [q["session"] for q in self.queue()["queued"]]), ([], ["d", "e"]))

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

    def test_owner_turn_does_nothing_while_the_queue_is_off(self):
        """10-19: the box wrote 3,956 owner marks with its queue off, each under the pool flock."""
        self.set("agent_queue_on", "0")
        self.assertEqual(json.loads(self.run_cli("owner-turn", "boss").stdout), {"session": "boss", "state": "off"})
        self.assertFalse(os.path.exists(os.path.join(self.dir, "turns.json")))

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
        first = read(os.path.join(self.dir, "turns.json"))["working"]["a"]["lease_until"]
        time.sleep(0.05)
        self.assertEqual(self.admit("a")["kind"], "slot")
        again = read(os.path.join(self.dir, "turns.json"))["working"]["a"]["lease_until"]
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
    and runs its recorded length once admitted. Nobody is the owner."""

    def test_the_burst_never_runs_more_than_16_and_every_turn_runs(self):
        with open(os.path.join(os.path.dirname(__file__), "burst_1014_02kst.json")) as f:
            fixture = json.load(f)["turns"]
        mac, tree_max = 16, 8
        by_session = collections.defaultdict(collections.deque)
        for i, turn in enumerate(sorted(fixture, key=lambda x: x["start"])):
            by_session[turn["session"]].append(dict(turn, id=i))
        events, t = [], turns.empty()
        for session, queue in by_session.items():
            first = queue[0]
            heapq.heappush(events, (first["start"], 1, first["id"], session))
        length = {}
        peak = admitted = 0
        waits = []
        while events:
            now, arriving, _, session = heapq.heappop(events)
            if arriving:
                turn = by_session[session][0]
                length[session] = turn["secs"]
                t["queued"][session] = entry(tree=turn["tree"], since=now)
            else:
                del t["working"][session]
                by_session[session].popleft()
                if by_session[session]:
                    nxt = by_session[session][0]
                    heapq.heappush(events, (max(now, nxt["start"]), 1, nxt["id"], session))
            for s, kind in turns.admit_pass(t, now, mac, tree_max, 10 ** 9):
                admitted += 1
                waits.append(now - t["working"][s]["queued_since"])
                heapq.heappush(events, (now + length[s], 0, 0, s))
            self.assertLessEqual(len(t["working"]), 16)
            peak = max(peak, len(t["working"]))
        self.assertEqual(admitted, len(fixture), "every turn ran")
        self.assertEqual(peak, 16)
        waits.sort()
        print(f"\nburst replay: {admitted} turns, median wait {waits[len(waits) // 2]:.0f} s, p90 {waits[int(len(waits) * 0.9)]:.0f} s", file=sys.stderr)


class Limit(unittest.TestCase):
    """The working limit is working_max, the number the owner set, whatever the machine's memory reads (owner, c88 on 10-16)."""

    def test_the_limit_is_the_set_number(self):
        t = turns.empty()
        cfg = dict(base.DEFAULTS, working_max=30, tree_working_max=30)
        for i in range(40):
            t["queued"][f"q{i}"] = entry(tree=f"t{i}", since=float(i))
        changed, events = turns.step(t, 100, cfg)
        self.assertTrue(changed)
        self.assertEqual((len(events), len(t["working"]), len(t["queued"])), (30, 30, 10))
        view = turns.view(t, 100, cfg)
        self.assertNotIn("pressure", view)
        self.assertEqual(view["working_max"], 30)


class Move(unittest.TestCase):
    """10-20: the queue left state.json's `turns` key for turns.json. Live runs keep their place, a run on a lent
    slot or a prod turn keeps working on a slot of its own, and state.json loses the key and keeps the rest."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-move-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        now = time.time()
        old = {"working": {"w": {"tree": "W", "parent": None, "class": "high", "kind": "slot", "since": now - 60, "queued_since": now - 70,
                                 "pid": ME, "lease_until": now + 600},
                           "kid": {"tree": "W", "parent": "w", "class": "normal", "kind": "borrow", "lender": "w", "since": now - 5,
                                   "pid": ME, "lease_until": now + 600}},
               "queued": {"q": {"tree": "Q", "parent": None, "class": "low", "since": now - 30, "pid": ME, "line": now - 900}},
               "owner": {"boss": now}, "recent": {}, "pressure": {"held": 11}, "prod": {"trees": {}, "sessions": {}}}
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump({"version": 2, "providers": {}, "sessions": {"W": {"priority": "high"}}, "turns": old}, f)
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump({"working_max": 2}, f)

    def cli(self, *args):
        return subprocess.run(["/usr/bin/python3", "-B", os.path.join(SOURCE, "bin", "pi-pool"), *args],
                              env=self.env, capture_output=True, text=True, timeout=30, check=True).stdout

    def test_the_first_admit_carries_live_runs_over_and_a_renew_takes_its_slot_back(self):
        self.assertEqual([q["session"] for q in json.loads(self.cli("queue", "--json"))["queued"]], ["q"], "the queue reads state.json until the move")
        self.cli("admit", "w", "--renew", "--pid", str(ME))
        moved = read(os.path.join(self.dir, "turns.json"))
        self.assertEqual({s: e["kind"] for s, e in moved["working"].items()}, {"w": "slot", "kid": "slot"})
        self.assertEqual((list(moved["queued"]), list(moved["owner"])), (["q"], ["boss"]))
        state = read(os.path.join(self.dir, "state.json"))
        self.assertNotIn("turns", state)
        self.assertEqual(state["sessions"], {"W": {"priority": "high"}})
        self.cli("release", "w")
        self.cli("admit", "w", "--renew", "--pid", str(ME))
        self.assertIn("w", read(os.path.join(self.dir, "turns.json"))["working"], "a run in flight takes a slot back with --renew")


if __name__ == "__main__":
    unittest.main()
