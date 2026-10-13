"""The Mac-wide turn queue (pool/turns.py): admit, release, owner-turn, queue --json,
borrowing, class order, aging, the stale sweep, and a replay of the 10-14 02 KST burst.
"""
import collections, heapq, json, os, subprocess, sys, tempfile, time, unittest

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
    CFG = dict(base.DEFAULTS, mac_working_max=1)

    def test_a_3000_s_run_that_renews_keeps_its_slot(self):
        """A run whose one tool call lasts 3,000 s, longer than lease_s, with the
        extension renewing every 300 s; another session waits the whole time."""
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

    def test_without_renew_a_lapsed_session_queues_like_a_new_run(self):
        t = turns.empty()
        turns.ask(t, {}, ask_args("other", tree="o"), 0, self.CFG)
        self.assertEqual(turns.ask(t, {}, ask_args("next"), 1, self.CFG)[1]["state"], "queued")


class Class(unittest.TestCase):
    def cls(self, sessions, **kw):
        t = turns.empty()
        fill(t, 16)
        turns.ask(t, sessions, ask_args("s", tree="T", **kw), 0, base.DEFAULTS)
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


class Cli(unittest.TestCase):
    """The commands through bin/pi-pool, each in its own pool folder."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pi-pool-turns-")
        self.env = dict(os.environ, PI_POOL_DIR=self.dir)
        for k in (base.SESSION_ENV, base.JOURNAL_ENV):
            self.env.pop(k, None)
        self.set("mac_working_max", "2")

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

    def test_an_owner_turn_admits_a_queued_session_at_once(self):
        self.admit("a", "--tree", "A")
        self.admit("b", "--tree", "B")
        self.admit("chat", "--tree", "C")
        self.assertEqual(json.loads(self.run_cli("owner-turn", "chat").stdout)["state"], "admitted")
        self.assertEqual({w["session"]: w["kind"] for w in self.queue()["working"]}["chat"], "owner")

    def test_off_admits_everything_records_nothing_and_keeps_the_limit(self):
        self.set("agent_queue_on", "0")
        self.assertEqual(read(os.path.join(self.dir, "config.json")), {"mac_working_max": 2, "agent_queue_on": 0})
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
        self.assertEqual((peak_working, peak_borrows), (20, 9), "turns over 16 are only children on a lent slot")
        waits.sort()
        print(f"\nburst replay: {admitted} turns, peak {peak_working} working, {peak_borrows} borrows at once, "
              f"median wait {waits[len(waits) // 2]:.0f} s, p90 {waits[int(len(waits) * 0.9)]:.0f} s", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
