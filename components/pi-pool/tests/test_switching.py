"""Each session keeps its own account while it is usable, and a switch is one
weighted random draw by runway (vend.resolve, vend.switch_weights)."""
import collections, contextlib, dataclasses, io, json, os, random, tempfile, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import CFG, KEY, NOW, account, state_v2, vend, vend_record


def setUpModule():
    isolate_test_module()


OTHER = vend.SessionKey("01a1-uuid", "01a1-uuid", "0000aaaa0000")


def window(pct, secs, reset_in):
    return {"usedPercentage": pct, "windowSeconds": secs, "resetsAt": (NOW + reset_in) * 1000,
            "sampledAt": NOW * 1000}


def windowed(id, five, five_reset_in, week=10, week_reset_in=3 * 86400):
    return dataclasses.replace(account(id, f"{id}@x", session_pct=five, weekly_pct=week),
                               windows=(window(five, 18000, five_reset_in), window(week, 604800, week_reset_in)))


def two_sessions(current, other):
    state = state_v2(current=current)
    state["sessions"][OTHER.key] = {"uuid": OTHER.uuid, "active_id": OTHER.active_id, "pins": {},
                                    "vends": {"anthropic": vend_record(other)}, "last_seen": NOW}
    return state


def resolve_for(state, key, accounts, seed=3, cooldowns=None):
    return vend.resolve(vend.intent_for(state, key, "anthropic"), accounts,
                        vend.in_use_counts(state, "anthropic", NOW, 3600), cooldowns or {}, CFG, NOW,
                        random.Random(seed))


class Stickiness(unittest.TestCase):
    ACCOUNTS = [account("a", "a@x", session_pct=10), account("b", "b@x", session_pct=40),
                account("c", "c@x", session_pct=20)]

    def test_a_session_stays_when_another_session_moves(self):
        state = two_sessions(current="b", other="b")
        state["sessions"][OTHER.key]["leave"] = {"anthropic": {"account_id": "b", "at": NOW}}
        moved = resolve_for(state, OTHER, self.ACCOUNTS)
        self.assertEqual((moved.reason, moved.left), ("switch", ("b", "asked")))
        vend.HookWriter(state).record_vend(OTHER, "anthropic", moved.account, "store", moved.reason,
                                           None, NOW, (1, "s"))
        mine = resolve_for(state, KEY, self.ACCOUNTS)
        self.assertEqual((mine.account.id, mine.reason), ("b", "stay"))

    def test_a_session_stays_while_its_account_is_usable_whatever_the_weights(self):
        busy = windowed("b", 80, 4 * 3600)
        state = two_sessions(current="b", other="b")
        for seed in range(200):
            r = resolve_for(state, KEY, [busy, windowed("a", 0, 5 * 3600)], seed=seed)
            self.assertEqual((r.account.id, r.reason), ("b", "stay"), seed)

    def test_crossing_the_five_hour_cutoff_switches_once(self):
        state = state_v2(current="b")
        crossed = [windowed("a", 5, 5 * 3600), windowed("b", CFG["five_hour_max_pct"], 2 * 3600)]
        r = resolve_for(state, KEY, crossed)
        self.assertEqual((r.account.id, r.reason, r.left), ("a", "switch", ("b", "depleted")))
        state["sessions"][KEY.key]["vends"]["anthropic"] = vend_record("a")
        self.assertEqual(resolve_for(state, KEY, crossed).reason, "stay")

    def test_switch_asked_with_no_other_usable_account_stays(self):
        state = state_v2(current="b")
        state["sessions"][KEY.key]["leave"] = {"anthropic": {"account_id": "b", "at": NOW}}
        r = resolve_for(state, KEY, [account("b", "b@x"), account("d", "d@x", session_pct=99)])
        self.assertEqual((r.account.id, r.reason), ("b", "stay"))

    def test_a_leave_record_is_inert_once_the_session_moved(self):
        state = state_v2(current="a")
        state["sessions"][KEY.key]["leave"] = {"anthropic": {"account_id": "b", "at": NOW}}
        self.assertEqual(resolve_for(state, KEY, self.ACCOUNTS).reason, "stay")

    def test_cmd_switch_writes_a_leave_for_this_session_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            vend.save_json(path, two_sessions(current="b", other="b"))
            with unittest.mock.patch.object(vend, "STATE", path), unittest.mock.patch.object(vend, "LOCK", path + ".lock"), \
                 unittest.mock.patch.object(vend, "session_key", lambda: KEY), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vend.cmd_switch([]), 0)
            saved = vend.load_json(path)
        self.assertEqual(saved["sessions"][KEY.key]["leave"]["anthropic"]["account_id"], "b")
        self.assertNotIn("leave", saved["sessions"][OTHER.key])

    def test_last_resort_keeps_a_depleted_current_account_the_provider_serves(self):
        near = account("n", "n@x", session_pct=98)
        nearer = account("m", "m@x", session_pct=96)
        self.assertEqual(vend.last_resort([near, nearer], {}, CFG, NOW).id, "m")
        self.assertEqual(vend.last_resort([near, nearer], {}, CFG, NOW, current="n").id, "n")
        full = account("f", "f@x", session_pct=100)
        self.assertEqual(vend.last_resort([full, nearer], {}, CFG, NOW, current="f").id, "m")


class Weights(unittest.TestCase):
    def test_a_draw_follows_the_weights(self):
        weights = [(account("a", "a@x"), 6.0), (account("b", "b@x"), 3.0), (account("c", "c@x"), 1.0)]
        rng = random.Random(11)
        counts = collections.Counter(vend.weighted_pick(weights, rng).id for _ in range(20000))
        for id, share in (("a", 0.6), ("b", 0.3), ("c", 0.1)):
            self.assertAlmostEqual(counts[id] / 20000, share, delta=0.015)

    def test_sessions_that_switch_together_spread_out(self):
        state = {"version": 2, "providers": {"anthropic": vend.empty_provider_state()}, "sessions": {}}
        accounts = [windowed(id, 10, 3 * 3600) for id in "pqrs"] + [windowed("x", 99, 3 * 3600)]
        for i in range(12):
            key = vend.SessionKey(f"s{i}", f"s{i}", None)
            state["sessions"][key.key] = {"vends": {"anthropic": vend_record("x")}, "pins": {}, "last_seen": NOW}
            r = resolve_for(state, key, accounts, seed=i)
            self.assertEqual(r.reason, "switch")
            vend.HookWriter(state).record_vend(key, "anthropic", r.account, "store", r.reason, None, NOW, (1, "s"))
        landed = vend.in_use_counts(state, "anthropic", NOW, 3600)
        self.assertGreaterEqual(len(landed), 3, landed)
        self.assertLessEqual(max(landed.values()), 6, landed)

    def test_more_sessions_mean_less_runway(self):
        a = windowed("a", 40, 4 * 3600)
        self.assertGreater(vend.runway_hours(a, 4, CFG, NOW), vend.runway_hours(a, 12, CFG, NOW))

    def test_a_five_hour_window_that_resets_soon_counts_as_fresh(self):
        soon = windowed("s", 80, 600)
        later = windowed("l", 60, 4 * 3600)
        self.assertGreater(vend.runway_hours(soon, 8, CFG, NOW), vend.runway_hours(later, 8, CFG, NOW))
        self.assertEqual(vend.runway_hours(soon, 1, CFG, NOW), CFG["runway_horizon_hours"])

    def test_a_weekly_window_near_its_cutoff_binds(self):
        tired = windowed("t", 0, 5 * 3600, week=95, week_reset_in=3 * 86400)
        hours = vend.runway_hours(tired, 2, CFG, NOW)
        self.assertAlmostEqual(hours, (CFG["seven_day_max_pct"] - 95) / (2 * CFG["burn_week_pct_per_hour"]))

    def test_an_account_about_to_cross_is_left_out_unless_all_are(self):
        close = windowed("c", CFG["five_hour_max_pct"] - 1, 4 * 3600)
        roomy = windowed("r", 10, 4 * 3600)
        picked = [a.id for a, _ in vend.switch_weights([close, roomy], {"c": 3}, {}, CFG, NOW)]
        self.assertEqual(picked, ["r"])
        only = [a.id for a, _ in vend.switch_weights([close], {"c": 3}, {}, CFG, NOW)]
        self.assertEqual(only, ["c"])


class SwitchLog(unittest.TestCase):
    def run_vend(self, state, accounts):
        logged = []
        with contextlib.ExitStack() as stack:
            for name, value in {"config": CFG, "load_index": accounts, "session_key": KEY,
                                "load_state": state, "credential_for": ("fixture-token", "store"),
                                "proc_info": {"start": "s"}}.items():
                stack.enter_context(unittest.mock.patch.object(vend, name, return_value=value))
            stack.enter_context(unittest.mock.patch.object(vend, "Flock", lambda *a, **kw: contextlib.nullcontext()))
            stack.enter_context(unittest.mock.patch.object(vend.time, "time", return_value=NOW))
            stack.enter_context(unittest.mock.patch.object(vend, "save_json"))
            stack.enter_context(unittest.mock.patch.object(vend, "anthropic_refusal", return_value=None))
            stack.enter_context(unittest.mock.patch.object(vend, "log", side_effect=lambda e, **kw: logged.append((e, kw))))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            vend.vend("anthropic")
        return logged

    def test_a_switch_logs_why_and_the_weights(self):
        accounts = [account("a", "a@x", session_pct=10), account("b", "b@x", session_pct=99)]
        logged = self.run_vend(state_v2(current="b"), accounts)
        [(_, line)] = [e for e in logged if e[0] == "switch"]
        self.assertEqual((line["previous"], line["account"], line["reason"], line["why"]),
                         ("b@x", "a@x", "switch", "depleted"))
        self.assertEqual(line["weights"], {"a@x": float(CFG["runway_horizon_hours"])})

    def test_staying_logs_no_switch(self):
        accounts = [account("a", "a@x", session_pct=10), account("b", "b@x", session_pct=50)]
        logged = self.run_vend(state_v2(current="b"), accounts)
        self.assertEqual([e for e, _ in logged if e == "switch"], [])

    def test_switches_today_counts_switch_lines_per_provider(self):
        day = vend.time.strftime("%Y-%m-%d", vend.time.localtime(NOW))
        before = vend.time.strftime("%Y-%m-%d", vend.time.localtime(NOW - 86400))
        lines = [{"ts": f"{before}T23:00:00", "event": "switch", "provider": "anthropic", "session": "s0"},
                 {"ts": f"{day}T01:00:00", "event": "switch", "provider": "anthropic", "session": "s1"},
                 {"ts": f"{day}T02:00:00", "event": "vend", "provider": "anthropic", "session": "s1"},
                 {"ts": f"{day}T03:00:00", "event": "switch", "provider": "anthropic", "session": "s1"},
                 {"ts": f"{day}T04:00:00", "event": "switch", "provider": "openai-codex", "session": "s2"},
                 {"ts": f"{day}T05:00:00", "event": "switch", "provider": "anthropic", "session": "s3"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pi-pool.log")
            with open(path, "w") as f:
                f.writelines(json.dumps(e) + "\n" for e in lines)
            with unittest.mock.patch.object(vend, "LOG", path):
                self.assertEqual(vend.switches_today("anthropic", NOW), (3, 2))
                self.assertEqual(vend.switches_today("openai-codex", NOW), (1, 1))


if __name__ == "__main__":
    unittest.main()
