"""The admission scheduler (sched.decide, rules R1-R7 in pool/sched.py and the README).
Each test names the rule it guards; it fails when that rule is taken out."""
import collections, contextlib, dataclasses, io, json, math, os, tempfile, time, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import CFG, KEY, NOW, account, vend, vend_record
from vend.pool import base, limit_resets, registry, sched, session_cmds, status_view, vending


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
    return session_cmds.plan_next(state, key, P, accounts, cfg, now)


def decide(state, key, accounts, now=NOW, cooldowns=None, cfg=CFG):
    return sched.decide(sched.tree_for(state, key, P), registry.with_pool_state(accounts, state, P),
                        sched.book_for(state, P, key, cfg, now), cooldowns or {}, cfg, now)


def run_until_admitted(state, keys, accounts_at, start, horizon=6 * 3600):
    """Drive each waiting tree at its own slot, as Prime's wait-for-usage does,
    until every tree is admitted. Returns [(at, key, account id)] in order."""
    due = {k.key: start for k in keys}
    by_key = {k.key: k for k in keys}
    admitted = []
    while due:
        name, at = min(due.items(), key=lambda kv: (kv[1], kv[0]))
        assert at < start + horizon, (name, at)
        d = request(state, by_key[name], accounts_at(at), at)
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


class R2AdmitCap(unittest.TestCase):
    def test_no_move_into_an_account_at_70_percent(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100), acct("hot", five=CFG["admit_5h_max_pct"], five_reset_in=1800)]
        d = request(state, KEY, accounts, NOW)
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(d.slot_account.id, "hot")
        self.assertGreaterEqual(d.slot_at, NOW + 1800)

    def test_no_new_tree_into_an_account_at_70_percent(self):
        state = empty_state()
        new = tree_key("new")
        d = decide(state, new, [acct("hot", five=75)])
        self.assertIsInstance(d, sched.Wait)

    def test_a_pin_into_an_account_at_70_percent_yields(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "hot", "at": NOW, "by": "cli"}}
        d = decide(state, KEY, [acct("a", five=20), acct("hot", five=72)])
        self.assertEqual((type(d), d.account.id, d.shadowed), (sched.Stay, "a", ("hot", "depleted")))


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

    def test_a_reset_admits_fifteen_waiters_at_slot_pace_high_first(self):
        state = empty_state()
        reset = NOW + 600

        def accounts_at(at):
            if at < reset:
                return [acct("x", five=100, five_reset_in=reset - at, limited_until=reset)]
            return [acct("x", five=0, five_reset_in=FIVE)]

        keys = []
        for i in range(15):
            prio = "high" if i % 3 == 2 else "normal"
            k = put(state, tree_key(f"w{i:02d}"), on="x", at=NOW - 60, priority=prio)
            keys.append(k)
            d = limited(state, k, accounts_at(NOW + i), NOW + i, reset)
            self.assertIsInstance(d, sched.Wait)
            self.assertGreaterEqual(d.slot_at, reset)
        admitted = run_until_admitted(state, keys, accounts_at, NOW + 20)
        self.assertEqual(len(admitted), 15)
        self.assertLessEqual(max(per_bucket(admitted, "x").values()), 4)
        self.assertGreater(admitted[-1][0] - admitted[0][0], 3 * CFG["admit_slot_sec"])
        prio = {k.key: state["sessions"][k.key]["priority"] for k in keys}
        order = [prio[name] for _, name, _ in admitted]
        self.assertEqual(order[:5], ["high"] * 5, order)


class R5Wait(unittest.TestCase):
    def test_no_admissible_account_means_a_wait_never_a_hop_onto_a_depleted_one(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100, five_reset_in=3000), acct("y", five=85, five_reset_in=1200),
                    acct("z", five=99, five_reset_in=7000)]
        d = limited(state, KEY, accounts, NOW, NOW + 3000)
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(session_cmds.next_fields(d), {"next": None, "retry_at": math.ceil(d.slot_at)})
        self.assertEqual((d.slot_account.id, d.slot_at), ("y", NOW + 1200))
        self.assertEqual(state["sessions"][KEY.key]["wait"][P]["slot_at"], NOW + 1200)
        again = request(state, KEY, registry.with_pool_state(accounts, state, P), NOW + 5)
        self.assertEqual((type(again), again.vend.id), (sched.Wait, "x"))
        later = [acct("x", five=100, five_reset_in=1800), acct("y", five=0, five_reset_in=FIVE),
                 acct("z", five=99, five_reset_in=5800)]
        d = request(state, KEY, registry.with_pool_state(later, state, P), NOW + 1200)
        self.assertEqual((type(d), d.account.id, d.reason), (sched.Admit, "y", "switch"))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_tree_that_waits_for_its_own_account_comes_back_at_its_slot(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        d = limited(state, KEY, [acct("x", five=100, five_reset_in=600)], NOW, NOW + 600)
        self.assertEqual((d.slot_account.id, d.slot_at), ("x", NOW + 600))
        back = request(state, KEY, [acct("x", five=0, five_reset_in=FIVE)], NOW + 600)
        self.assertEqual((type(back), back.account.id, back.reason), (sched.Admit, "x", "back"))

    def test_a_waiter_whose_account_serves_before_its_slot_gets_no_token(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 900, "since": NOW - 10}}
        busy = put(state, tree_key("busy"), on="z")
        state["providers"][P]["admissions"] = {"x": [[NOW, busy.key]]}
        d = decide(state, KEY, [acct("x", five=60, tier="max 5x"), acct("y", five=80, five_reset_in=900)])
        self.assertIsInstance(d, sched.Wait)
        self.assertIsNone(d.vend)


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
        accounts = [acct("x", five=100, five_reset_in=600, tier="max 5x")]
        n = put(state, tree_key("n"), on="x", at=NOW - 60)
        h = put(state, tree_key("h"), on="x", at=NOW - 60, priority="high")
        dn = limited(state, n, accounts, NOW, NOW + 600)
        dh = limited(state, h, accounts, NOW + 5, NOW + 600)
        self.assertEqual(dh.slot_at, dn.slot_at)
        self.assertIsInstance(decide(state, n, [acct("x", five=0, tier="max 5x")], now=dn.slot_at), sched.Wait)


class Pins(unittest.TestCase):
    def test_a_pin_applies_once_on_the_next_request(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 30, "by": "cli"}}
        d = request(state, KEY, [acct("a", five=20), acct("b", five=10)], NOW)
        self.assertEqual((d.account.id, d.reason), ("b", "session_pin"))

    def test_a_pin_that_yielded_does_not_pull_a_warm_tree_back(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "b", "at": NOW - 30, "by": "cli"}}
        d = request(state, KEY, [acct("a", five=20), acct("b", five=80)], NOW)
        self.assertEqual((d.account.id, d.shadowed), ("a", ("b", "depleted")))
        d = request(state, KEY, [acct("a", five=20), acct("b", five=0)], NOW + 600)
        self.assertEqual((type(d), d.account.id), (sched.Stay, "a"))

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
    def test_recovery_pins_old_pins_and_recovery_batches_are_dropped_on_load(self):
        raw = empty_state()
        raw["providers"][P]["recovery_batches"] = [{"id": 1}]
        raw["sessions"] = {
            "r": {"pins": {P: {"account_id": "a", "at": NOW, "by": "recovery:b3:2"}}, "last_seen": NOW},
            "o": {"pins": {P: {"account_id": "a", "at": NOW - 8 * 86400, "by": "cli"}}, "last_seen": NOW},
            "k": {"pins": {P: {"account_id": "a", "at": NOW - 3600, "by": "cli", "force": True}}, "last_seen": NOW}}
        out = registry.migrate(raw, {}, NOW, CFG["pin_ttl_sec"])
        self.assertNotIn("recovery_batches", out["providers"][P])
        self.assertEqual(out["sessions"]["r"]["pins"], {})
        self.assertEqual(out["sessions"]["o"]["pins"], {})
        self.assertEqual(out["sessions"]["k"]["pins"][P], {"account_id": "a", "at": NOW - 3600, "by": "cli"})
        self.assertEqual(registry.migrate(json.loads(json.dumps(out)), {}, NOW, CFG["pin_ttl_sec"]), out)

    def test_prune_drops_old_admissions_moves_and_stale_waits(self):
        state = empty_state()
        put(state, KEY, on="a", moves=[NOW - 2 * 86400, NOW - 60])
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": NOW - 2 * sched.WAIT_STALE_SEC, "since": NOW}}
        state["providers"][P]["admissions"] = {"a": [[NOW - 2 * sched.ADMISSION_KEEP_SEC, "x"], [NOW - 5, "y"]]}
        self.assertTrue(vending.HookWriter(state).prune(CFG, NOW))
        rec = state["sessions"][KEY.key]
        self.assertEqual((rec["moves"][P], rec["wait"]), ([NOW - 60], {}))
        self.assertEqual(state["providers"][P]["admissions"], {"a": [[NOW - 5, "y"]]})
        self.assertFalse(vending.HookWriter(state).prune(CFG, NOW))


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
        accounts = [acct("x", five=100, five_reset_in=3000), acct("y", five=90, five_reset_in=900)]
        rc, out, saved = self.run_cli(state, accounts, ["limited", "--until", str(NOW + 3000)])
        reply = json.loads(out)
        self.assertEqual((rc, reply["next"], reply["retry_at"]), (0, None, round(NOW + 900)))
        self.assertEqual(saved["sessions"][KEY.key]["wait"][P]["account"], "y")

    def test_limited_names_the_next_account_when_one_takes_the_tree(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        rc, out, _ = self.run_cli(state, [acct("x", five=100), acct("y", five=10)], ["limited", "--until", str(NOW + 3000)])
        self.assertEqual(json.loads(out), {"account": "x@x", "until": round(NOW + 3000), "next": "y@x", "retry_at": None})

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
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 300, "since": NOW}}
        accounts = [acct("x", five=100), acct("y", five=60)]
        _, out, _ = self.run_cli(state, accounts, ["who", "--json"])
        who = json.loads(out)
        self.assertEqual((who["priority"], who["providers"][P]["wait"]), ("low", {"account": "y", "slot_at": round(NOW + 300)}))
        _, out, _ = self.run_cli(state, accounts, ["ls", "--json"])
        ls = json.loads(out)
        self.assertEqual((ls["priority"], ls["wait"]), ("low", {"account": "y", "slot_at": round(NOW + 300)}))
        self.assertNotIn("force", ls["rows"][0])

    def test_use_force_is_gone(self):
        state = empty_state()
        put(state, KEY, on="x")
        rc, out, saved = self.run_cli(state, [acct("x"), acct("y")], ["use", "y@x", "--force"])
        self.assertEqual((rc, saved["sessions"][KEY.key]["pins"]), (2, {}))

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
            stack.enter_context(unittest.mock.patch.object(base, "anthropic_refusal", return_value=None))
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
        logged, out = self.run_vend(state, [acct("a", five=90), acct("b", five=100)])
        self.assertEqual(out, "fixture-token")
        self.assertEqual([e for e, _ in logged if e in ("wait", "switch")], ["wait"])

    def test_a_waiting_tree_with_no_refused_account_gets_no_token(self):
        state = empty_state()
        put(state, KEY, on="b")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": NOW + 600, "since": NOW}}
        state["providers"][P]["admissions"] = {"b": [[NOW, "busy"]]}
        with self.assertRaises(SystemExit):
            self.run_vend(state, [acct("a", five=90, five_reset_in=600), acct("b", five=30, tier="max 5x")])

    def test_switches_today_counts_switch_lines_per_provider(self):
        day = time.strftime("%Y-%m-%d", time.localtime(NOW))
        before = time.strftime("%Y-%m-%d", time.localtime(NOW - 86400))
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


if __name__ == "__main__":
    unittest.main()
