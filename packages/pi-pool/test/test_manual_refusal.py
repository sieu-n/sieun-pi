"""Provider refusal recovery for an explicitly selected Off account."""
import contextlib
import copy
import io
import json
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from fixture_isolation import isolate_test_module
from test_core import B, CFG, KEY, NOW, TERMS_BODY, state_v2
from test_scheduler import P, acct
from vend.pool import base, registry, vending


def setUpModule():
    isolate_test_module()


class ManualRefusal(unittest.TestCase):
    def setUp(self):
        self.state = state_v2(pins={P: {"account_id": "b", "at": 1}}, current="b",
                              pool_pin="a", cooldowns={"b": NOW + CFG["refused_cooldown_sec"], "a": NOW + 600})
        self.prov = self.state["providers"][P]
        self.prov.update(disabled={"b": 1}, cooldown_reasons={"b": base.NEEDS_TERMS, "a": base.OAUTH_OFF})
        self.state["sessions"]["unrelated"] = {"pins": {P: {"account_id": "a", "at": 1}}, "last_seen": NOW}
        self.before = copy.deepcopy(self.state)
        self.locked = False
        self.sent = []
        self.credentials = []
        self.output = io.StringIO()

    @contextlib.contextmanager
    def hook(self, response):
        @contextlib.contextmanager
        def lock(*args, **kwargs):
            self.assertFalse(self.locked)
            self.locked = True
            try:
                yield
            finally:
                self.locked = False

        def credential(a, cfg, refresh=True):
            self.assertFalse(self.locked)
            self.credentials.append(a.id)
            return "fixture-token", "store"

        def urlopen(req, timeout=None):
            self.assertFalse(self.locked)
            self.sent.append((req.full_url, json.loads(req.data), timeout))
            if callable(response):
                response(self)
            if isinstance(response, Exception):
                raise response
            if isinstance(response, int):
                raise urllib.error.HTTPError(req.full_url, response, "fixture", {}, io.BytesIO(
                    TERMS_BODY.encode() if response == 400 else b"{}"))
            return contextlib.nullcontext()

        with contextlib.ExitStack() as stack:
            for module, name, value in ((base, "config", CFG), (registry, "load_index", [acct("a"), acct("b")]),
                                       (registry, "session_key", KEY), (registry, "load_state", self.state),
                                       (base, "proc_info", {"start": "fixture"})):
                stack.enter_context(patch.object(module, name, return_value=value))
            stack.enter_context(patch.object(base, "Flock", lock))
            stack.enter_context(patch.object(base, "save_json"))
            stack.enter_context(patch.object(base, "log"))
            stack.enter_context(patch.object(base, "FILE_SECRETS", False))
            stack.enter_context(patch.object(vending.time, "time", return_value=NOW))
            stack.enter_context(patch.object(vending, "credential_for", side_effect=credential))
            stack.enter_context(patch.object(urllib.request, "urlopen", side_effect=urlopen))
            stack.enter_context(patch.object(vending, "fallback_token", side_effect=AssertionError("no fallback")))
            stack.enter_context(contextlib.redirect_stdout(self.output))
            yield

    def assert_intent_unchanged(self):
        self.assertEqual(self.prov["disabled"], self.before["providers"][P]["disabled"])
        self.assertEqual(self.prov["pin"], "a")
        self.assertEqual(self.state["sessions"][KEY.key]["pins"], self.before["sessions"][KEY.key]["pins"])
        self.assertEqual(self.state["sessions"]["unrelated"], self.before["sessions"]["unrelated"])
        self.assertEqual(self.prov["cooldowns"]["a"], self.before["providers"][P]["cooldowns"]["a"])
        self.assertEqual(self.prov["cooldown_reasons"]["a"], base.OAUTH_OFF)

    def test_terms_refusal_keeps_manual_off_and_never_falls_back(self):
        with self.hook(400), self.assertRaisesRegex(RuntimeError, "b@x: needs terms"):
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(self.credentials, ["b"])
        self.assertEqual(self.sent[0][0], base.INFER_URL)
        self.assertEqual(self.prov["cooldown_reasons"]["b"], base.NEEDS_TERMS)
        self.assert_intent_unchanged()

    def test_next_hook_after_acceptance_recovers_same_target_once(self):
        with self.hook(400), self.assertRaisesRegex(RuntimeError, "needs terms"):
            vending.vend(P)
        with self.hook(None):
            vending.vend(P)
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "fixture-tokenfixture-token")
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[0][0], base.INFER_URL)
        self.assertEqual(self.sent[0][1]["max_tokens"], 1)
        self.assertNotIn("b", self.prov["cooldowns"])
        self.assertNotIn("b", self.prov["cooldown_reasons"])
        self.assertEqual(self.state["sessions"][KEY.key]["vends"][P]["account_id"], "b")
        self.assertEqual(set(self.credentials), {"b"})
        self.assert_intent_unchanged()

    def test_unavailable_never_clears_prior_refusal(self):
        for response in (429, 500, 503, urllib.error.URLError("fixture network"), TimeoutError("fixture timeout")):
            with self.subTest(response=response), self.hook(response), self.assertRaisesRegex(RuntimeError, "needs terms"):
                vending.vend(P)
            self.assertEqual(self.prov["cooldowns"]["b"], self.before["providers"][P]["cooldowns"]["b"])
            self.assertEqual(self.prov["cooldown_reasons"]["b"], base.NEEDS_TERMS)
            self.assert_intent_unchanged()
        self.assertEqual(len(self.sent), 5)
        self.assertEqual(self.output.getvalue(), "")

    def test_recovery_into_new_target_does_not_probe_twice(self):
        self.state["sessions"][KEY.key]["vends"][P]["account_id"] = "a"
        with self.hook(None):
            vending.vend(P)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.credentials, ["b"])
        self.assertEqual(self.output.getvalue(), "fixture-token")
        self.assert_intent_unchanged()

    def test_acceptance_cannot_clear_newer_refusal(self):
        def newer(test):
            test.prov["cooldowns"]["b"] += 1
        with self.hook(newer), self.assertRaisesRegex(RuntimeError, "needs terms"):
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(self.prov["cooldown_reasons"]["b"], base.NEEDS_TERMS)
        self.assertEqual(self.prov["cooldowns"]["b"], self.before["providers"][P]["cooldowns"]["b"] + 1)
        self.assert_intent_unchanged()

    def test_changed_manual_pin_is_not_vended_away(self):
        def change_pin(test):
            test.state["sessions"][KEY.key]["pins"][P]["account_id"] = "a"
        with self.hook(change_pin), self.assertRaisesRegex(RuntimeError, "manual account selection changed"):
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(self.state["sessions"][KEY.key]["pins"][P]["account_id"], "a")
        self.assertEqual(self.prov["disabled"], {"b": 1})

    def test_probe_timeout_uses_remaining_hook_deadline_and_lock_reserves(self):
        from vend.pool import remote
        with self.hook(None), patch.object(vending.time, "monotonic", side_effect=(0, 1)):
            vending.vend(P)
        self.assertEqual(self.sent[0][2], min(base.INFER_TIMEOUT, remote.TOKEN_WAIT_SEC - 1 - 2 * base.STATE_LOCK_TIMEOUT))

    def test_spent_hook_budget_preserves_refusal_for_next_request(self):
        from vend.pool import remote
        with self.hook(None), patch.object(vending.time, "monotonic", side_effect=(0, remote.TOKEN_WAIT_SEC)):
            with self.assertRaisesRegex(RuntimeError, "needs terms"):
                vending.vend(P)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.prov["cooldown_reasons"]["b"], base.NEEDS_TERMS)
        with self.hook(None):
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "fixture-token")

    def test_rejected_token_remains_blocked(self):
        with self.hook(401), self.assertRaisesRegex(RuntimeError, r"token rejected \(401\)"):
            vending.vend(P)
        self.assertEqual(self.prov["cooldown_reasons"]["b"], base.TOKEN_REJECTED)
        self.assert_intent_unchanged()

    def test_oauth_recovery_uses_count_tokens(self):
        self.prov["cooldown_reasons"]["b"] = base.OAUTH_OFF
        with self.hook(None):
            vending.vend(P)
        self.assertEqual(self.sent[0][0], base.PROBE_URL)
        self.assertEqual(self.output.getvalue(), "fixture-token")
        self.assert_intent_unchanged()

    def test_pool_manual_selection_can_recover_off_target(self):
        self.state["sessions"][KEY.key]["pins"] = {}
        self.prov["pin"] = "b"
        with self.hook(None):
            vending.vend(P)
        self.assertEqual(self.output.getvalue(), "fixture-token")
        self.assertEqual(self.prov["pin"], "b")
        self.assertEqual(self.prov["disabled"], {"b": 1})

    def test_auto_does_not_revalidate_off_target(self):
        self.state["sessions"][KEY.key]["pins"] = {}
        self.prov["pin"] = None
        with self.hook(None), self.assertRaises(RuntimeError):
            vending.vend(P)
        self.assertEqual(self.sent, [])


class ProbeEvidence(unittest.TestCase):
    def probe(self, reason, response, concurrent=None):
        state = state_v2(cooldowns={"b": NOW + 600})
        prov = state["providers"][P]
        prov["cooldown_reasons"] = {"b": reason}
        held, sent = [], []

        @contextlib.contextmanager
        def lock(*args, **kwargs):
            held.append(True)
            try:
                yield
            finally:
                held.pop()

        def urlopen(req, timeout=None):
            self.assertEqual(held, [])
            sent.append(req.full_url)
            if concurrent:
                concurrent(prov)
            if response:
                raise urllib.error.HTTPError(req.full_url, response, "fixture", {}, io.BytesIO(b"{}"))
            return contextlib.nullcontext()

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(registry, "load_state", return_value=state))
            stack.enter_context(patch.object(base.KeychainAdapter, "read", return_value={
                "accessToken": "fixture", "expiresAt": (NOW + 3600) * 1000}))
            stack.enter_context(patch.object(urllib.request, "urlopen", side_effect=urlopen))
            stack.enter_context(patch.object(base, "Flock", lock))
            stack.enter_context(patch.object(base, "save_json"))
            stack.enter_context(patch.object(base, "log"))
            lines = vending.probe_accounts([B], {"b": reason}, CFG, NOW)
        return prov, sent, lines

    def test_automatic_probe_requires_successful_inference_to_free_terms(self):
        prov, sent, lines = self.probe(base.NEEDS_TERMS, None)
        self.assertEqual(sent, [base.INFER_URL])
        self.assertEqual(lines, ["b@x: accepted again"])
        self.assertNotIn("b", prov["cooldowns"])
        self.assertNotIn("b", prov["cooldown_reasons"])

    def test_automatic_probe_keeps_rejected_token_refusal(self):
        prov, sent, lines = self.probe(base.OAUTH_OFF, 401)
        self.assertEqual(sent, [base.PROBE_URL])
        self.assertEqual(lines, ["b@x: token rejected (401)"])
        self.assertEqual(prov["cooldown_reasons"]["b"], base.TOKEN_REJECTED)

    def test_automatic_acceptance_cannot_clear_newer_same_reason(self):
        def newer(prov):
            prov["cooldowns"]["b"] += 1
        prov, _, lines = self.probe(base.NEEDS_TERMS, None, newer)
        self.assertEqual(lines, [])
        self.assertEqual(prov["cooldown_reasons"]["b"], base.NEEDS_TERMS)
        self.assertEqual(prov["cooldowns"]["b"], NOW + 601)

    def test_stale_refusal_result_cannot_overwrite_newer_health(self):
        def newer(prov):
            prov["cooldown_reasons"]["b"] = base.TOKEN_REJECTED
        prov, _, lines = self.probe(base.NEEDS_TERMS, 403, newer)
        self.assertEqual(lines, [])
        self.assertEqual(prov["cooldown_reasons"]["b"], base.TOKEN_REJECTED)

    def test_transient_probe_does_not_free_terms_or_oauth_refusal(self):
        for reason in (base.NEEDS_TERMS, base.OAUTH_OFF):
            for response in (429, 500, urllib.error.URLError("fixture network")):
                state = state_v2(cooldowns={"b": NOW + 600})
                state["providers"][P]["cooldown_reasons"] = {"b": reason}
                before = copy.deepcopy(state)
                def urlopen(req, timeout=None):
                    if isinstance(response, Exception):
                        raise response
                    raise urllib.error.HTTPError(req.full_url, response, "fixture", {}, io.BytesIO(b"{}"))
                with self.subTest(reason=reason, response=response), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(registry, "load_state", return_value=state))
                    stack.enter_context(patch.object(base.KeychainAdapter, "read", return_value={
                        "accessToken": "fixture", "expiresAt": (NOW + 3600) * 1000}))
                    stack.enter_context(patch.object(urllib.request, "urlopen", side_effect=urlopen))
                    stack.enter_context(patch.object(base, "log"))
                    stack.enter_context(patch.object(base, "save_json"))
                    self.assertEqual(vending.probe_accounts([B], {"b": reason}, CFG, NOW), [])
                    self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
