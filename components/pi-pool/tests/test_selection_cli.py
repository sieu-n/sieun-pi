"""Owner request 2026-10-19: Off accounts remain selectable in persistent Manual mode."""
import json
import time
import unittest

from fixture_isolation import isolate_test_module
from test_account_admin import A, B, CLAUDE_INDEX, PoolFixture


def setUpModule():
    isolate_test_module()


class SelectionCli(PoolFixture):
    SESSION = "11111111-2222-4333-8444-555555555555"

    def pin_off(self):
        self.assertEqual(self.cli("off", "a@x")[0], 0)
        code, out = self.cli("use", "a@x", "--session", self.SESSION, "--new-session")
        self.assertEqual(code, 0, out)
        self.assertIn("Manual", out)

    def who(self):
        code, out = self.cli("who", "--json", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        return json.loads(out)["providers"]["anthropic"]

    def test_off_manual_survives_separate_cli_processes_and_old_pin_timestamp(self):
        self.pin_off()
        state = self.state()
        state["sessions"][self.SESSION]["pins"]["anthropic"]["at"] = 0
        state["sessions"][self.SESSION]["last_seen"] = 0
        self.write_state(state)
        who = self.who()
        self.assertEqual(who["selection"], {"mode": "manual", "account_id": A})
        self.assertEqual(who["account"], A)
        self.assertEqual(who["current"]["id"], A)
        self.assertTrue(self.rows()["a@x"]["disabled"])

    def test_switching_auto_clears_manual_and_excludes_sticky_off_account(self):
        self.pin_off()
        state = self.state()
        state["sessions"][self.SESSION]["vends"] = {
            "anthropic": {"account_id": A, "email": "a@x", "at": time.time(), "n": 1}}
        self.write_state(state)
        code, out = self.cli("use", "--follow", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        who = self.who()
        self.assertEqual(who["selection"], {"mode": "auto"})
        self.assertEqual(who["account"], B)

    def test_manual_refuses_optional_switch(self):
        self.pin_off()
        code, out = self.cli("switch", "--session", self.SESSION)
        self.assertNotEqual(code, 0)
        self.assertIn("Manual mode stays pinned", out)
        self.assertEqual(self.who()["selection"]["account_id"], A)

    def test_manual_provider_limit_preserves_original_error_and_identity(self):
        self.pin_off()
        state = self.state()
        state["sessions"][self.SESSION]["vends"] = {
            "anthropic": {"account_id": A, "email": "a@x", "at": time.time(), "n": 1}}
        self.write_state(state)
        code, out = self.cli("limited", "--session", self.SESSION, "--until", str(time.time() + 3600))
        self.assertEqual(code, 0, out)
        result = json.loads(out)
        self.assertEqual(result["selection"], {"mode": "manual", "account_id": A})
        self.assertIsNone(result["next"])
        self.assertIsNone(result["retry_at"])
        who = self.who()
        self.assertEqual(who["selection"]["account_id"], A)
        self.assertNotEqual(who["account"], B)

    def test_manual_auth_failure_reports_selected_account_without_switching(self):
        self.pin_off()
        self.write_index("anthropic", {"version": 1, "accounts": [
            {**CLAUDE_INDEX["accounts"][0], "needsReauth": True}, CLAUDE_INDEX["accounts"][1]]})
        who = self.who()
        self.assertEqual(who["selection"], {"mode": "manual", "account_id": A})
        self.assertIsNone(who["account"])
        self.assertIn("a@x", who["error"])
        self.assertIn("needs-reauth", who["error"])
        self.assertEqual(who["current"]["id"], A)

    def test_manual_removed_account_stays_manual_until_auto_is_selected(self):
        self.pin_off()
        code, out = self.cli("rm", "a@x")
        self.assertEqual(code, 0, out)
        who = self.who()
        self.assertEqual(who["selection"], {"mode": "manual", "account_id": A})
        self.assertIsNone(who["account"])
        self.assertIn("missing", who["error"])
        code, out = self.cli("use", "--follow", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.who()["account"], B)

    def test_list_reports_explicit_auto_and_manual_modes(self):
        self.pin_off()
        code, out = self.cli("ls", "--json", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["selection"], {"mode": "manual", "account_id": A})
        code, out = self.cli("ls", "--json")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["selection"], {"mode": "auto"})


if __name__ == "__main__":
    unittest.main()
