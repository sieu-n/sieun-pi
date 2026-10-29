"""The admission scheduler (sched.decide, rules R1-R7 in pool/sched.py and the README).
Each test names the rule it guards; it fails when that rule is taken out."""
import collections, contextlib, dataclasses, io, json, math, os, tempfile, time, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import CFG, KEY, NOW, account, vend, vend_record
from vend.pool import base, limit_resets, registry, sched, status_view, vending
from vend.pool import limited as limited_report
from vend.pool import turns as turns_mod


def setUpModule():
    isolate_test_module()


P = "anthropic"
FIVE, WEEK = 18000, 604800


def window(pct, secs, reset_in, now=NOW):
    return {"usedPercentage": pct, "windowSeconds": secs, "resetsAt": (now + reset_in) * 1000,
            "sampledAt": now * 1000}


def acct(id, five=0, five_reset_in=4 * 3600, week=10, week_reset_in=3 * 86400, tier="max 20x", limited_until=0):
    return dataclasses.replace(account(id, f"{id}@x", session_pct=five, weekly_pct=week), tier=tier,
                               windows=(window(five, FIVE, five_reset_in), window(week, WEEK, week_reset_in)),
                               limited_until=limited_until)


def empty_state():
    return {"version": 2, "providers": {p: registry.empty_provider_state() for p in base.PROVIDERS}, "sessions": {}}


def tree_key(name):
    return registry.SessionKey(name, name, None)


def put(state, key, on=None, at=NOW - 60, priority=None, moves=()):
    rec = state["sessions"].setdefault(key.key, {"uuid": key.uuid, "active_id": key.active_id, "pins": {},
                                                 "vends": {}, "last_seen": at})
    if on:
        rec["vends"][P] = dict(vend_record(on, at=at), **{"from": at})
    if priority:
        rec["priority"] = priority
    if moves:
        rec["moves"] = {P: list(moves)}
    return key


def request(state, key, accounts, now, cfg=CFG):
    """One hook call: decide, write the admission or wait, record the vend."""
    vending.HookWriter(state).prune(cfg, now)
    d, tree, _ = vending.schedule(state, key, P, accounts, cfg, now)
    if isinstance(d, (sched.Admit, sched.Stay)):
        vending.HookWriter(state).record_vend(key, P, d.account, "store", d.reason, d.shadowed, now, (1, "s"),
                                              moved=tree.current is not None and d.account.id != tree.current)
    return d


def limited(state, key, accounts, now, until, cfg=CFG):
    """What `pi-pool limited` does after a 429 on the tree's account."""
    last = state["sessions"][key.key]["vends"][P]["account_id"]
    vending.HookWriter(state).set_limit(P, last, until, key, now)
    return limited_report.plan_next(state, key, P, accounts, cfg, now)


def decide(state, key, accounts, now=NOW, cooldowns=None, cfg=CFG):
    return sched.decide(sched.tree_for(state, key, P), registry.with_pool_state(accounts, state, P),
                        sched.book_for(state, P, key, cfg, now), cooldowns or {}, cfg, now)


def fresh(id, five, five_reset_in, at, tier="max 20x"):
    """An account whose usage was read at `at`."""
    return dataclasses.replace(acct(id, five=five, tier=tier),
                               windows=(window(five, FIVE, five_reset_in, now=at), window(10, WEEK, 3 * 86400, now=at)))


def run_until_admitted(state, keys, accounts_at, start, horizon=6 * 3600, cfg=CFG):
    """Drive each waiting tree at its own slot, as Prime's wait-for-usage does,
    until every tree is admitted. Returns [(at, key, account id)] in order."""
    due = {k.key: start for k in keys}
    by_key = {k.key: k for k in keys}
    admitted = []
    while due:
        name, at = min(due.items(), key=lambda kv: (kv[1], kv[0]))
        assert at < start + horizon, (name, at)
        d = request(state, by_key[name], accounts_at(at), at, cfg)
        if isinstance(d, sched.Wait):
            assert d.slot_at >= at, (name, d.slot_at, at)
            due[name] = d.slot_at if d.slot_at > at else at + 1
        else:
            admitted.append((at, name, d.account.id))
            del due[name]
    return admitted


def per_bucket(admitted, account_id, slot_sec=CFG["admit_slot_sec"]):
    return collections.Counter(int(at // slot_sec) for at, _, a in admitted if a == account_id)


class R1Stay(unittest.TestCase):
    def test_a_tree_on_an_account_that_still_serves_never_moves(self):
        state = empty_state()
        hot = acct("hot", five=95)
        cool = acct("cool", five=0, week=0, week_reset_in=3600)
        for idle in (60, 2 * 3600):
            put(state, KEY, on="hot", at=NOW - idle)
            d = decide(state, KEY, [hot, cool])
            self.assertIsInstance(d, sched.Stay, idle)
            self.assertEqual(d.account.id, "hot")

    def test_a_tree_already_on_an_85_percent_account_stays(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 2 * 3600)
        d = decide(state, KEY, [acct("a", five=85), acct("b", five=5)])
        self.assertEqual((type(d), d.account.id), (sched.Stay, "a"))

    def test_a_tree_never_moves_because_another_tree_moved(self):
        state = empty_state()
        accounts = [acct("x", five=40), acct("y", five=10), acct("z", five=10)]
        mine = put(state, tree_key("mine"), on="x")
        others = [put(state, tree_key(f"o{i}"), on="x") for i in range(6)]
        for i, k in enumerate(others):
            state["sessions"][k.key]["leave"] = {P: {"account_id": "x", "at": NOW}}
            d = request(state, k, accounts, NOW + i * 200)
            self.assertIsInstance(d, sched.Admit)
            self.assertNotEqual(d.account.id, "x")
        d = request(state, mine, accounts, NOW + 2000)
        self.assertEqual((type(d), d.account.id), (sched.Stay, "x"))

    def test_a_child_session_uses_its_root_record(self):
        state = empty_state()
        put(state, KEY, on="a", priority="high")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "b", "slot_at": NOW + 300, "since": NOW}}
        with tempfile.TemporaryDirectory() as workers:
            with open(os.path.join(workers, "w1.json"), "w") as f:
                json.dump({"rootSessionId": KEY.key}, f)
            env = {base.SESSION_ENV: "ffffffffffff", base.JOURNAL_ENV: os.path.join(workers, "w1.journal")}
            with unittest.mock.patch.dict(os.environ, env):
                child = registry.session_key()
        self.assertEqual((child.key, child.active_id), (KEY.key, "ffffffffffff"))
        self.assertEqual(sched.tree_for(state, child, P), sched.tree_for(state, KEY, P))

    def test_a_resumed_worker_asks_under_its_root_before_the_daemon_names_it(self):
        """10-23 01:05:37Z: 01a162a5's resumed worker asked as a700e3883df7 while its descriptor held only createCommand,
        so its turn let go with no account wait and queued 21 min. The starting descriptor's session file names the root."""
        with tempfile.TemporaryDirectory() as workers:
            session_file = os.path.join(workers, "01a162a5-file.jsonl")
            with open(session_file, "w") as f:
                f.write(json.dumps({"type": "session", "id": KEY.key}) + "\n")
            with open(os.path.join(workers, "w1.json"), "w") as f:
                json.dump({"lifecycle": "starting", "rootActiveSessionId": "a700e3883df7",
                           "createCommand": {"type": "create", "sessionPath": session_file}}, f)
            with open(os.path.join(workers, "w2.json"), "w") as f:
                json.dump({"lifecycle": "starting", "rootActiveSessionId": "9431c7b9cbcf", "createCommand": {"type": "create"}}, f)
            env = {base.SESSION_ENV: "a700e3883df7", base.JOURNAL_ENV: os.path.join(workers, "w1.recovery.jsonl")}
            with unittest.mock.patch.dict(os.environ, env):
                resumed = registry.session_key()
            env = {base.SESSION_ENV: "9431c7b9cbcf", base.JOURNAL_ENV: os.path.join(workers, "w2.recovery.jsonl")}
            with unittest.mock.patch.dict(os.environ, env):
                fresh = registry.session_key()
        self.assertEqual((resumed.key, resumed.uuid, resumed.active_id), (KEY.key, KEY.key, "a700e3883df7"))
        self.assertEqual((fresh.key, fresh.uuid), ("9431c7b9cbcf", None))


class R2AdmitCap(unittest.TestCase):
    def test_no_move_into_an_account_at_the_admit_cap(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100), acct("hot", five=CFG["admit_5h_max_pct"], five_reset_in=1800)]
        d = request(state, KEY, accounts, NOW)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "hot", NOW + 1800))
        self.assertEqual(request(state, KEY, [acct("x", five=100), fresh("hot", 0, FIVE, NOW + 5)], NOW + 5).account.id, "hot")

    def test_no_new_tree_into_an_account_at_the_week_cap(self):
        state = empty_state()
        new = tree_key("new")
        d = decide(state, new, [acct("hot", week=CFG["seven_day_max_pct"])])
        self.assertIsInstance(d, sched.Wait)

    def test_explicit_pin_can_enter_above_auto_admission_cutoff(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "hot", "at": NOW, "by": "cli"}}
        d = decide(state, KEY, [acct("a", five=20), acct("hot", week=99)])
        self.assertIsInstance(d, sched.Admit)
        self.assertEqual(d.account.id, "hot")
        self.assertEqual(d.fallbacks, ())


class R3Score(unittest.TestCase):
    def test_a_week_that_resets_sooner_with_budget_left_wins(self):
        soon = acct("soon", five=10, week=50, week_reset_in=12 * 3600)
        late = acct("late", five=10, week=50, week_reset_in=6 * 86400)
        for order in ([soon, late], [late, soon]):
            d = decide(empty_state(), tree_key("t"), order)
            self.assertEqual((type(d), d.account.id), (sched.Admit, "soon"))

    def test_little_weekly_left_far_from_its_reset_loses(self):
        tired = acct("tired", five=10, week=90, week_reset_in=5 * 86400)
        fresh = acct("fresh", five=10, week=40, week_reset_in=5 * 86400)
        for order in ([tired, fresh], [fresh, tired]):
            d = decide(empty_state(), tree_key("t"), order)
            self.assertEqual(d.account.id, "fresh")

    def test_trees_on_an_account_lower_its_score(self):
        state = empty_state()
        for i in range(8):
            put(state, tree_key(f"o{i}"), on="a")
        d = decide(state, tree_key("t"), [acct("a"), acct("b")])
        self.assertEqual(d.account.id, "b")


class R4Slots(unittest.TestCase):
    """20 trees leave one account in the same second against 3 accounts."""

    def accounts(self):
        return [acct("x", five=100, limited_until=NOW + 4 * 3600), acct("p", five=5, tier="max 20x"),
                acct("q", five=5, tier="max 5x"), acct("r", five=5, tier="max 5x")]

    def test_no_account_admits_more_than_its_slot_cap(self):
        state = empty_state()
        keys = [put(state, tree_key(f"t{i:02d}"), on="x", at=NOW - 30) for i in range(20)]
        first = [request(state, k, self.accounts(), NOW + i * 0.05) for i, k in enumerate(keys)]
        admitted_now = collections.Counter(d.account.id for d in first if isinstance(d, sched.Admit))
        self.assertEqual(admitted_now, {"p": 1, "q": 1, "r": 1})
        waits = [(d.slot_account.id, d.slot_at) for d in first if isinstance(d, sched.Wait)]
        self.assertEqual(len(waits), 17)
        self.assertEqual(len(set(waits)), 17, "every waiter has its own slot")
        admitted = run_until_admitted(state, keys, lambda at: self.accounts(), NOW)
        self.assertEqual(len(admitted), 20)
        for id, cap in (("p", 4), ("q", 1), ("r", 1)):
            self.assertLessEqual(max(per_bucket(admitted, id).values()), cap, id)
        self.assertNotIn("x", {a for _, _, a in admitted})

    def test_a_reset_admits_fifteen_waiters_at_slot_pace(self):
        state = empty_state()
        reset = NOW + 600

        def accounts_at(at):
            if at < reset:
                return [acct("x", five=100, five_reset_in=reset - at, limited_until=reset)]
            return [fresh("x", 0, reset + FIVE - at, at)]

        keys = []
        for i in range(15):
            prio = "high" if i % 3 == 2 else "normal"
            k = put(state, tree_key(f"w{i:02d}"), on="x", at=NOW - 60, priority=prio)
            keys.append(k)
            d = limited(state, k, accounts_at(NOW + i), NOW + i, reset)
            self.assertEqual((type(d), d.slot_account.id), (sched.Wait, "x"))
            self.assertGreaterEqual(d.slot_at, reset)
        admitted = run_until_admitted(state, keys, accounts_at, NOW + 20)
        self.assertEqual(len(admitted), 15)
        self.assertGreaterEqual(admitted[0][0], reset)
        self.assertLessEqual(max(per_bucket(admitted, "x").values()), 4)
        self.assertGreater(admitted[-1][0] - admitted[0][0], 3 * CFG["admit_slot_sec"])


class R5Wait(unittest.TestCase):
    def test_no_admissible_account_means_a_wait_never_a_hop_onto_a_depleted_one(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100, five_reset_in=3000), acct("y", five=100, five_reset_in=1200),
                    acct("z", five=100, five_reset_in=7000)]
        d = limited(state, KEY, accounts, NOW, NOW + 3000)
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(limited_report.next_fields(d), {"next": None, "retry_at": math.ceil(d.slot_at)})
        self.assertEqual((d.slot_account.id, d.slot_at), ("y", NOW + 1200))
        self.assertEqual(state["sessions"][KEY.key]["wait"][P]["slot_at"], NOW + 1200)
        again = request(state, KEY, registry.with_pool_state(accounts, state, P), NOW + 5)
        self.assertEqual((type(again), again.vend.id, again.slot_at), (sched.Wait, "x", NOW + 1200))
        later = [acct("x", five=100, five_reset_in=1800), acct("y", five=0, five_reset_in=FIVE),
                 acct("z", five=100, five_reset_in=5800)]
        d = request(state, KEY, registry.with_pool_state(later, state, P), NOW + 1200)
        self.assertEqual((type(d), d.account.id, d.reason), (sched.Admit, "y", "switch"))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_tree_that_waits_for_its_own_account_comes_back_at_its_reset(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        d = limited(state, KEY, [acct("x", five=100, five_reset_in=600)], NOW, NOW + 600)
        self.assertEqual((d.slot_account.id, d.slot_at), ("x", NOW + 600))
        still = request(state, KEY, [acct("x", five=100, five_reset_in=300)], NOW + 300)
        self.assertEqual((type(still), still.slot_at), (sched.Wait, NOW + 600))
        back = request(state, KEY, [fresh("x", 0, FIVE, NOW + 600)], NOW + 600)
        self.assertEqual((type(back), back.account.id, back.reason), (sched.Admit, "x", "back"))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_tree_on_a_depleted_pool_waits_for_the_first_reset_1018(self):
        """10-18: 01a14eaf, a high tree, waited at 15:10:36Z to 16:45:25Z on the Virev
        seat. claude12, its own account, was limited until 15:50Z, and from then
        claude12, krenerd77 and claude3 took new trees, while every check-in restart
        until 16:04Z met "waits for its slot at 16:45:26"."""
        state = empty_state()
        put(state, KEY, on="c12", at=NOW - 60, priority="high")
        out = [acct("c12", five=100, five_reset_in=2400, limited_until=NOW + 2400),
               acct("kr", five=100, five_reset_in=3000), acct("virev", five=100, five_reset_in=5000, tier="team")]
        d = limited(state, KEY, out, NOW, NOW + 2400)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "c12", NOW + 2400))
        later = NOW + 2400 + 840
        revived = [fresh("c12", 3, FIVE, later - 300), fresh("kr", 12, FIVE, later - 300),
                   dataclasses.replace(acct("virev", five=100, five_reset_in=5000 - 3240, tier="team"))]
        back = request(state, KEY, revived, later)
        self.assertEqual((type(back), back.account.id in ("c12", "kr")), (sched.Admit, True))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_tree_that_asks_again_before_its_reset_keeps_its_slot(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60, priority="high")
        d = limited(state, KEY, [acct("x", five=100, five_reset_in=600), acct("y", five=100)], NOW, NOW + 600)
        again = request(state, KEY, [acct("x", five=100, five_reset_in=300), acct("y", five=100)], NOW + 300)
        self.assertEqual((type(again), again.slot_account.id, again.slot_at), (sched.Wait, "x", d.slot_at))

    def test_who_says_whether_the_tree_holds_the_cell_of_the_wait_it_reads(self):
        """10-23: resume_paused.py held 01a1641e, cut at 04:35Z with a 04:46:30Z claude20 slot, from 04:47Z to 05:02Z on `who`'s dry run,
        which read a new slot a minute ahead on each pass that no cell held, while later trees entered claude20."""
        from vend.pool import session_cmds
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60, priority="high")
        d = limited(state, KEY, [acct("x", five=100, five_reset_in=600), acct("y", five=100)], NOW, NOW + 600)
        held = decide(state, KEY, [acct("x", five=100, five_reset_in=300), acct("y", five=100)], NOW + 300)
        self.assertEqual(session_cmds.wait_view(held, sched.tree_for(state, KEY, P)),
                         {"account": "x", "slot_at": math.ceil(d.slot_at), "reserved": True})
        late = decide(state, KEY, [fresh("x", 100, 300, NOW + 690), fresh("y", 100, 3000, NOW + 690)], NOW + 690)
        view = session_cmds.wait_view(late, sched.tree_for(state, KEY, P))
        self.assertEqual((view["account"], view["slot_at"] > NOW + 690, view["reserved"]), ("x", True, False))

    def test_a_tree_waits_on_its_own_account_when_it_frees_as_early_as_any(self):
        """A move rewrites the tree's whole prompt cache (300k to 390k tokens on 10-21), so
        R5 keeps the tree on its own account when no other account frees sooner."""
        state = empty_state()
        put(state, KEY, on="mine", at=NOW - 60)
        out = [acct("first", five=100, five_reset_in=600), acct("mine", five=100, five_reset_in=600)]
        d = limited(state, KEY, out, NOW, NOW + 600)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "mine", NOW + 600))

    def test_a_tree_that_comes_back_after_its_cell_went_stale_keeps_its_place(self):
        """10-21 20:55Z: 01a14df9, high and waiting since 20:00Z, was told 21:24Z on
        claude-virev5 and asked again at 22:26Z, after its cell went stale. It rejoined the
        queue as if it had started waiting at 22:26Z and got claude-virev10 at 00:42Z, behind
        trees that started waiting after it. In that window 25 of the 38 parks that stayed
        parked over 10 min after a later tree of their class got in had lost their place so."""
        state = empty_state()
        early, later = put(state, tree_key("early"), on="x"), put(state, tree_key("later"), on="x")
        out = acct("x", five=100, five_reset_in=600, tier="max 5x")
        d = limited(state, early, [out], NOW, NOW + 600)
        self.assertEqual((d.slot_account.id, d.slot_at), ("x", NOW + 600))
        again_out = dataclasses.replace(out, limited_until=NOW + 5000)
        w = request(state, later, [again_out], NOW + 1000)
        self.assertEqual((type(w), w.slot_at), (sched.Wait, NOW + 5000))
        back = request(state, early, [again_out], NOW + 600 + sched.WAIT_STALE_SEC + 100)
        self.assertEqual((type(back), back.slot_at), (sched.Wait, NOW + 5000))
        self.assertEqual(state["sessions"][early.key]["wait"][P]["since"], NOW)
        at = NOW + 5000
        open_x = fresh("x", 0, FIVE, at, tier="max 5x")
        self.assertIsInstance(request(state, later, [open_x], at), sched.Wait)
        self.assertEqual(request(state, early, [open_x], at).account.id, "x")

    def test_a_tree_back_after_its_cell_passed_does_not_take_a_cell_held_by_a_tree_ahead_of_it(self):
        """10-22 on claude19 (30 s cells): 01a15c6c, waiting since 15:24:27Z, came back at 15:30:00Z for its 15:28:00Z
        cell and entered the 15:30:00Z cell that 01a15984, waiting since 15:23:25Z, held. 01a15984 asked at 15:30:11Z,
        found that cell taken, and lost its next one the same way before it got in at 15:32:03Z."""
        state = empty_state()
        sp = CFG["admit_slot_sec"]
        cell = math.ceil(NOW / sp) * sp
        early, late = put(state, tree_key("early"), on="y"), put(state, tree_key("late"), on="y")
        state["sessions"][late.key]["wait"] = {P: {"account": "x", "slot_at": cell - 2 * sp, "since": NOW - 300}}
        state["sessions"][early.key]["wait"] = {P: {"account": "x", "slot_at": cell, "since": NOW - 400}}
        x = acct("x", five=10, tier="max 5x")
        out = acct("y", five=100, five_reset_in=FIVE)
        back = request(state, late, [x, out], cell + 5)
        self.assertEqual((type(back), back.slot_at), (sched.Wait, cell + sp))
        self.assertEqual(request(state, early, [x, out], cell + 11).account.id, "x")
        self.assertEqual(request(state, late, [x, out], cell + sp).account.id, "x")

    def test_a_tree_that_enters_its_own_cell_early_books_that_cell(self):
        """10-28 on claude-virev5 (120 s cells): 01a15427 entered its 21:14:00Z cell at 21:13:58.7Z, which own_cell allows
        2 s early, and the admission went into the 21:12:00Z cell. The 21:14:00Z cell read free, and at 21:14:01Z
        01a14210, waiting since 21:12:15Z for 21:24:00Z, took it ahead of four trees that ranked before it. Its 21:24:00Z
        cell then went to 01a17edb, waiting since 21:14:30Z, ahead of 01a1164b, 01a11bd7 and 01a11ba8, whose cells
        never came because claude-virev5 ran out at 21:29Z; d7 read them as passed for 96 to 100 min."""
        state = empty_state()
        x = acct("x", five=10, tier="max 5x")
        out = acct("y", five=100, five_reset_in=FIVE)
        sp = sched.slot_spacing(x, CFG)
        cell = math.ceil(NOW / sp) * sp
        early, behind = put(state, tree_key("early"), on="y"), put(state, tree_key("behind"), on="y")
        state["sessions"][early.key]["wait"] = {P: {"account": "x", "slot_at": cell, "since": NOW - 400}}
        state["sessions"][behind.key]["wait"] = {P: {"account": "x", "slot_at": cell + 5 * sp, "since": NOW - 300}}
        self.assertEqual(request(state, early, [x, out], cell - 1.3).account.id, "x")
        d = request(state, behind, [x, out], cell + 1)
        self.assertEqual((type(d), d.slot_at), (sched.Wait, cell + sp), "the next cell, which nobody holds, not the one it entered")

    def test_a_tree_back_late_still_enters_a_cell_nobody_holds(self):
        state = empty_state()
        sp = CFG["admit_slot_sec"]
        cell = math.ceil(NOW / sp) * sp
        late = put(state, tree_key("late"), on="y")
        state["sessions"][late.key]["wait"] = {P: {"account": "x", "slot_at": cell - 2 * sp, "since": NOW - 300}}
        d = request(state, late, [acct("x", five=10, tier="max 5x"), acct("y", five=100, five_reset_in=FIVE)], cell + 5)
        self.assertEqual(d.account.id, "x")

    def test_a_waiter_whose_account_serves_before_its_slot_gets_no_token(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 900, "since": NOW - 10}}
        busy = put(state, tree_key("busy"), on="z")
        state["providers"][P]["admissions"] = {"x": [[NOW, busy.key]]}
        d = decide(state, KEY, [acct("x", five=60, tier="max 5x"), acct("y", five=100, five_reset_in=900)])
        self.assertIsInstance(d, sched.Wait)
        self.assertIsNone(d.vend)



class R5DepletedPool(unittest.TestCase):
    """Every account is out. The owner on 10-18: "when 5h limit ends, but next accounts
    revive like 2 minute at a time, everybody rushes to first thread, cache-write tokens
    deplete it in 1 second". Before R4 the Mac log shows it: 10-10 20:59:59 claude9 took
    27 trees in 10 s and answered 429 44 s later. A random 0 to 120 min draw then spread
    the waiters out, and on 10-20 and 10-21 it parked trees 82 min at the median and
    2.9 h at p90, a median 31 min after another tree had got an account. Now each tree
    waits for its own R4 cell at the real reset of the account that frees first."""

    ACCOUNTS, TREES, SAMPLE_SEC, WORK_MIN = 8, 100, 120, 20
    # A tree's first request on an account writes its whole prompt cache, and a busy
    # tree spends 3.5 times the max 20x rate the pool assumes before it has a rate of
    # its own, so accounts do run dry.
    ENTRY_PCT, SPEND_PER_MIN = 3.0, 1.0

    def simulate(self):
        names = [f"a{i}" for i in range(self.ACCOUNTS)]
        reset = {a: NOW + 120 * (i + 1) for i, a in enumerate(names)}
        pct = {a: 100.0 for a in names}
        read = {a: (NOW, 100.0) for a in names}
        revived, drained = collections.defaultdict(list), collections.defaultdict(list)
        state = empty_state()
        keys = [put(state, tree_key(f"t{i:03d}"), on=names[i % self.ACCOUNTS], at=NOW - 60) for i in range(self.TREES)]
        rate = self.SPEND_PER_MIN

        def view(at):
            out = []
            for a in names:
                at_read, used = read[a]
                w5 = dict(window(min(100, round(used)), FIVE, reset[a] - at_read, now=at_read))
                out.append(dataclasses.replace(acct(a, five=min(100, round(used))), windows=(w5, window(10, WEEK, 3 * 86400, now=at_read))))
            return out

        def tick(at):
            for a in names:
                if at >= reset[a]:
                    reset[a] += FIVE
                    pct[a] = 0.0
                    revived[a].append(at)
                if at - read[a][0] >= self.SAMPLE_SEC:
                    read[a] = (at, pct[a])

        def spend(a, amount, at):
            before = pct[a]
            pct[a] += amount
            if before < 100 <= pct[a]:
                drained[a].append(at)

        due = {}
        for i, k in enumerate(keys):
            d = limited(state, k, view(NOW + i * 0.1), NOW + i * 0.1, reset[names[i % self.ACCOUNTS]])
            self.assertIsInstance(d, sched.Wait)
            due[k.key] = d.slot_at
        by_key = {k.key: k for k in keys}
        worked = collections.Counter()
        on = {}
        first_token, entries = {}, []
        clock = NOW
        while due and len(first_token) < self.TREES:
            name, at = min(due.items(), key=lambda kv: (kv[1], kv[0]))
            self.assertLess(at, NOW + 24 * 3600, f"{name} got no token in 24 h")
            while clock + self.SAMPLE_SEC <= at:
                clock += self.SAMPLE_SEC
                tick(clock)
            tick(at)
            key = by_key[name]
            a = on.get(name)
            if a is not None and pct[a] >= 100:
                d = limited(state, key, view(at), at, reset[a])
                on.pop(name)
            else:
                d = request(state, key, view(at), at)
            if isinstance(d, sched.Wait):
                due[name] = d.slot_at if d.slot_at > at else at + 1
                continue
            if d.account.id != a:
                entries.append((at, d.account.id))
                spend(d.account.id, self.ENTRY_PCT, at)
            first_token.setdefault(name, at)
            on[name] = d.account.id
            spend(d.account.id, rate, at)
            worked[name] += 1
            if worked[name] >= self.WORK_MIN:
                del due[name]
            else:
                due[name] = at + 60
        return revived, drained, first_token, entries

    def test_a_hundred_waiters_meet_accounts_that_revive_two_minutes_apart(self):
        revived, drained, first_token, entries = self.simulate()
        self.assertEqual(len(first_token), self.TREES)
        for a, ups in revived.items():
            for up in ups:
                down = [t for t in drained[a] if t >= up]
                if down:
                    self.assertGreaterEqual(down[0] - up, 60, (a, up))
        per_window = collections.Counter((a, int(at // CFG["admit_slot_sec"])) for at, a in entries)
        self.assertLessEqual(max(per_window.values()), 4)
        first_minute = [sum(1 for at, b in entries if b == a and up <= at < up + 60)
                        for a, ups in revived.items() for up in ups]
        # R4's 30 s cells of a max 20x account: at most 3 entries start in any minute.
        self.assertLessEqual(max(first_minute), 3)

    def test_every_waiter_enters_at_its_accounts_real_reset_in_cell_order(self):
        """100 trees find 8 accounts out, which reset 3 minutes apart. Each tree's slot is at
        or after its account's reset and no later than its place in that account's R4 cells,
        it enters on its first wake at that slot, the best account open then, and no account
        takes a tree before its reset or more per admit_slot_sec than R4 allows. On 10-18 08:11-08:35Z, before the
        random draw, a displaced tree woke every 30 s and took about 20 429s in 3 minutes."""
        names = [f"a{i}" for i in range(8)]
        reset = {a: NOW + 180 * (i + 1) for i, a in enumerate(names)}

        def view(at):
            return [fresh(a, 0, reset[a] + FIVE - at, at) if at >= reset[a] else fresh(a, 100, reset[a] - at, at)
                    for a in names]

        state = empty_state()
        keys = [put(state, tree_key(f"t{i:03d}"), on=names[i % 8], at=NOW - 60) for i in range(100)]
        slots = {}
        for i, k in enumerate(keys):
            at = NOW + i * 0.1
            d = limited(state, k, view(at), at, reset[names[i % 8]])
            self.assertIsInstance(d, sched.Wait)
            slots[k.key] = (d.slot_account.id, d.slot_at)
        for a in names:
            mine = sorted(at for b, at in slots.values() if b == a)
            sp = sched.slot_spacing(acct(a), CFG)
            for place, at in enumerate(mine):
                self.assertGreaterEqual(at, reset[a], a)
                self.assertLessEqual(at, reset[a] + place * sp, (a, place))
        self.assertGreater(len({b for b, _ in slots.values()}), 1, "the waiters spread over the resets")
        admitted = run_until_admitted(state, keys, view, NOW + 20)
        self.assertEqual(len(admitted), 100)
        for at, name, a in admitted:
            self.assertEqual(at, slots[name][1], name)
            self.assertGreaterEqual(at, reset[a])
        for a in names:
            if per_bucket(admitted, a):
                self.assertLessEqual(max(per_bucket(admitted, a).values()), sched.slot_cap(acct(a), CFG), a)

    def test_a_high_tree_waits_for_the_reset_like_any_other(self):
        """The owner on 10-18, asked whether his own turns skip the depleted wait: "no don't"."""
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60, priority="high")
        d = limited(state, KEY, [acct("x", five=100, five_reset_in=600)], NOW, NOW + 600)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "x", NOW + 600))

class R6MoveBudget(unittest.TestCase):
    ACCOUNTS = [acct("x", five=100, five_reset_in=1800), acct("y", five=5)]

    def test_a_normal_tree_out_of_moves_waits_for_its_own_account(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 3600 * h for h in (1, 2, 3)])
        d = decide(state, KEY, self.ACCOUNTS)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "x", NOW + 1800))

    def test_a_tree_out_of_moves_whose_account_is_out_past_the_wait_cap_moves_anyway(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 3600 * h for h in (20, 5, 1)])
        out = acct("x", five=10, week=100, week_reset_in=5 * 86400)
        d = decide(state, KEY, [out, acct("y", five=5)])
        self.assertEqual((type(d), d.account.id, d.left), (sched.Admit, "y", ("x", "budget_overrun")))
        self.assertEqual(vending.switch_why(d, d.account), "budget_overrun")
        soon = acct("x", five=100, five_reset_in=CFG["budget_wait_max_sec"] - 60)
        self.assertEqual(type(decide(state, KEY, [soon, acct("y", five=5)])), sched.Wait)

    def test_the_wait_cap_counts_from_the_start_of_the_wait_1018(self):
        # 01a11a24 on 10-18: a low tree out of moves waited for claude9 from 15:09Z to 17:21Z,
        # since each request found claude9 less than an hour away and measured the hour from itself.
        state = empty_state()
        put(state, KEY, on="x", priority="low", moves=[NOW - 3 * 3600])
        y = acct("y", five=5)
        d = request(state, KEY, [acct("x", five=100, five_reset_in=3000), y], NOW)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "x", NOW + 3000))
        later = NOW + 3000
        d = request(state, KEY, [fresh("x", 100, 1800, later), fresh("y", 5, 4 * 3600, later)], later)
        self.assertEqual((type(d), d.account.id, d.left), (sched.Admit, "y", ("x", "budget_overrun")))

    def test_a_tree_held_for_its_own_account_asks_again_at_the_end_of_its_hour(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 3600 * h for h in (1, 2, 3)])
        vending.HookWriter(state).set_wait(KEY, P, "x", NOW, NOW - 3000)
        for i in range(10):
            ahead = put(state, tree_key(f"h{i}"), on="y", priority="high")
            vending.HookWriter(state).set_wait(ahead, P, "x", NOW + 300 + 120 * i, NOW - 4000)
        accounts = [acct("x", five=100, five_reset_in=300, tier="max 5x"), acct("y", five=5)]
        d = decide(state, KEY, accounts)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at), (sched.Wait, "x", NOW + 600))
        d = decide(state, KEY, accounts, now=NOW + 600)
        self.assertEqual((type(d), d.account.id, d.left), (sched.Admit, "y", ("x", "budget_overrun")))

    def test_trees_whose_hours_end_together_enter_at_slot_pace(self):
        keys = [put(empty_state(), tree_key(f"t{i:02d}")) for i in range(12)]
        state = empty_state()
        for k in keys:
            put(state, k, on="x", priority="low", moves=[NOW - 5 * 3600])
            vending.HookWriter(state).set_wait(k, P, "x", NOW + 3500, NOW)

        def accounts_at(t):
            reset = NOW + 3500 if t < NOW + 3400 else NOW + 9000
            return [fresh("x", 100, reset - t, t, "max 5x"), fresh("y", 5, 4 * 3600, t, "max 5x"),
                    fresh("z", 5, 4 * 3600, t, "max 5x")]
        admitted = run_until_admitted(state, keys, accounts_at, NOW + 3000)
        self.assertEqual({a for _, _, a in admitted}, {"y", "z"})
        self.assertEqual(max(max(per_bucket(admitted, a).values()) for a in ("y", "z")), 1)
        self.assertGreaterEqual(min(at for at, _, _ in admitted), NOW + 3500)

    def test_an_escape_keeps_a_manual_pin_and_skips_an_off_account(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 3600 * h for h in (1, 2, 3)])
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "x", "at": NOW - 7200, "by": "cli"}}
        vending.HookWriter(state).set_wait(KEY, P, "x", NOW, NOW - 7200)
        accounts = [acct("x", five=100, five_reset_in=3 * 3600), acct("y", five=5)]
        d = decide(state, KEY, accounts)
        self.assertEqual((type(d), d.slot_account.id), (sched.Wait, "x"))
        del state["sessions"][KEY.key]["pins"][P]
        off = dataclasses.replace(acct("y", five=1), disabled=True)
        d = decide(state, KEY, [accounts[0], off, acct("z", five=40)])
        self.assertEqual((type(d), d.account.id, d.left), (sched.Admit, "z", ("x", "budget_overrun")))

    def test_moves_older_than_a_day_do_not_count(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 25 * 3600] * 3)
        self.assertEqual(decide(state, KEY, self.ACCOUNTS).account.id, "y")

    def test_a_low_tree_has_one_move(self):
        state = empty_state()
        put(state, KEY, on="x", priority="low", moves=[NOW - 60])
        self.assertIsInstance(decide(state, KEY, self.ACCOUNTS), sched.Wait)

    def test_a_high_tree_is_never_refused_a_move_it_needs(self):
        state = empty_state()
        put(state, KEY, on="x", priority="high", moves=[NOW - 60 * i for i in range(1, 9)])
        d = decide(state, KEY, self.ACCOUNTS)
        self.assertEqual((type(d), d.account.id), (sched.Admit, "y"))

    def test_a_high_tree_out_of_moves_is_refused_an_optional_move(self):
        state = empty_state()
        put(state, KEY, on="x", priority="high", moves=[NOW - 60 * i for i in range(1, 7)])
        state["sessions"][KEY.key]["leave"] = {P: {"account_id": "x", "at": NOW}}
        d = decide(state, KEY, [acct("x", five=30), acct("y", five=5)])
        self.assertEqual((type(d), d.account.id), (sched.Stay, "x"))

    def test_a_move_is_counted(self):
        state = empty_state()
        put(state, KEY, on="x")
        request(state, KEY, self.ACCOUNTS, NOW)
        self.assertEqual(state["sessions"][KEY.key]["moves"][P], [NOW])


class R7PriorityShare(unittest.TestCase):
    def test_a_low_tree_enters_only_under_the_low_cap(self):
        mid = acct("mid", five=55)
        self.assertIsInstance(decide(empty_state(), tree_key("n"), [mid]), sched.Admit)
        state = empty_state()
        put(state, tree_key("l"), priority="low", at=NOW)
        self.assertIsInstance(decide(state, tree_key("l"), [mid]), sched.Wait)

    def test_the_last_cell_of_the_last_account_is_for_high_trees(self):
        state = empty_state()
        only = [acct("only", five=5, tier="max 20x")]
        sp = CFG["admit_slot_sec"] / 4
        bucket = (NOW // CFG["admit_slot_sec"] + 1) * CFG["admit_slot_sec"]
        normals = [put(state, tree_key(f"n{i}"), at=NOW) for i in range(4)]
        got = [request(state, k, only, bucket + i * sp) for i, k in enumerate(normals)]
        self.assertEqual([type(d) for d in got], [sched.Admit] * 3 + [sched.Wait])
        high = put(state, tree_key("h"), at=NOW, priority="high")
        self.assertIsInstance(request(state, high, only, bucket + 3 * sp), sched.Admit)

    def test_a_high_waiter_goes_ahead_of_an_earlier_normal_one(self):
        state = empty_state()
        accounts = [acct("x", five=0, tier="max 5x")]
        self.assertIsInstance(request(state, tree_key("first"), accounts, NOW), sched.Admit)
        n = put(state, tree_key("n"), at=NOW - 60)
        h = put(state, tree_key("h"), at=NOW - 60, priority="high")
        dn = request(state, n, accounts, NOW + 1)
        dh = request(state, h, accounts, NOW + 5)
        self.assertEqual(dh.slot_at, dn.slot_at)
        self.assertIsInstance(decide(state, n, accounts, now=dn.slot_at), sched.Wait)


class Pins(unittest.TestCase):
    def test_a_pin_applies_on_the_next_request(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 30, "by": "cli"}}
        d = request(state, KEY, [acct("a", five=20), acct("b", five=10)], NOW)
        self.assertEqual((d.account.id, d.reason), ("b", "session_pin"))

    def test_a_pin_waits_and_uses_its_account_once_it_recovers(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 30, "by": "cli"}}
        d = request(state, KEY, [acct("a", five=20), acct("b", five=100)], NOW)
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(d.slot_account.id, "b")
        self.assertIsNone(d.vend)
        d = request(state, KEY, [acct("a", five=20), acct("b", five=0)], NOW + 600)
        self.assertEqual((type(d), d.account.id), (sched.Admit, "b"))

    def test_a_pin_steers_a_cold_tree(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 2 * 3600)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 3 * 3600, "by": "cli"}}
        d = decide(state, KEY, [acct("a", five=20), acct("b", five=10)])
        self.assertEqual((type(d), d.account.id, d.reason), (sched.Admit, "b", "session_pin"))

    def test_a_pin_steers_a_tree_that_must_move(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "c", "at": NOW - 3 * 3600, "by": "cli"}}
        accounts = [acct("a", five=100), acct("b", five=0, week=0, week_reset_in=3600), acct("c", five=40)]
        self.assertEqual(decide(state, KEY, accounts).account.id, "c")


class StateCleanup(unittest.TestCase):
    def test_pins_older_than_pin_ttl_are_retained_on_load(self):
        raw = empty_state()
        raw["sessions"] = {
            "o": {"pins": {P: {"account_id": "a", "at": NOW - 8 * 86400, "by": "cli"}}, "last_seen": NOW},
            "k": {"pins": {P: {"account_id": "a", "at": NOW - 3600, "by": "cli"}}, "last_seen": NOW}}
        out = registry.normalize(raw)
        self.assertEqual(out["sessions"]["o"]["pins"].get(P),
                         {"account_id": "a", "at": NOW - 8 * 86400, "by": "cli"})
        self.assertEqual(out["sessions"]["k"]["pins"][P], {"account_id": "a", "at": NOW - 3600, "by": "cli"})
        self.assertEqual(registry.normalize(json.loads(json.dumps(out))), out)

    def test_prune_drops_old_admissions_moves_and_stale_waits(self):
        state = empty_state()
        put(state, KEY, on="a", moves=[NOW - 2 * 86400, NOW - 60])
        stale = NOW - 2 * sched.WAIT_STALE_SEC
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": stale, "since": NOW - 7200}}
        state["providers"][P]["admissions"] = {"a": [[NOW - 2 * sched.ADMISSION_KEEP_SEC, "x"], [NOW - 5, "y"]]}
        self.assertTrue(vending.HookWriter(state).prune(CFG, NOW))
        rec = state["sessions"][KEY.key]
        self.assertEqual((rec["moves"][P], rec["wait"]), ([NOW - 60], {P: {"slot_at": stale, "since": NOW - 7200}}))
        self.assertEqual(state["providers"][P]["admissions"], {"a": [[NOW - 5, "y"]]})
        self.assertFalse(vending.HookWriter(state).prune(CFG, NOW))
        self.assertEqual(sched.book_for(state, P, None, CFG, NOW).waiting, {})
        self.assertTrue(vending.HookWriter(state).prune(CFG, stale + sched.PLACE_KEEP_SEC + 1))
        self.assertEqual(rec["wait"], {})


class Cli(unittest.TestCase):
    def run_cli(self, state, accounts, args, key=KEY):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            base.save_json(path, state)
            out = io.StringIO()
            with contextlib.ExitStack() as stack:
                for name, value in (("STATE", path), ("LOCK", path + ".lock"), ("LOG", os.path.join(tmp, "log"))):
                    stack.enter_context(unittest.mock.patch.object(base, name, value))
                stack.enter_context(unittest.mock.patch.object(registry, "session_key", lambda: key))
                stack.enter_context(unittest.mock.patch.object(registry, "load_index", lambda p: accounts))
                stack.enter_context(unittest.mock.patch.object(base, "config", lambda: dict(CFG)))
                stack.enter_context(unittest.mock.patch.object(limit_resets, "reset_rows", lambda a: {}))
                stack.enter_context(unittest.mock.patch.object(time, "time", lambda: NOW))
                stack.enter_context(contextlib.redirect_stdout(out))
                rc = vend.cli(args)
            return rc, out.getvalue(), base.load_json(path)

    def test_limited_prints_the_tree_slot_as_retry_at(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100, five_reset_in=3000), acct("y", five=100, five_reset_in=900)]
        rc, out, saved = self.run_cli(state, accounts, ["limited", "--until", str(NOW + 3000)])
        reply = json.loads(out)
        self.assertEqual((rc, reply["next"], reply["retry_at"]), (0, None, round(NOW + 900)))
        self.assertEqual(saved["sessions"][KEY.key]["wait"][P]["account"], "y")

    def test_limited_names_the_next_account_when_one_takes_the_tree(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        rc, out, _ = self.run_cli(state, [acct("x", five=100), acct("y", five=10)], ["limited", "--until", str(NOW + 3000)])
        self.assertEqual(json.loads(out), {"account": "x@x", "until": round(NOW + 3000), "next": "y@x", "retry_at": None,
                                           "selection": {"mode": "auto"}})

    def test_priority_creates_the_tree_record_of_a_new_session(self):
        uuid = "01a00000-0000-7000-8000-000000000042"
        rc, out, saved = self.run_cli(empty_state(), [], ["priority", "high", "--session", uuid], key=None)
        self.assertEqual((rc, saved["sessions"][uuid]["priority"]), (0, "high"))

    def test_priority_rejects_an_unknown_class(self):
        with self.assertRaises(SystemExit):
            self.run_cli(empty_state(), [], ["priority", "urgent"])

    def test_who_and_ls_show_priority_and_wait(self):
        state = empty_state()
        put(state, KEY, on="x", priority="low")
        accounts = [acct("x", five=100), acct("y", five=40, tier="max 5x")]
        # The first cell after the one `busy` took: a cell nobody holds before it would move the wait there.
        slot = (NOW // sched.slot_spacing(accounts[1], CFG) + 1) * sched.slot_spacing(accounts[1], CFG)
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": slot, "since": NOW}}
        state["providers"][P]["admissions"] = {"y": [[NOW, put(state, tree_key("busy"), on="y").key]]}
        _, out, _ = self.run_cli(state, accounts, ["who", "--json"])
        who = json.loads(out)
        self.assertEqual((who["priority"], who["providers"][P]["wait"]), ("low", {"account": "y", "slot_at": math.ceil(slot), "reserved": True}))
        _, out, _ = self.run_cli(state, accounts, ["ls", "--json"])
        ls = json.loads(out)
        self.assertEqual((ls["priority"], ls["wait"]), ("low", {"account": "y", "slot_at": math.ceil(slot), "reserved": True}))
        self.assertNotIn("force", ls["rows"][0])
        rc, out, _ = self.run_cli(state, accounts, ["ls"])
        self.assertEqual(rc, 0)
        self.assertIn("priority low  waits for y", out)

    def test_who_shows_no_wait_when_the_next_request_gets_an_account_1018(self):
        """10-18 16:21Z: `who` printed 01a14eb4's wait to 16:47Z on the Virev seat
        while its next request would have entered claude4."""
        state = empty_state()
        put(state, KEY, on="x", priority="high")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 1500, "since": NOW - 600}}
        _, out, _ = self.run_cli(state, [acct("x", five=100, limited_until=NOW + 600), acct("y", five=100), acct("z", five=5)], ["who", "--json"])
        who = json.loads(out)["providers"][P]
        self.assertEqual((who["wait"], who["label"]), (None, "z@x"))

    def test_ls_counts_every_tree_that_waits_on_an_account(self):
        """10-18 16:04Z: 01a14eaf waited to 16:45Z on the Virev seat while every
        row of `pi-pool ls --json` read waiting 0."""
        state = empty_state()
        put(state, KEY, on="x")
        soon, later = put(state, tree_key("soon"), on="x"), put(state, tree_key("later"), on="x")
        state["sessions"][soon.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 120, "since": NOW}}
        state["sessions"][later.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 2400, "since": NOW}}
        _, out, _ = self.run_cli(state, [acct("x"), acct("y", five=100)], ["ls", "--json"])
        self.assertEqual({row["id"]: row["waiting"] for row in json.loads(out)["rows"]}, {"x": 0, "y": 2})

    def test_switch_writes_a_leave_for_this_session_only(self):
        state = empty_state()
        put(state, KEY, on="b")
        other = put(state, tree_key("other"), on="b")
        rc, _, saved = self.run_cli(state, [acct("b")], ["switch"])
        self.assertEqual(saved["sessions"][KEY.key]["leave"][P]["account_id"], "b")
        self.assertNotIn("leave", saved["sessions"][other.key])


class SwitchLog(unittest.TestCase):
    def run_vend(self, state, accounts):
        logged = []
        with contextlib.ExitStack() as stack:
            for module, name, value in ((base, "config", CFG), (registry, "load_index", accounts),
                                        (registry, "session_key", KEY), (registry, "load_state", state),
                                        (vending, "credential_for", ("fixture-token", "store")),
                                        (base, "proc_info", {"start": "s"})):
                stack.enter_context(unittest.mock.patch.object(module, name, return_value=value))
            stack.enter_context(unittest.mock.patch.object(base, "Flock", lambda *a, **kw: contextlib.nullcontext()))
            stack.enter_context(unittest.mock.patch.object(time, "time", return_value=NOW))
            stack.enter_context(unittest.mock.patch.object(base, "save_json"))
            stack.enter_context(unittest.mock.patch.object(base, "anthropic_probe", return_value=base.ProbeAccepted()))
            stack.enter_context(unittest.mock.patch.object(base, "log", side_effect=lambda e, **kw: logged.append((e, kw))))
            out = io.StringIO()
            stack.enter_context(contextlib.redirect_stdout(out))
            vending.vend(P)
        return logged, out.getvalue()

    def test_a_move_logs_why_and_the_scores(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, _ = self.run_vend(state, [acct("a", five=10), acct("b", five=100)])
        [(_, line)] = [e for e in logged if e[0] == "switch"]
        self.assertEqual((line["previous"], line["account"], line["reason"], line["why"]),
                         ("b@x", "a@x", "switch", "depleted"))
        self.assertEqual(list(line["scores"]), ["a@x"])

    def test_staying_logs_no_switch(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, out = self.run_vend(state, [acct("a", five=10), acct("b", five=85)])
        self.assertEqual([e for e, _ in logged if e == "switch"], [])
        self.assertEqual(out, "fixture-token")

    def test_a_waiting_tree_on_a_refused_account_gets_that_account(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, out = self.run_vend(state, [acct("a", five=100), acct("b", five=100)])
        self.assertEqual(out, "fixture-token")
        self.assertEqual([e for e, _ in logged if e in ("wait", "switch")], ["wait"])

    def test_a_waiting_tree_with_no_refused_account_gets_no_token(self):
        state = empty_state()
        put(state, KEY, on="b")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": NOW + 600, "since": NOW}}
        state["providers"][P]["admissions"] = {"b": [[NOW, "busy"]]}
        with self.assertRaises(SystemExit):
            self.run_vend(state, [acct("a", five=100, five_reset_in=600), acct("b", five=30, tier="max 5x")])

    def test_a_refused_request_logs_parked_with_the_accounts_that_take_its_class(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, _ = self.run_vend(state, [acct("a", five=100), acct("b", five=100)])
        [parked] = [kw for e, kw in logged if e == "parked"]
        self.assertEqual((parked["session"], parked["room"], parked["at"]), (KEY.key, [], NOW))
        state["sessions"][KEY.key]["wait"] = {P: {"account": "c", "slot_at": NOW + 600, "since": NOW}}
        state["providers"][P]["admissions"] = {"c": [[NOW, "busy"]]}
        logged, _ = self.run_vend(state, [acct("b", five=100), acct("c", five=30, tier="max 5x")])
        self.assertEqual([kw["room"] for e, kw in logged if e == "parked"], [["c@x"]])

    def test_a_pinned_tree_marks_its_parked_and_unparked_lines_manual(self):
        """10-22: 01a11ba8, pinned to claude8, waited from 15:19Z for its 16:30Z reset, and the Whole system duty read it as
        passed by Auto trees, since its return to its own account wrote no vend line."""
        state = empty_state()
        put(state, KEY, on="b")
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 600, "by": "cli"}}
        logged, _ = self.run_vend(state, [acct("a", five=10), acct("b", five=100, five_reset_in=600)])
        [parked] = [kw for e, kw in logged if e == "parked"]
        self.assertEqual((parked["account"], parked.get("manual")), ("b@x", True))
        state["sessions"][KEY.key]["wait"] = {P: {"account": "b", "slot_at": NOW, "since": NOW - 600}}
        logged, _ = self.run_vend(state, [acct("a", five=10), acct("b", five=10)])
        [unparked] = [kw for e, kw in logged if e == "unparked"]
        self.assertEqual((unparked["account"], unparked.get("manual")), ("b@x", True))
        self.assertEqual([e for e, _ in logged if e == "vend"], [], "a pinned tree back on its own account writes no vend line")

    def test_an_auto_tree_marks_no_parked_line_manual(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, _ = self.run_vend(state, [acct("a", five=100), acct("b", five=100)])
        self.assertNotIn("manual", [kw for e, kw in logged if e == "parked"][0])

    def test_a_refusal_by_the_move_budget_logs_no_room(self):
        # 01a11a24 on 10-18: a low tree out of moves (R6) parked on claude9 from 16:50Z to 17:21Z, and every parked line
        # named claude9, krenerd77 and three more as room.
        state = empty_state()
        put(state, KEY, on="x", priority="low", moves=[NOW - 60])
        logged, _ = self.run_vend(state, [acct("x", five=100, five_reset_in=1800), acct("y", five=5)])
        self.assertEqual([kw["room"] for e, kw in logged if e == "parked"], [[]])

    def test_a_tree_that_waited_logs_unparked_when_it_gets_an_account(self):
        state = empty_state()
        put(state, KEY, on="b")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": NOW - 5, "since": NOW - 900}}
        logged, out = self.run_vend(state, [acct("a", five=10), acct("b", five=100)])
        self.assertEqual((out, [kw["account"] for e, kw in logged if e == "unparked"]), ("fixture-token", ["a@x"]))

    def test_switches_today_counts_switch_lines_per_provider(self):
        day = time.strftime("%Y-%m-%d", time.gmtime(NOW))
        before = time.strftime("%Y-%m-%d", time.gmtime(NOW - 86400))
        lines = [{"ts": f"{before}T23:00:00", "event": "switch", "provider": P, "session": "s0"},
                 {"ts": f"{day}T01:00:00", "event": "switch", "provider": P, "session": "s1"},
                 {"ts": f"{day}T02:00:00", "event": "vend", "provider": P, "session": "s1"},
                 {"ts": f"{day}T03:00:00", "event": "switch", "provider": P, "session": "s1"},
                 {"ts": f"{day}T04:00:00", "event": "switch", "provider": "openai-codex", "session": "s2"},
                 {"ts": f"{day}T05:00:00", "event": "switch", "provider": P, "session": "s3"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pi-pool.log")
            with open(path, "w") as f:
                f.writelines(json.dumps(e) + "\n" for e in lines)
            with unittest.mock.patch.object(base, "LOG", path):
                self.assertEqual(status_view.switches_today(P, NOW), (3, 2))
                self.assertEqual(status_view.switches_today("openai-codex", NOW), (1, 1))


# The Virev team seat on 2026-10-13, as the account index held it: one 5h sample
# from 2026-10-12 06:05Z (100%, reset 07:40Z) and its Fable week. The sampler of the
# time skipped team seats, so at 22:40 KST the sample was 31.6 h old and read as 0%.
VIREV = "e128c1aa-bc3a-5286-8733-e64aff2b73ce"
VIREV_WINDOWS = (
    {"name": None, "usedPercentage": 100, "resetsAt": 1791790800258, "windowSeconds": FIVE, "sampledAt": 1791785103366},
    {"name": "Fable", "usedPercentage": 0, "resetsAt": 1792245600258, "windowSeconds": WEEK, "sampledAt": 1791785103366},
)
# 2026-10-13 22:40:01 KST, when the seat's 429 limit ended and the trees waiting for it came back.
VIREV_BACK = 1791898801.0
# The nine trees that took the seat back at slot pace (pi-pool.log waits and vends,
# 22:40:01 to 22:56); Anthropic refused the seat at 23:04:46 until 03:40 KST.
VIREV_TREES = ("01a10dbb", "01a11bd7", "01a115e2", "01a11ba8", "01a1164b", "01a11b0b", "01a1301d", "01a10db0", "01a10db8")


def virev_seat(windows=VIREV_WINDOWS):
    five, _ = registry.usage_pct({"windows": list(windows)}, VIREV_BACK)
    return dataclasses.replace(account(VIREV, "sieun@virev.ai", session_pct=five, weekly_pct=0),
                               tier="team 5x", windows=windows)


def fresh_window(pct, secs, reset_at, at):
    return {"name": None, "usedPercentage": pct, "windowSeconds": secs, "resetsAt": reset_at * 1000, "sampledAt": at * 1000}


class StaleUsage(unittest.TestCase):
    """R2: an account takes a new tree only on a 5h usage sample under STALE_USAGE_SEC old."""

    def test_virev_seat_1013_takes_none_of_the_nine_trees_on_a_31h_old_sample(self):
        state = empty_state()
        keys = [put(state, tree_key(name), on=VIREV, at=VIREV_BACK - 3 * 3600) for name in VIREV_TREES]
        for i, key in enumerate(keys):
            state["sessions"][key.key]["wait"] = {P: {"account": VIREV, "slot_at": VIREV_BACK + 120 * i, "since": VIREV_BACK - 3600}}
        other = acct("claude10", five=100, five_reset_in=1200, week=80, tier="max 5x")
        taken = []
        for i, key in enumerate(keys):
            now = VIREV_BACK + 120 * i
            d = request(state, key, [virev_seat(), dataclasses.replace(other, limited_until=now + 1200)], now)
            taken.append(isinstance(d, sched.Admit) and d.account.id == VIREV)
        self.assertEqual(sum(taken), 0)

    def test_the_seat_on_a_fresh_read_admits_again(self):
        state = empty_state()
        key = put(state, tree_key(VIREV_TREES[0]), on=VIREV, at=VIREV_BACK - 3 * 3600)
        state["sessions"][key.key]["wait"] = {P: {"account": VIREV, "slot_at": VIREV_BACK, "since": VIREV_BACK - 3600}}
        read = (fresh_window(0, FIVE, VIREV_BACK + FIVE, VIREV_BACK - 2), VIREV_WINDOWS[1])
        d = request(state, key, [virev_seat(read)], VIREV_BACK)
        self.assertIsInstance(d, sched.Admit)
        self.assertEqual(d.account.id, VIREV)

    def test_a_sample_older_than_stale_usage_sec_stops_admissions_and_a_tree_on_the_account_stays(self):
        old = VIREV_BACK - registry.STALE_USAGE_SEC - 1
        read = (fresh_window(10, FIVE, VIREV_BACK + 3600, old),)
        seat = dataclasses.replace(acct("seat", tier="team 5x"), windows=read, session_pct=10, weekly_pct=0)
        state = empty_state()
        self.assertEqual(sched.admit_reason(seat, {}, CFG, VIREV_BACK), "unsampled")
        new = request(state, tree_key("new"), [seat], VIREV_BACK)
        self.assertIsInstance(new, sched.Wait)
        self.assertGreaterEqual(new.slot_at, VIREV_BACK + registry.REFRESH_TIMEOUT_SEC)
        on = put(state, tree_key("on"), on="seat", at=VIREV_BACK - 60)
        self.assertIsInstance(request(state, on, [seat], VIREV_BACK), sched.Stay)

    def run_vend(self, state, accounts, now):
        started, logged = [], []
        with contextlib.ExitStack() as stack:
            for module, name, value in ((base, "config", CFG), (registry, "load_index", accounts),
                                        (registry, "session_key", KEY), (registry, "load_state", state),
                                        (vending, "credential_for", ("fixture-token", "store")),
                                        (base, "proc_info", {"start": "s"})):
                stack.enter_context(unittest.mock.patch.object(module, name, return_value=value))
            stack.enter_context(unittest.mock.patch.object(base, "Flock", lambda *a, **kw: contextlib.nullcontext()))
            stack.enter_context(unittest.mock.patch.object(time, "time", return_value=now))
            stack.enter_context(unittest.mock.patch.object(base, "save_json"))
            stack.enter_context(unittest.mock.patch.object(base, "anthropic_probe", return_value=base.ProbeAccepted()))
            stack.enter_context(unittest.mock.patch.object(base, "log", side_effect=lambda e, **kw: logged.append((e, kw))))
            stack.enter_context(unittest.mock.patch.object(vending.subprocess, "Popen", side_effect=lambda argv, **kw: started.append((argv, kw))))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            vending.vend(P)
        return started, logged

    def test_the_hook_reads_a_stale_account_once_in_the_background(self):
        state = empty_state()
        put(state, KEY, on="b", at=VIREV_BACK - 60)
        b = dataclasses.replace(acct("b", five=20, tier="max 5x"),
                                windows=(fresh_window(20, FIVE, VIREV_BACK + 3600, VIREV_BACK - 60),))
        started, logged = self.run_vend(state, [virev_seat(), b], VIREV_BACK)
        [(argv, kw)] = started
        self.assertEqual(argv[-5:], ["refresh", VIREV, "--provider", P, "--json"])
        self.assertTrue(kw["start_new_session"])
        self.assertEqual(kw["stdout"], vending.subprocess.DEVNULL)
        self.assertEqual([kw["accounts"] for e, kw in logged if e == "usage_read"], [["sieun@virev.ai"]])
        again, _ = self.run_vend(state, [virev_seat(), b], VIREV_BACK + 60)
        self.assertEqual(again, [])
        later, _ = self.run_vend(state, [virev_seat(), b], VIREV_BACK + registry.REFRESH_TIMEOUT_SEC + 1)
        self.assertEqual(len(later), 1)


# 2026-10-19 15:29:05Z, what the hook read for tree 01a14210 (high, 8 moves in 24 h) in the
# shortage: its account claude-virev2 was limited until 16:20:00Z, and the old 70% cap, with its
# projection of each read to the next one, held claude-virev5, claude-virev7 and claude-virev11 at
# 41%, 39% and 63%. The reads, admissions and waits are those of a `pi-pool who` read of the tree
# then. The two trees vended on each of those three seats at 15:28:30 are enough for that old
# projection to hold it.
DROUGHT = 1792423745.0
DAY = DROUGHT - (15 * 3600 + 29 * 60 + 5)


def utc(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return DAY + h * 3600 + m * 60 + s


def drought_seat(id, five, read, tier="team 5x", limited_until=0, reset="17:00:00"):
    windows = (fresh_window(five, FIVE, utc(reset), utc(read)), window(50, WEEK, 3 * 86400, now=utc(read)))
    return dataclasses.replace(account(id, f"{id}@slack.green", session_pct=five, weekly_pct=50), tier=tier,
                               windows=windows, limited_until=limited_until)


class Drought1019(unittest.TestCase):
    """R2: an Auto account takes trees up to the vendor limit. The owner on 10-19, to a todo
    about accounts held at 41 to 63%: "Yes, take jobs until near the real limit"."""

    TREE = "01a14210-4e7d-72c3-aa67-e3d476f4e728"

    def pool(self):
        return [drought_seat("claude-virev2", 100, "15:26:35", limited_until=utc("16:20:00"), reset="16:20:00"),
                drought_seat("claude-virev5", 41, "15:21:32"), drought_seat("claude-virev7", 39, "15:22:32"),
                drought_seat("claude-virev11", 63, "15:28:33"), drought_seat("claude-virev9", 16, "15:26:35"),
                drought_seat("claude-virev10", 22, "15:26:35"),
                drought_seat("claude16", 100, "15:26:35", tier="max 20x", limited_until=utc("15:30:00"), reset="15:30:00")]

    def state(self):
        state = empty_state()
        key = put(state, tree_key(self.TREE), on="claude-virev2", at=utc("15:20:00"), priority="high",
                  moves=[DROUGHT - 3 * 3600 * i for i in range(1, 9)])
        for seat in ("claude-virev5", "claude-virev7", "claude-virev11"):
            for i in range(2):
                put(state, tree_key(f"{seat}-{i}"), on=seat, at=utc("15:28:30"))
        admissions = state["providers"][P]["admissions"]
        for seat, tree in (("claude-virev9", "01a154a9"), ("claude-virev10", "01a140fb")):
            put(state, tree_key(tree), on=seat, at=utc("15:28:00"))
            admissions[seat] = [[utc("15:28:00"), tree]]
        for seat, tree, slot in (("claude-virev9", "01a14b76", "15:30:00"), ("claude-virev10", "01a1180e", "15:30:00"),
                                 ("claude16", "01a154a6", "15:30:00"), ("claude16", "01a14d31", "15:30:30"),
                                 ("claude16", "01a14fcc", "15:31:30")):
            put(state, tree_key(tree), at=utc("15:20:00"), priority="high")
            state["sessions"][tree]["wait"] = {P: {"account": seat, "slot_at": utc(slot), "since": utc("15:20:00")}}
        return state, key

    def test_the_head_tree_at_1529z_gets_a_seat_under_the_limit_now(self):
        """The old cap of 70% with its projection gave Wait on claude16 at 15:31:00Z."""
        state, key = self.state()
        d = decide(state, key, self.pool(), now=DROUGHT)
        to = d.account if isinstance(d, sched.Admit) else d.slot_account
        got = (type(d).__name__, to.id, time.strftime("%H:%M:%S", time.gmtime(getattr(d, "slot_at", DROUGHT))))
        self.assertEqual(got[0::2], ("Admit", "15:29:05"), got)
        self.assertIn(to.id, ("claude-virev5", "claude-virev7", "claude-virev11"))
        self.assertEqual((d.reason, d.left), ("switch", ("claude-virev2", "limited")))

    def test_a_seat_admits_on_a_99_percent_read_and_not_at_the_limit(self):
        read = "15:28:05"
        for five, limited_until, why in ((99, 0, None), (100, 0, "depleted"), (40, utc("16:00:00"), "limited")):
            seat = drought_seat("seat", five, read, limited_until=limited_until)
            self.assertEqual(sched.admit_reason(seat, {}, CFG, DROUGHT, "high"), why, five)
            state = empty_state()
            key = put(state, tree_key("new"), at=DROUGHT - 60, priority="high")
            d = decide(state, key, [seat], now=DROUGHT)
            if why is None:
                self.assertEqual((type(d), d.account.id), (sched.Admit, "seat"))
            else:
                self.assertEqual((type(d), d.slot_account.id), (sched.Wait, "seat"), five)



class RefillOpenedCell(unittest.TestCase):
    """10-28 on claude-virev5: 01a18453 went from high to normal at 21:23:27Z, which opened its 21:26:00Z cell. 01a15c6c,
    normal since 21:04:40Z, asked at 21:24:00Z and took it, while 01a11af8, normal since 21:04:11Z, slept until its
    21:44:00Z cell. The first tree in line now gets the wake and the cell; the cell it leaves goes to the next one."""

    def setUp(self):
        vending._wakes.clear()
        self.addCleanup(vending._wakes.clear)

    def test_a_cell_a_demotion_opens_goes_to_the_first_tree_in_line(self):
        state = empty_state()
        x, out = acct("x", five=10, tier="max 5x"), acct("y", five=100, five_reset_in=FIVE)
        sp = sched.slot_spacing(x, CFG)
        cell = math.ceil(NOW / sp) * sp
        demoted = put(state, tree_key("demoted"), on="y", priority="high")
        first = put(state, tree_key("first"), on="y", priority="normal")
        later = put(state, tree_key("later"), on="y", priority="normal")
        state["sessions"]["demoted"]["wait"] = {P: {"account": "x", "slot_at": cell + sp, "since": NOW - 300}}
        state["sessions"]["first"]["wait"] = {P: {"account": "x", "slot_at": cell + 5 * sp, "since": NOW - 1200}}
        state["sessions"]["later"]["wait"] = {P: {"account": "x", "slot_at": cell + 6 * sp, "since": NOW - 1100}}
        state["providers"][P]["admissions"] = {"x": [[NOW, "busy0"], [cell, "busy1"]] + [[cell + n * sp, f"busy{n}"] for n in (2, 3, 4)]}
        vending.IntentWriter(state).set_priority(demoted, "normal", NOW)
        self.assertEqual(vending.refill(state, P, "x", [x, out], CFG, NOW), ["first", "later"])
        self.assertEqual(vending._wakes, [["first", "later"]])
        d = request(state, first, [x, out], NOW + 1)
        self.assertEqual((type(d), d.slot_at), (sched.Wait, cell + sp), "the woken tree takes the opened cell")
        self.assertEqual(vending._wakes[-1], ["later"], "the cell it left opens to the next tree in line")
        d = request(state, later, [x, out], NOW + 2)
        self.assertEqual((type(d), d.slot_at), (sched.Wait, cell + 5 * sp))
        d = request(state, demoted, [x, out], cell + sp)
        self.assertIsInstance(d, sched.Wait, "the demoted tree ranks behind both now")
        self.assertGreater(d.slot_at, cell + 5 * sp)

    def test_a_tree_that_waits_for_another_cell_opens_the_one_it_held(self):
        state = empty_state()
        x, out = acct("x", five=10, tier="max 5x"), acct("y", five=100, five_reset_in=FIVE)
        sp = sched.slot_spacing(x, CFG)
        cell = math.ceil(NOW / sp) * sp
        leaver, first = put(state, tree_key("leaver"), on="y", priority="high"), put(state, tree_key("first"), on="y")
        state["sessions"]["leaver"]["wait"] = {P: {"account": "x", "slot_at": cell + sp, "since": NOW - 300}}
        state["sessions"]["first"]["wait"] = {P: {"account": "x", "slot_at": cell + 3 * sp, "since": NOW - 1200}}
        state["providers"][P]["admissions"] = {"x": [[NOW, "busy0"], [cell, "busy1"], [cell + 2 * sp, "busy2"]]}
        z = acct("z", five=10, tier="max 5x")
        d = request(state, leaver, [x, out, z], NOW + 1)
        self.assertEqual((type(d), d.account.id), (sched.Admit, "z"))
        self.assertEqual(vending._wakes, [["first"]], "the tree entered z ahead of its x cell, which opens to the next tree")

    def test_a_tree_raised_to_high_is_first_in_line_for_an_earlier_cell(self):
        """10-29 on claude-virev10: 01a11d24 parked as normal at 04:02:04Z for 04:24:00Z and went high at 04:02:26Z; high trees
        that parked after it entered from 04:06Z while it slept until its own cell."""
        state = empty_state()
        x, out = acct("x", five=10, tier="max 5x"), acct("y", five=100, five_reset_in=FIVE)
        sp = sched.slot_spacing(x, CFG)
        cell = math.ceil(NOW / sp) * sp
        raised, later = put(state, tree_key("raised"), on="y"), put(state, tree_key("later"), on="y", priority="high")
        state["sessions"]["raised"]["wait"] = {P: {"account": "x", "slot_at": cell + 4 * sp, "since": NOW - 600}}
        state["sessions"]["later"]["wait"] = {P: {"account": "x", "slot_at": cell + sp, "since": NOW - 300}}
        state["providers"][P]["admissions"] = {"x": [[NOW, "busy0"], [cell, "busy1"]]}
        vending.IntentWriter(state).set_priority(raised, "high", NOW)
        self.assertEqual(vending.refill(state, P, "x", [x, out], CFG, NOW)[0], "raised")
        d = request(state, raised, [x, out], NOW + 1)
        self.assertEqual((type(d), d.slot_at), (sched.Wait, cell + sp), "it waited longer, so as high it goes before the later high tree")

    def test_a_tree_in_line_whose_sessions_do_not_answer_passes_the_wake_on(self):
        turns = {"working": {}, "queued": {}, "owner": {}, "lead": [], "kept": {
            "sub-a": {"since": NOW - 900, "slot_at": NOW + 600, "tree": "a"},
            "sub-b": {"since": NOW - 800, "slot_at": NOW + 700, "tree": "b"},
            "gone-b": {"since": NOW - 800, "slot_at": NOW - 5, "tree": "b"}}}
        asked = []
        def run(session):
            asked.append(session)
            return "none" if session == "sub-a" else "timer"
        tried = turns_mod.wake_slot(["a", "b", "c"], run=run, now=NOW, turns=turns)
        self.assertEqual(asked, ["sub-a", "sub-b"], "a kept place whose slot passed is no sleeping session")
        self.assertEqual([t for t, _ in tried], ["a", "b"])

if __name__ == "__main__":
    unittest.main()
