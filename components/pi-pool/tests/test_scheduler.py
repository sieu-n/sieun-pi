"""The admission scheduler (sched.decide, rules R1-R7 in pool/sched.py and the README).
Each test names the rule it guards; it fails when that rule is taken out."""
import collections, contextlib, dataclasses, io, json, math, os, random, tempfile, time, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import CFG, KEY, NOW, account, vend, vend_record
from vend.pool import base, limit_resets, registry, sched, session_cmds, status_view, vending


def setUpModule():
    isolate_test_module()


P = "anthropic"
FIVE, WEEK = 18000, 604800
# The slot tests read their accounts once and admit many trees; R2's projection
# would stop them first.
NO_PROJECTION = dict(CFG, tree_5h_pct_per_min={})


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


@contextlib.contextmanager
def draws(*values, rest=0.5):
    """R5's backoff draws, in order, then `rest` for every later one."""
    seq = iter(values)
    with unittest.mock.patch.object(sched.random, "random", side_effect=lambda: next(seq, rest)):
        yield


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


class R2AdmitCap(unittest.TestCase):
    def test_no_move_into_an_account_at_70_percent(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100), acct("hot", five=CFG["admit_5h_max_pct"], five_reset_in=1800)]
        with draws(0.0):
            d = request(state, KEY, accounts, NOW)
        self.assertEqual((type(d), d.slot_account.id, d.backoff), (sched.Wait, "hot", True))
        self.assertEqual(request(state, KEY, [acct("x", five=100), fresh("hot", 0, FIVE, NOW + 5)], NOW + 5).account.id, "hot")

    def test_no_new_tree_into_an_account_at_70_percent(self):
        state = empty_state()
        new = tree_key("new")
        d = decide(state, new, [acct("hot", five=75)])
        self.assertIsInstance(d, sched.Wait)

    def test_a_pin_into_an_account_at_70_percent_waits(self):
        state = empty_state()
        put(state, KEY, on="a", at=NOW - 60)
        state["sessions"][KEY.key]["pins"] = {P: {"account_id": "hot", "at": NOW, "by": "cli"}}
        d = decide(state, KEY, [acct("a", five=20), acct("hot", five=72)])
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(d.slot_account.id, "hot")
        self.assertIsNone(d.vend)


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
        admitted = run_until_admitted(state, keys, lambda at: self.accounts(), NOW, cfg=NO_PROJECTION)
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
            with draws(0.0):
                d = limited(state, k, accounts_at(NOW + i), NOW + i, reset)
            self.assertEqual((type(d), d.backoff), (sched.Wait, True))
        # Every draw is 0, so every waiter asks again each second: the worst case for R4.
        with draws(rest=0.0):
            admitted = run_until_admitted(state, keys, accounts_at, NOW + 20, cfg=NO_PROJECTION)
        self.assertEqual(len(admitted), 15)
        self.assertGreaterEqual(admitted[0][0], reset)
        self.assertLessEqual(max(per_bucket(admitted, "x").values()), 4)
        self.assertGreater(admitted[-1][0] - admitted[0][0], 3 * CFG["admit_slot_sec"])


class R5Wait(unittest.TestCase):
    def test_no_admissible_account_means_a_wait_never_a_hop_onto_a_depleted_one(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        accounts = [acct("x", five=100, five_reset_in=3000), acct("y", five=85, five_reset_in=1200),
                    acct("z", five=99, five_reset_in=7000)]
        with draws(1200 / CFG["depleted_backoff_max_sec"]):
            d = limited(state, KEY, accounts, NOW, NOW + 3000)
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(session_cmds.next_fields(d), {"next": None, "retry_at": math.ceil(d.slot_at)})
        self.assertEqual((d.slot_account.id, d.slot_at, d.backoff), ("y", NOW + 1200, True))
        self.assertEqual(state["sessions"][KEY.key]["wait"][P]["slot_at"], NOW + 1200)
        again = request(state, KEY, registry.with_pool_state(accounts, state, P), NOW + 5)
        self.assertEqual((type(again), again.vend.id, again.slot_at), (sched.Wait, "x", NOW + 1200))
        later = [acct("x", five=100, five_reset_in=1800), acct("y", five=0, five_reset_in=FIVE),
                 acct("z", five=99, five_reset_in=5800)]
        d = request(state, KEY, registry.with_pool_state(later, state, P), NOW + 1200)
        self.assertEqual((type(d), d.account.id, d.reason), (sched.Admit, "y", "switch"))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_tree_that_backs_off_for_its_own_account_comes_back_once_it_serves_again(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        with draws(0.5):
            d = limited(state, KEY, [acct("x", five=100, five_reset_in=600)], NOW, NOW + 600)
        self.assertEqual((d.slot_account.id, d.slot_at), ("x", NOW + CFG["depleted_backoff_max_sec"] / 2))
        still = request(state, KEY, [acct("x", five=100, five_reset_in=300)], NOW + 300)
        self.assertEqual((type(still), still.slot_at, still.backoff), (sched.Wait, d.slot_at, True))
        back = request(state, KEY, [fresh("x", 0, FIVE, NOW + 600)], NOW + 600)
        self.assertEqual((type(back), back.account.id, back.reason), (sched.Admit, "x", "back"))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_backoff_drawn_on_a_depleted_pool_ends_when_another_account_takes_trees_1018(self):
        """10-18: 01a14eaf, a high tree, backed off at 15:10:36Z to 16:45:25Z with its
        draw named on the Virev seat. claude12, its own account, was limited until
        15:50Z, and from then claude12, krenerd77 and claude3 took new trees, while
        every check-in restart until 16:04Z met "waits for its slot at 16:45:26"."""
        state = empty_state()
        put(state, KEY, on="c12", at=NOW - 60, priority="high")
        out = [acct("c12", five=100, five_reset_in=2400, limited_until=NOW + 2400),
               acct("kr", five=100, five_reset_in=3000), acct("virev", five=100, five_reset_in=5000, tier="team")]
        with draws(5689 / CFG["depleted_backoff_max_sec"]):
            d = limited(state, KEY, out, NOW, NOW + 2400)
        self.assertEqual((type(d), d.backoff, d.slot_at), (sched.Wait, True, NOW + 5689))
        later = NOW + 2400 + 840
        revived = [fresh("c12", 3, FIVE, later - 300), fresh("kr", 12, FIVE, later - 300),
                   dataclasses.replace(acct("virev", five=100, five_reset_in=5000 - 3240, tier="team"))]
        back = request(state, KEY, revived, later)
        self.assertEqual((type(back), back.account.id in ("c12", "kr")), (sched.Admit, True))
        self.assertNotIn(P, state["sessions"][KEY.key].get("wait", {}))

    def test_a_backoff_held_on_a_pool_that_still_waits_for_rotation_keeps_its_draw(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60, priority="high")
        with draws(0.75):
            d = limited(state, KEY, [acct("x", five=100, five_reset_in=600), acct("y", five=90)], NOW, NOW + 600)
        again = request(state, KEY, [acct("x", five=80, five_reset_in=600), acct("y", five=90)], NOW + 900)
        self.assertEqual((type(again), again.slot_at, again.backoff), (sched.Wait, d.slot_at, True))

    def test_a_waiter_whose_account_serves_before_its_slot_gets_no_token(self):
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60)
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 900, "since": NOW - 10}}
        busy = put(state, tree_key("busy"), on="z")
        state["providers"][P]["admissions"] = {"x": [[NOW, busy.key]]}
        d = decide(state, KEY, [acct("x", five=60, tier="max 5x"), acct("y", five=80, five_reset_in=900)])
        self.assertIsInstance(d, sched.Wait)
        self.assertIsNone(d.vend)



class R5Backoff(unittest.TestCase):
    """The owner on 10-18: "when 5h limit ends, but next accounts revive like 2 minute at
    a time, everybody rushes to first thread, cache-write tokens deplete it in 1 second
    -> prevent that with super long random backoff on depleted". Before R4 the Mac log
    shows it: 10-10 20:59:59 claude9 took 27 trees in 10 s and answered 429 44 s later."""

    ACCOUNTS, TREES, SAMPLE_SEC, WORK_MIN = 8, 100, 120, 20
    # A tree's first request on an account writes its whole prompt cache, and a busy
    # tree spends 3.5 times the max 20x rate the pool assumes before it has a rate of
    # its own, so accounts do run dry.
    ENTRY_PCT, SPEND_PER_MIN = 3.0, 1.0

    def simulate(self, seed):
        rng = random.Random(seed)
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
        with unittest.mock.patch.object(sched.random, "random", side_effect=rng.random):
            for i, k in enumerate(keys):
                d = limited(state, k, view(NOW + i * 0.1), NOW + i * 0.1, reset[names[i % self.ACCOUNTS]])
                self.assertEqual((type(d), d.backoff), (sched.Wait, True))
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
        for seed in (1, 2, 3):
            revived, drained, first_token, entries = self.simulate(seed)
            self.assertEqual(len(first_token), self.TREES, seed)
            for a, ups in revived.items():
                for up in ups:
                    down = [t for t in drained[a] if t >= up]
                    if down:
                        self.assertGreaterEqual(down[0] - up, 60, (seed, a, up))
            per_window = collections.Counter((a, int(at // CFG["admit_slot_sec"])) for at, a in entries)
            self.assertLessEqual(max(per_window.values()), 4, seed)
            first_minute = [sum(1 for at, b in entries if b == a and up <= at < up + 60)
                            for a, ups in revived.items() for up in ups]
            # R4's 30 s cells of a max 20x account: at most 3 entries start in any minute.
            self.assertLessEqual(max(first_minute), 3, seed)

    def test_a_backoff_is_a_fresh_draw_over_the_whole_window(self):
        state = empty_state()
        accounts = [acct("x", five=100, five_reset_in=600, limited_until=NOW + 600)]
        slots = []
        for i in range(200):
            k = put(state, tree_key(f"w{i:03d}"), on="x", at=NOW - 60)
            slots.append(limited(state, k, accounts, NOW, NOW + 600).slot_at - NOW)
        top = CFG["depleted_backoff_max_sec"]
        self.assertEqual(top, 7200)
        self.assertTrue(all(0 <= s < top for s in slots))
        quarters = collections.Counter(int(s // (top / 4)) for s in slots)
        self.assertEqual(sorted(quarters), [0, 1, 2, 3])
        self.assertGreater(min(quarters.values()), 25)
        self.assertGreater(len(set(round(s) for s in slots)), 190)

    def test_a_projection_hold_with_accounts_free_on_their_read_is_no_backoff(self):
        """10-18 11:10Z: two new low trees backed off 40 and 100 min while claude4 and
        claude12 read 3% and 4%, because the projection of their spending trees held them."""
        state = empty_state()
        accounts = [fresh("c4", 3, FIVE, NOW - 600, tier="max 5x"), fresh("c12", 4, FIVE, NOW - 600, tier="max 5x")]
        for i in range(40):
            put(state, tree_key(f"busy{i:02d}"), on=("c4", "c12")[i % 2], at=NOW - 30)
        k = put(state, tree_key("new"), at=NOW - 60, priority="low")
        d = request(state, k, accounts, NOW)
        self.assertEqual((type(d), d.backoff), (sched.Wait, False))
        self.assertLessEqual(d.slot_at, NOW + registry.STALE_USAGE_SEC + registry.REFRESH_TIMEOUT_SEC)

    def test_a_high_tree_backs_off_like_any_other(self):
        """The owner on 10-18, asked whether his own turns skip the backoff: "no don't"."""
        state = empty_state()
        put(state, KEY, on="x", at=NOW - 60, priority="high")
        with draws(0.9):
            d = limited(state, KEY, [acct("x", five=100, five_reset_in=600)], NOW, NOW + 600)
        self.assertEqual((d.backoff, d.slot_at), (True, NOW + 0.9 * CFG["depleted_backoff_max_sec"]))

class R6MoveBudget(unittest.TestCase):
    ACCOUNTS = [acct("x", five=100, five_reset_in=1800), acct("y", five=5)]

    def test_a_normal_tree_out_of_moves_waits_for_its_own_account(self):
        state = empty_state()
        put(state, KEY, on="x", moves=[NOW - 3600 * h for h in (1, 2, 3)])
        d = decide(state, KEY, self.ACCOUNTS)
        self.assertEqual((type(d), d.slot_account.id, d.slot_at, d.backoff), (sched.Wait, "x", NOW + 1800, False))

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
        accounts = [acct("x", five=0, tier="max 5x")]
        self.assertIsInstance(request(state, tree_key("first"), accounts, NOW, cfg=NO_PROJECTION), sched.Admit)
        n = put(state, tree_key("n"), at=NOW - 60)
        h = put(state, tree_key("h"), at=NOW - 60, priority="high")
        dn = request(state, n, accounts, NOW + 1, cfg=NO_PROJECTION)
        dh = request(state, h, accounts, NOW + 5, cfg=NO_PROJECTION)
        self.assertEqual((dn.backoff, dh.backoff), (False, False))
        self.assertEqual(dh.slot_at, dn.slot_at)
        self.assertIsInstance(decide(state, n, accounts, now=dn.slot_at, cfg=NO_PROJECTION), sched.Wait)


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
        d = request(state, KEY, [acct("a", five=20), acct("b", five=80)], NOW)
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
        with draws(900 / CFG["depleted_backoff_max_sec"]):
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
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 1500, "since": NOW}}
        state["providers"][P]["admissions"] = {"y": [[NOW, put(state, tree_key("busy"), on="y").key]]}
        accounts = [acct("x", five=100), acct("y", five=40, tier="max 5x")]
        _, out, _ = self.run_cli(state, accounts, ["who", "--json"])
        who = json.loads(out)
        self.assertEqual((who["priority"], who["providers"][P]["wait"]), ("low", {"account": "y", "slot_at": round(NOW + 1500)}))
        _, out, _ = self.run_cli(state, accounts, ["ls", "--json"])
        ls = json.loads(out)
        self.assertEqual((ls["priority"], ls["wait"]), ("low", {"account": "y", "slot_at": round(NOW + 1500)}))
        self.assertNotIn("force", ls["rows"][0])
        rc, out, _ = self.run_cli(state, accounts, ["ls"])
        self.assertEqual(rc, 0)
        self.assertIn("priority low  waits for y", out)

    def test_who_shows_no_wait_when_the_next_request_gets_an_account_1018(self):
        """10-18 16:21Z: `who` printed 01a14eb4's backoff to 16:47Z on the Virev seat
        while its next request would have entered claude4."""
        state = empty_state()
        put(state, KEY, on="x", priority="high")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 1500, "since": NOW - 600, "backoff": True}}
        _, out, _ = self.run_cli(state, [acct("x", five=100, limited_until=NOW + 600), acct("y", five=100), acct("z", five=5)], ["who", "--json"])
        who = json.loads(out)["providers"][P]
        self.assertEqual((who["wait"], who["label"]), (None, "z@x"))

    def test_ls_counts_a_tree_that_backs_off_on_an_account_as_waiting_for_it(self):
        """10-18 16:04Z: 01a14eaf backed off to 16:45Z on the Virev seat while every
        row of `pi-pool ls --json` read waiting 0."""
        state = empty_state()
        put(state, KEY, on="x")
        cell, backoff = put(state, tree_key("cell"), on="x"), put(state, tree_key("backoff"), on="x")
        state["sessions"][cell.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 120, "since": NOW}}
        state["sessions"][backoff.key]["wait"] = {P: {"account": "y", "slot_at": NOW + 2400, "since": NOW, "backoff": True}}
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

    def test_a_refused_request_logs_parked_with_the_accounts_that_take_its_class(self):
        state = empty_state()
        put(state, KEY, on="b")
        logged, _ = self.run_vend(state, [acct("a", five=90), acct("b", five=100)])
        [parked] = [kw for e, kw in logged if e == "parked"]
        self.assertEqual((parked["session"], parked["room"], parked["at"]), (KEY.key, [], NOW))
        state["sessions"][KEY.key]["wait"] = {P: {"account": "c", "slot_at": NOW + 600, "since": NOW}}
        state["providers"][P]["admissions"] = {"c": [[NOW, "busy"]]}
        logged, _ = self.run_vend(state, [acct("b", five=100), acct("c", five=30, tier="max 5x")])
        self.assertEqual([kw["room"] for e, kw in logged if e == "parked"], [["c@x"]])

    def test_a_refusal_by_the_move_budget_or_a_projection_logs_no_room(self):
        # 01a11a24 on 10-18: a low tree out of moves (R6) parked on claude9 from 16:50Z to 17:21Z for slots at claude9's next
        # read, as R2 projected claude9 past the low cap, and every parked line named claude9, krenerd77 and three more as room.
        state = empty_state()
        put(state, KEY, on="x", priority="low", moves=[NOW - 60])
        logged, _ = self.run_vend(state, [acct("x", five=100, five_reset_in=1800), acct("y", five=5)])
        self.assertEqual([kw["room"] for e, kw in logged if e == "parked"], [[]])
        state = empty_state()
        put(state, KEY, on="b", priority="low")
        logged, _ = self.run_vend(state, [acct("p", five=40, tier="max 5x"), acct("b", five=100)])
        self.assertEqual([kw["room"] for e, kw in logged if e == "parked"], [[]])

    def test_a_tree_that_waited_logs_unparked_when_it_gets_an_account(self):
        state = empty_state()
        put(state, KEY, on="b")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "a", "slot_at": NOW - 5, "since": NOW - 900}}
        logged, out = self.run_vend(state, [acct("a", five=10), acct("b", five=100)])
        self.assertEqual((out, [kw["account"] for e, kw in logged if e == "unparked"]), ("fixture-token", ["a@x"]))

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


# What one Virev tree spent per minute on 10-13 22:40-23:04: 100% over 144 tree-minutes
# (9 trees, each counted while it sent a request within 15 min; pi-pool.log vends and
# the trees' transcripts).
VIREV_1013_PCT_PER_TREE_MIN = 100 / 144


class ProjectedUsage(unittest.TestCase):
    """R2: the 5h figure an account is admitted on is projected to its next read."""

    def replay_1013(self, cfg):
        """The nine trees ask for the seat at their 10-13 slots, a tree on it sends a
        request every minute, and the seat is read every STALE_USAGE_SEC. Returns the
        trees admitted and the seat's true 5h % at each read."""
        state = empty_state()
        keys = [put(state, tree_key(name), on=VIREV, at=VIREV_BACK - 3 * 3600) for name in VIREV_TREES]
        for i, key in enumerate(keys):
            state["sessions"][key.key]["wait"] = {P: {"account": VIREV, "slot_at": VIREV_BACK + 120 * i, "since": VIREV_BACK - 3600}}
        other = acct("claude10", five=100, five_reset_in=1200, week=80, tier="max 5x")
        admitted, reads = {}, []

        def truth(t):
            return VIREV_1013_PCT_PER_TREE_MIN * sum(t - at for at in admitted.values()) / 60

        due = {k.key: VIREV_BACK + 120 * i for i, k in enumerate(keys)}
        by_key = {k.key: k for k in keys}
        read_every = registry.STALE_USAGE_SEC
        end = VIREV_BACK + 2 * read_every
        read_at = None
        while True:
            name, now = min(due.items(), key=lambda kv: (kv[1], kv[0]))
            if now >= end:
                break
            last = VIREV_BACK + (now - VIREV_BACK) // read_every * read_every
            if last != read_at:
                read_at = last
                reads.append(truth(read_at))
            seat = virev_seat((fresh_window(reads[-1], FIVE, VIREV_BACK + FIVE, read_at), VIREV_WINDOWS[1]))
            d = request(state, by_key[name], [seat, dataclasses.replace(other, limited_until=now + 1200)], now, cfg)
            if isinstance(d, (sched.Admit, sched.Stay)) and d.account.id == VIREV:
                admitted.setdefault(name, now)
                due[name] = now + 60
            else:
                due[name] = max(d.slot_at, now + 1) if isinstance(d, sched.Wait) else now + 60
        return admitted, reads

    def test_virev_seat_1013_read_every_20_min_stays_under_the_admit_cap(self):
        admitted, reads = self.replay_1013(CFG)
        self.assertEqual(len(reads), 2)
        self.assertLess(max(reads), CFG["admit_5h_max_pct"], reads)
        self.assertLess(len(admitted), len(VIREV_TREES))
        unprojected, unprojected_reads = self.replay_1013(NO_PROJECTION)
        self.assertEqual(len(unprojected), len(VIREV_TREES))
        self.assertGreaterEqual(unprojected_reads[1], CFG["admit_5h_max_pct"])

    def test_a_tree_waits_for_the_read_after_the_projection_reaches_the_cap(self):
        read = VIREV_BACK - 60
        seat = virev_seat((fresh_window(60, FIVE, VIREV_BACK + FIVE, read), VIREV_WINDOWS[1]))
        state = empty_state()
        put(state, tree_key("on"), on=VIREV, at=VIREV_BACK - 30)
        d = request(state, tree_key("new"), [seat], VIREV_BACK)
        self.assertEqual((type(d), d.backoff), (sched.Wait, False))
        self.assertEqual(d.slot_at, read + registry.STALE_USAGE_SEC + registry.REFRESH_TIMEOUT_SEC)


LIVE_1014 = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_1014_reads.json")))


class OwnRate(unittest.TestCase):
    """R2: an account's projection uses its own rate from its last two reads."""

    def replay_live(self, name, tier, track=True):
        """The live hour of 10-14 04:21 to 05:20 for one account: its reads and the
        trees spending on it each minute, as pi-pool saw them. Returns, per minute
        the account passed every other R2 check, (read %, own rate or None, whether
        a new tree was held by the projection)."""
        start = 1791925263.0
        state, keys, out = empty_state(), [tree_key(f"s{i:02d}") for i in range(20)], []
        for sec, pct, sampled, spending in LIVE_1014[name]:
            now = start + sec
            for i, key in enumerate(keys):
                put(state, key, on=name, at=now - 30 if i < spending else now - 7200)
            five = fresh_window(pct, FIVE, start + 4 * 3600, start + sampled)
            seat = dataclasses.replace(acct(name, tier=tier), session_pct=pct, windows=(five, window(20, WEEK, 3 * 86400, now)))
            if track:
                vending.HookWriter(state).track_reads(P, [seat], sched.in_use_counts(state, P, now, CFG["spending_tree_sec"]), now)
            if sched.admit_reason(seat, {}, CFG, now) is not None:
                continue
            book = sched.book_for(state, P, tree_key("probe"), CFG, now)
            d = decide(state, tree_key("probe"), [seat], now)
            out.append((pct, book.rates.get(name), isinstance(d, sched.Wait)))
        return out

    def test_the_live_hour_holds_neither_the_seat_nor_claude10_once_each_has_its_own_rate(self):
        for name, tier, kind in (("virev_team", "team 5x", "team"), ("claude10_max5x", "max 5x", "max 5x")):
            minutes = self.replay_live(name, tier)
            own = [(pct, rate, held) for pct, rate, held in minutes if rate is not None]
            self.assertGreater(len(own), 20, name)
            self.assertEqual([m for m in own if m[2]], [], name)
            self.assertTrue(any(25 <= pct <= 35 for pct, _, _ in own), name)
            self.assertLess(max(rate for _, rate, _ in own), CFG["tree_5h_pct_per_min"][kind] / 2, name)
            kind_only = self.replay_live(name, tier, track=False)
            self.assertGreater(sum(held for pct, _, held in kind_only if 25 <= pct <= 35), 0, name)

    def test_a_window_reset_drops_the_reads_before_it(self):
        state, now = empty_state(), VIREV_BACK
        writer = vending.HookWriter(state)
        for at, pct, reset in ((now, 10, now + 3600), (now + 1200, 40, now + 3600), (now + 4000, 2, now + 4000 + FIVE)):
            seat = dataclasses.replace(acct("seat", tier="team 5x"), windows=(fresh_window(pct, FIVE, reset, at),))
            writer.track_reads(P, [seat], {"seat": 2}, at)
            if pct == 40:
                self.assertAlmostEqual(sched.book_for(state, P, None, CFG, at).rates["seat"], 31 / 40)
        self.assertNotIn("seat", sched.book_for(state, P, None, CFG, now + 4000).rates)


if __name__ == "__main__":
    unittest.main()
