"""Strict manual selection and automatic exclusion of Off accounts."""
import contextlib
import dataclasses
import io
import os
import tempfile
import unittest
from unittest.mock import patch

from fixture_isolation import isolate_test_module
from test_core import A, B, BROKEN, CFG, KEY, NOW, codex_account, state_v2
from test_scheduler import P, acct
from vend.pool import base, registry, sched, vending


def setUpModule():
    isolate_test_module()


class ManualSelection(unittest.TestCase):
    def choose(self, accounts, **fields):
        return sched.decide(sched.Tree(**fields), accounts, sched.Book(), {}, CFG, NOW, draw=0.5)

    def test_old_pin_overrides_recent_vend_and_pool_pin(self):
        d = self.choose([A, B], pin="a", pool_pin="b", current="b", current_at=NOW)
        self.assertEqual((type(d), d.account.id, d.reason, d.fallbacks),
                         (sched.Admit, "a", "session_pin", ()))
        self.assertEqual(d.left, ("b", "pin"))

    def test_manual_current_never_upgrades_plans(self):
        accounts = [codex_account("free", "free@x", "free"), codex_account("pro", "pro@x", "pro")]
        d = self.choose(accounts, pin="free", current="free", current_at=1)
        self.assertEqual((type(d), d.account.id, d.fallbacks), (sched.Stay, "free", ()))

    def test_manual_ignores_old_leave_intent(self):
        d = self.choose([A, B], pin="a", current="a", leave="a")
        self.assertEqual((type(d), d.account.id), (sched.Stay, "a"))

    def test_explicit_session_and_pool_pins_can_select_off(self):
        off = dataclasses.replace(A, disabled=True)
        for fields in ({"pin": "a"}, {"pool_pin": "a"}, {"pin": "a", "current": "a"}):
            with self.subTest(fields=fields):
                d = self.choose([off, B], **fields)
                self.assertEqual(d.account.id, "a")
                self.assertEqual(d.fallbacks, ())

    def test_missing_and_reauth_are_blocked_without_pool_fallback(self):
        for target, reason in (("gone", "missing"), ("e", "needs-reauth")):
            with self.subTest(reason=reason):
                d = self.choose([A, B, BROKEN], pin=target, pool_pin="a", current="b")
                self.assertEqual(d, sched.Blocked(target, reason))

    def test_auth_failure_overrides_old_manual_backoff(self):
        d = sched.decide(sched.Tree(pin="e", current="e", wait=("e", NOW + 600, NOW - 60), backoff=True),
                         [BROKEN, A], sched.Book(), {}, CFG, NOW)
        self.assertEqual(d, sched.Blocked("e", "needs-reauth"))

    def test_depleted_pin_without_reset_is_blocked(self):
        d = self.choose([dataclasses.replace(A, session_pct=100), B], pin="a", current="b")
        self.assertEqual(d, sched.Blocked("a", "depleted"))

    def test_cooldown_is_blocked_without_another_identity(self):
        d = sched.decide(sched.Tree(pin="a", current="b"), [A, B], sched.Book(), {"a": NOW + 60}, CFG, NOW)
        self.assertEqual(d, sched.Blocked("a", "cooldown"))

    def test_new_manual_target_uses_remaining_quota_for_every_priority(self):
        for priority in sched.PRIORITIES:
            with self.subTest(priority=priority):
                d = self.choose([acct("a", five=99, week=99), B], pin="a", current="b", priority=priority)
                self.assertEqual((type(d), d.account.id, d.fallbacks), (sched.Admit, "a", ()))

    def test_manual_ignores_projection_and_clears_old_admission_backoff(self):
        a = acct("a", five=77)
        book = sched.Book(spending={"a": 10}, rates={"a": 10})
        tree = sched.Tree(key="mine", pin="a", wait=("a", NOW + 600, NOW - 60), backoff=True)
        d = sched.decide(tree, [a, B], book, {}, CFG, NOW)
        self.assertEqual((type(d), d.account.id), (sched.Admit, "a"))

    def test_manual_above_auto_cutoff_waits_only_for_admission_slot(self):
        a = acct("a", five=77)
        book = sched.Book(admitted={"a": ((NOW, "another"),)})
        tree = sched.Tree(key="mine", pin="a", priority="high")
        d = sched.decide(tree, [a, B], book, {}, CFG, NOW)
        self.assertIsInstance(d, sched.Wait)
        self.assertFalse(d.backoff)
        self.assertLessEqual(d.slot_at, NOW + sched.slot_spacing(a, CFG))
        resumed = sched.decide(dataclasses.replace(tree, wait=("a", d.slot_at, NOW)), [a, B], book, {}, CFG, d.slot_at)
        self.assertEqual((type(resumed), resumed.account.id), (sched.Admit, "a"))

    def test_current_manual_keeps_existing_stay_admission_exception(self):
        d = self.choose([acct("a", five=95), B], pin="a", current="a")
        self.assertEqual((type(d), d.account.id), (sched.Stay, "a"))

    def test_pin_obeys_slots_even_for_high_priority(self):
        for priority in sched.PRIORITIES:
            with self.subTest(priority=priority):
                book = sched.Book(admitted={"a": ((NOW, "another"),)})
                d = sched.decide(sched.Tree(key="mine", pin="a", current="b", priority=priority),
                                 [A, B], book, {}, CFG, NOW)
                self.assertIsInstance(d, sched.Wait)
                self.assertEqual(d.slot_account.id, "a")
                self.assertGreater(d.slot_at, NOW)
                self.assertIsNone(d.vend)

    def test_pinned_limit_wait_never_vends_previous_auto_identity(self):
        d = self.choose([acct("a", limited_until=NOW + 600), B], pin="a", current="b")
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual(d.slot_account.id, "a")
        self.assertIsNone(d.vend)

    def test_current_pinned_limit_may_vend_only_that_pinned_identity(self):
        d = self.choose([acct("a", limited_until=NOW + 600), B], pin="a", current="a")
        self.assertIsInstance(d, sched.Wait)
        self.assertEqual((d.slot_account.id, d.vend.id), ("a", "a"))

    def test_model_gate_is_not_bypassed_by_manual_off_selection(self):
        a = dataclasses.replace(A, gated_pct=100, disabled=True)
        self.assertEqual(self.choose([a, B], pin="a"), sched.Blocked("a", "depleted"))
        allowed = registry.with_models([a, B], ["claude-opus-5-5"], CFG)
        self.assertEqual(self.choose(allowed, pin="a").account.id, "a")

    def test_pool_pin_is_strict_and_session_pin_overrides_it(self):
        self.assertEqual(self.choose([A, B], pool_pin="gone", current="a"), sched.Blocked("gone", "missing"))
        self.assertEqual(self.choose([A, B], pool_pin="gone", pin="b", current="a").account.id, "b")

    def test_auto_excludes_off_in_fresh_sticky_and_fallback_paths(self):
        off = dataclasses.replace(A, disabled=True)
        for fields in ({}, {"current": "a"}, {"current": "b"}):
            with self.subTest(fields=fields):
                d = self.choose([off, B], **fields)
                self.assertEqual(d.account.id, "b")
                self.assertNotIn("a", [a.id for a in d.fallbacks])
        self.assertIsNone(self.choose([off], current="a"))

    def test_auto_drops_old_off_backoff_and_wait_target(self):
        off = dataclasses.replace(acct("a", five=100), disabled=True)
        for backoff in (False, True):
            with self.subTest(backoff=backoff):
                d = self.choose([off, acct("b", five=100)], current="a", wait=("a", NOW + 100, NOW),
                                backoff=backoff)
                self.assertIsInstance(d, sched.Wait)
                self.assertEqual(d.slot_account.id, "b")
                self.assertIsNone(d.vend)


class Persistence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.pool = patch.object(base, "POOL", self.directory.name)
        self.pool.start()
        self.addCleanup(self.pool.stop)

    def old_state(self):
        old = NOW - CFG["pin_ttl_sec"] - 1
        state = state_v2(pins={P: {"account_id": "a", "at": old}}, current="b")
        state["sessions"][KEY.key]["last_seen"] = old
        return state

    def test_normalize_retains_pins_older_than_ttl(self):
        state = registry.normalize(self.old_state())
        self.assertEqual(sched.tree_for(state, KEY, P).pin, "a")

    def test_prune_archives_old_manual_and_restart_restores_it_after_ttl(self):
        state = self.old_state()
        vending.HookWriter(state).prune(CFG, NOW)
        self.assertNotIn(KEY.key, state["sessions"])
        later = NOW + CFG["pin_ttl_sec"] * 2
        registry.sweep_archive(later, CFG["pin_ttl_sec"])
        sessions = registry.Sessions({}, later, CFG["pin_ttl_sec"])
        self.assertEqual(sessions[KEY.key]["pins"][P]["account_id"], "a")

    def test_archive_sweep_still_removes_expired_auto_records(self):
        state = self.old_state()
        state["sessions"][KEY.key]["pins"].clear()
        registry.archive_record(KEY.key, state["sessions"][KEY.key])
        registry.sweep_archive(NOW, CFG["pin_ttl_sec"])
        self.assertIsNone(registry.archived_record(KEY.key, NOW, CFG["pin_ttl_sec"]))

    def test_account_removal_preserves_hot_archived_and_pool_manual_identity(self):
        state = self.old_state()
        state["providers"][P]["pin"] = "a"
        other = dict(state["sessions"][KEY.key])
        registry.archive_record("archived", other)
        vending.IntentWriter(state).forget_account(P, "a")
        self.assertEqual(sched.tree_for(state, KEY, P).pin, "a")
        self.assertEqual(state["providers"][P]["pin"], "a")
        self.assertEqual(registry.archived_record("archived", NOW, CFG["pin_ttl_sec"])["pins"][P]["account_id"], "a")

    def test_clear_pin_cannot_resurrect_old_archived_manual_selection(self):
        state = self.old_state()
        registry.archive_record(KEY.key, state["sessions"][KEY.key])
        state["sessions"] = registry.Sessions({}, NOW, CFG["pin_ttl_sec"])
        vending.IntentWriter(state).clear_pin(KEY, P)
        self.assertIsNone(sched.tree_for(state, KEY, P).pin)
        registry.sweep_archive(NOW, CFG["pin_ttl_sec"])
        restarted = dict(state, sessions=registry.Sessions({}, NOW, CFG["pin_ttl_sec"]))
        self.assertIsNone(sched.tree_for(restarted, KEY, P).pin)

    def test_auto_after_clear_never_stays_on_off_account(self):
        state = state_v2(pins={P: {"account_id": "a", "at": NOW}}, current="a")
        state["providers"][P]["disabled"] = {"a": NOW}
        vending.IntentWriter(state).clear_pin(KEY, P)
        d, _, _ = vending.schedule(state, KEY, P, [A, B], CFG, NOW)
        self.assertEqual(d.account.id, "b")


class VendSelection(unittest.TestCase):
    def run_vend(self, state, busy_calls, accounts=(A, B), credential=None, calls=None, refusal=None):
        calls = [] if calls is None else calls
        logged, saved = [], []

        @contextlib.contextmanager
        def lock(*args, **kwargs):
            calls.append(True)
            if len(calls) in busy_calls:
                raise TimeoutError("fixture pool lock busy")
            yield

        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for module, name, value in ((base, "config", CFG), (registry, "load_index", list(accounts)),
                                        (registry, "session_key", KEY), (registry, "load_state", state),
                                        (base, "load_json", state), (base, "proc_info", {"start": "fixture"})):
                stack.enter_context(patch.object(module, name, return_value=value))
            stack.enter_context(patch.object(vending, "credential_for", side_effect=credential or (
                lambda a, cfg, refresh=True: ("fixture-token", "store"))))
            stack.enter_context(patch.object(base, "anthropic_probe", return_value=base.ProbeRefused(refusal) if refusal else base.ProbeAccepted()))
            stack.enter_context(patch.object(base, "Flock", lock))
            stack.enter_context(patch.object(vending.time, "time", return_value=NOW))
            stack.enter_context(patch.object(base, "save_json", side_effect=lambda *args: saved.append(args)))
            stack.enter_context(patch.object(base, "log", side_effect=lambda event, **kw: logged.append((event, kw))))
            stack.enter_context(contextlib.redirect_stdout(output))
            vending.vend(P)
        return output.getvalue(), logged, saved

    def test_busy_lock_never_vends_old_account_after_new_pin(self):
        for target in ("a", "gone"):
            state = state_v2(pins={P: {"account_id": target, "at": 1}}, current="b")
            with self.subTest(target=target), self.assertRaises(TimeoutError):
                self.run_vend(state, busy_calls={1})

    def test_busy_lock_serves_explicit_off_current_but_not_auto(self):
        for manual in (True, False):
            state = state_v2(pins={P: {"account_id": "b", "at": 1}} if manual else {}, current="b")
            state["providers"][P]["disabled"] = {"b": NOW}
            if manual:
                self.assertEqual(self.run_vend(state, busy_calls={1})[0], "fixture-token")
            else:
                with self.assertRaises(TimeoutError):
                    self.run_vend(state, busy_calls={1})

    def test_busy_lock_does_not_bypass_admission_wait(self):
        state = state_v2(pins={P: {"account_id": "b", "at": 1}}, current="b")
        state["sessions"][KEY.key]["wait"] = {P: {"account": "b", "slot_at": NOW + 600, "since": NOW}}
        with self.assertRaises(TimeoutError):
            self.run_vend(state, busy_calls={1})

    def test_blocked_vend_reports_label_and_actual_refusal(self):
        state = state_v2(pins={P: {"account_id": "b", "at": 1}}, current="a", cooldowns={"b": NOW + 600})
        state["providers"][P]["cooldown_reasons"] = {"b": "fixture organization refusal"}
        with self.assertRaisesRegex(RuntimeError, "pinned anthropic account b@x: fixture organization refusal"):
            self.run_vend(state, busy_calls=set())

    def test_busy_lock_respects_usage_model_and_auth_health(self):
        for broken in (dataclasses.replace(B, session_pct=100), dataclasses.replace(B, gated_pct=100),
                       dataclasses.replace(B, needs_reauth=True)):
            state = state_v2(pins={P: {"account_id": "b", "at": 1}}, current="b")
            with self.subTest(account=broken), self.assertRaises(TimeoutError):
                self.run_vend(state, busy_calls={1}, accounts=[A, broken])

    def test_credential_and_provider_refusal_do_not_try_another_account(self):
        for refusal in (False, True):
            state = state_v2(pins={P: {"account_id": "a", "at": 1}}, current="b")
            tried = []

            def credential(a, cfg, refresh=True):
                tried.append(a.id)
                if not refusal:
                    raise RuntimeError("fixture credential failed")
                return "fixture-token", "store"

            with self.subTest(refusal=refusal):
                with self.assertRaisesRegex(RuntimeError, "fixture refusal" if refusal else "fixture credential failed"):
                    self.run_vend(state, busy_calls=set(), credential=credential,
                                  refusal="fixture refusal" if refusal else None)
                self.assertEqual(tried, ["a"])

    def test_fast_stay_serves_only_explicit_off_current_and_preserves_pin(self):
        state = state_v2(pins={P: {"account_id": "b", "at": 1}}, current="b")
        state["providers"][P]["disabled"] = {"b": NOW}
        calls = []
        with patch.object(base, "FILE_SECRETS", True):
            output, _, _ = self.run_vend(state, busy_calls=set(), calls=calls)
        self.assertEqual((output, len(calls)), ("fixture-token", 1))
        self.assertEqual(state["sessions"][KEY.key]["pins"][P]["account_id"], "b")


if __name__ == "__main__":
    unittest.main()
