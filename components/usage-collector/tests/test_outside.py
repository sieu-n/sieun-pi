"""Tests for the outside-client modules. The codex, claude_code and aside sums are what tokscale v4.23.1
reports for the same fixture homes (`tokscale models --home tests/fixtures/<client> --json`), with
tokscale's output plus reasoning as our output_tokens."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import types
import unittest
from collections import Counter
from pathlib import Path

import helpers  # noqa: F401  puts the component on sys.path

from usage_collector import core, prices
from usage_collector.clients import aside, claude_code, codex, goose, hermes, opencode, vent

FIXTURES = Path(__file__).resolve().parent / "fixtures"
U3 = "019a5000-0000-7000-8000-000000000003"


def ctx(home, host="h1", since=0, state=None):
    return types.SimpleNamespace(host=host, since=since, home=Path(home), state={} if state is None else state, cache={})


def rows_of(module, c):
    return [r for r in module.collect(c) if r is not core.CHECKPOINT]


def sums(rows):
    out = {}
    for r in rows:
        s = out.setdefault(r["model"], Counter())
        s["rows"] += 1
        for k in ("input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens"):
            s[k] += r[k]
    return {m: dict(v) for m, v in out.items()}


def check_row_shape(test, rows, client):
    for r in rows:
        test.assertTrue(r["source_key"].startswith(f"{client}:{r['host']}:"), r["source_key"])
        test.assertTrue(r["session"], r)
        core.normalize(r, client, r["host"])


class CodexTest(unittest.TestCase):
    def test_matches_tokscale_on_fixture(self):
        rows = rows_of(codex, ctx(FIXTURES / "codex"))
        check_row_shape(self, rows, "codex")
        self.assertEqual(sums(rows), {
            "gpt-5.5": {"rows": 3, "input_tokens": 1000, "output_tokens": 160, "reasoning_tokens": 30, "cache_read_tokens": 2500,
                        "cache_write_tokens": 0, "cache_write_1h_tokens": 0},
            "gpt-5.6-sol": {"rows": 1, "input_tokens": 500, "output_tokens": 30, "reasoning_tokens": 0, "cache_read_tokens": 500,
                            "cache_write_tokens": 0, "cache_write_1h_tokens": 0},
        })

    def test_archived_copy_and_rerun_give_the_same_keys(self):
        first = rows_of(codex, ctx(FIXTURES / "codex"))
        again = rows_of(codex, ctx(FIXTURES / "codex"))
        self.assertEqual([r["source_key"] for r in first], [r["source_key"] for r in again])
        self.assertEqual(len({r["source_key"] for r in first}), len(first))

    def test_cursor_skips_unchanged_rollouts(self):
        state = {}
        self.assertEqual(len(rows_of(codex, ctx(FIXTURES / "codex", state=state))), 4)
        state["mtime_cursor_ms"] += 1
        self.assertEqual(rows_of(codex, ctx(FIXTURES / "codex", state=state)), [])

    def test_compaction_record_counts_once(self):
        rows = rows_of(codex, ctx(FIXTURES / "codex"))
        self.assertEqual([r for r in rows if "usage-record" in r["source_key"]][0]["input_tokens"], 500)


class ClaudeCodeTest(unittest.TestCase):
    def test_matches_tokscale_on_fixture(self):
        rows = rows_of(claude_code, ctx(FIXTURES / "claude_code"))
        check_row_shape(self, rows, "claude-code")
        self.assertEqual(sums(rows), {
            "claude-opus-5-5": {"rows": 2, "input_tokens": 8, "output_tokens": 290, "reasoning_tokens": 0, "cache_read_tokens": 2200,
                                "cache_write_tokens": 2300, "cache_write_1h_tokens": 2000},
            "claude-fable-5-1": {"rows": 1, "input_tokens": 7, "output_tokens": 9, "reasoning_tokens": 0, "cache_read_tokens": 0,
                                 "cache_write_tokens": 0, "cache_write_1h_tokens": 0},
        })

    def test_streaming_copies_merge_to_largest_output_and_time_from_prompt(self):
        rows = {r["source_key"]: r for r in rows_of(claude_code, ctx(FIXTURES / "claude_code"))}
        first = rows["claude-code:h1:msg_1:req_1"]
        self.assertEqual(first["output_tokens"], 250)
        self.assertEqual(first["duration_ms"], 5000)
        self.assertEqual(first["cost_source"], prices.SOURCE)


class AsideTest(unittest.TestCase):
    def test_matches_tokscale_and_keeps_reported_cost(self):
        rows = rows_of(aside, ctx(FIXTURES / "aside"))
        check_row_shape(self, rows, "aside")
        by_model = {r["model"]: r for r in rows}
        self.assertEqual(len(rows), 2)
        claude = by_model["claude-opus-4-8"]
        self.assertEqual((claude["provider"], claude["output_tokens"], claude["reasoning_tokens"], claude["cache_write_1h_tokens"]),
                         ("anthropic", 200, 50, 400))
        self.assertEqual(claude["cost_source"], "reported")
        total = claude["cost_input_usd"] + claude["cost_output_usd"] + claude["cost_cache_read_usd"] + claude["cost_cache_write_usd"]
        self.assertAlmostEqual(total, 0.05)
        self.assertAlmostEqual(sum(by_model["gpt-6-astra"][k] for k in ("cost_input_usd", "cost_output_usd")), 0.004)


class SqliteClientsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def db(self, rel, script):
        path = self.home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path))
        conn.executescript(script)
        conn.commit()
        conn.close()

    def test_hermes_per_model_rows_and_uncovered_session_totals(self):
        self.db(".hermes/state.db", """
            CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT, started_at REAL, message_count INT, input_tokens INT,
              output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, actual_cost_usd REAL, estimated_cost_usd REAL);
            CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, input_tokens INT, output_tokens INT,
              cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, actual_cost_usd REAL, estimated_cost_usd REAL);
            INSERT INTO sessions VALUES ('a', 'gpt-4.1', 'copilot', 1793000000.5, 3, 999, 999, 0, 0, 0, NULL, 9.0);
            INSERT INTO sessions VALUES ('b', 'gpt-4.1', NULL, 1793000100, 2, 50, 5, 0, 0, 0, NULL, 0);
            INSERT INTO session_model_usage VALUES ('a', 'gpt-4.1', 'copilot', 100, 10, 0, 0, 4, 0, 0.002);
            INSERT INTO session_model_usage VALUES ('a', 'gpt-4.1', 'copilot', 20, 2, 0, 0, 0, 0, 0.001);
        """)
        rows = {r["source_key"]: r for r in rows_of(hermes, ctx(self.home))}
        check_row_shape(self, rows.values(), "hermes")
        self.assertEqual(set(rows), {"hermes:h1:a:gpt-4.1:copilot", "hermes:h1:b"})
        a = rows["hermes:h1:a:gpt-4.1:copilot"]
        self.assertEqual((a["input_tokens"], a["output_tokens"], a["reasoning_tokens"], a["call_at"]), (120, 12, 4, 1793000000500))
        self.assertEqual(a["cost_source"], "reported")
        self.assertAlmostEqual(a["cost_input_usd"] + a["cost_output_usd"], 0.003)
        self.assertEqual(rows["hermes:h1:b"]["cost_source"], prices.SOURCE)

    def test_goose_uses_accumulated_counters_and_gap_as_reasoning(self):
        self.db(".local/share/goose/sessions/sessions.db", """
            CREATE TABLE sessions (id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT, total_tokens INT,
              input_tokens INT, output_tokens INT, accumulated_total_tokens INT, accumulated_input_tokens INT, accumulated_output_tokens INT);
            INSERT INTO sessions VALUES ('g1', '{"model_name":"claude-sonnet-4-6"}', 'anthropic', '2026-11-01 00:00:00', 10, 5, 5, 130, 100, 20);
            INSERT INTO sessions VALUES ('g2', '{"model_name":" "}', 'anthropic', '2026-11-01 00:00:00', 10, 5, 5, NULL, NULL, NULL);
        """)
        rows = rows_of(goose, ctx(self.home))
        check_row_shape(self, rows, "goose")
        self.assertEqual([(r["source_key"], r["input_tokens"], r["output_tokens"], r["reasoning_tokens"]) for r in rows],
                         [("goose:h1:g1", 100, 30, 10)])

    def test_opencode_assistant_rows_with_reported_cost(self):
        msg = {"role": "assistant", "modelID": "claude-sonnet-4-6", "providerID": "anthropic", "sessionID": "ses1",
               "tokens": {"input": 10, "output": 20, "reasoning": 5, "cache": {"read": 100, "write": 50}}, "cost": 0.01,
               "time": {"created": 1793000000000, "completed": 1793000002000}}
        self.db(".local/share/opencode/opencode.db", "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);"
                f"INSERT INTO message VALUES ('m1', 'ses1', '{json.dumps(msg)}');"
                f"INSERT INTO message VALUES ('m2', 'ses1', '{json.dumps(dict(msg, role='user'))}');")
        rows = rows_of(opencode, ctx(self.home))
        check_row_shape(self, rows, "opencode")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["source_key"], r["output_tokens"], r["reasoning_tokens"], r["duration_ms"], r["cost_source"]),
                         ("opencode:h1:m1", 25, 5, 2000, "reported"))


class VentTest(unittest.TestCase):
    def page(self, ns, env="staging", model="claude-opus-5-5(high)"):
        return {"ns": str(ns), "trace": "t1", "span": f"s{ns}", "env": env, "caller": "convex", "operation": "search_x",
                "integration": "cliproxy-anthropic", "provider": "anthropic", "model": model, "input": 2, "output": 10,
                "cache_read": 100, "cache_write": 50, "total_ms": 900}

    def test_rows_take_host_from_environment_and_advance_the_cursor(self):
        windows = []

        def query(sql):
            windows.append(sql)
            return [self.page(1795400000000000000), self.page(1795400001000000000, env="production")] if len(windows) == 1 else []

        since_ms = 1795400000000
        end_ns = since_ms * 10**6 + vent.WINDOW_NS + 5
        c = ctx("/nonexistent", host="us-metal02", since=since_ms)
        rows = [r for r in vent.collect(c, query=query, now_ns=end_ns) if r is not core.CHECKPOINT]
        self.assertEqual([r["host"] for r in rows], ["us-metal02", "us-metal01"])
        self.assertEqual(rows[0]["source_key"], "vent:us-metal02:t1:s1795400000000000000:1795400000000000000")
        self.assertEqual(rows[0]["cost_source"], prices.SOURCE)
        self.assertEqual(len(windows), 2)
        self.assertEqual(c.state["ns_cursor"], str(end_ns))
        check_row_shape(self, rows, "vent")
        again = [r for r in vent.collect(c, query=lambda sql: windows.append(sql) or [], now_ns=end_ns + 10**9) if r is not core.CHECKPOINT]
        self.assertEqual(again, [])
        self.assertIn(str(end_ns - vent.OVERLAP_NS), windows[-1])


class StableCallAtTest(unittest.TestCase):
    """usage.model_calls sorts by (host, client, row_id), so a key must carry the same call_at on every read:
    a rerun, a copy read first or last, and a file whose mtime moved."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def copy_fixture(self, name):
        shutil.copytree(FIXTURES / name, self.home, dirs_exist_ok=True)

    def times(self, module):
        return {r["source_key"]: r["call_at"] for r in rows_of(module, ctx(self.home))}

    def touch_all(self, seconds):
        for p in self.home.rglob("*"):
            if p.is_file():
                os.utime(p, (seconds, seconds))

    def assert_stable(self, module):
        first = self.times(module)
        self.assertTrue(first)
        self.touch_all(1_900_000_000)
        self.assertEqual(self.times(module), first)
        return first

    def test_codex_copies_and_untimed_events(self):
        self.copy_fixture("codex")
        untimed = [{"type": "session_meta", "payload": {"id": U3, "model_provider": "openai"}},
                   {"type": "turn_context", "payload": {"model": "gpt-5.5"}},
                   {"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 9, "output_tokens": 1}}}}]
        name = f"rollout-2026-11-05T09-00-00-{U3}.jsonl"
        for folder, mtime in ((".codex/sessions/2026/11/05", 1_800_000_000), (".codex/archived_sessions", 1_850_000_000)):
            path = self.home / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("".join(json.dumps(e) + "\n" for e in untimed))
            os.utime(path, (mtime, mtime))
        first = self.assert_stable(codex)
        self.assertIn(int(U3.replace("-", "")[:12], 16), first.values())
        self.assertEqual(len(first), 5)

    def test_claude_code_copy_with_other_prompt_time_keeps_the_response_time(self):
        self.copy_fixture("claude_code")
        alone = self.times(claude_code)
        fork = self.home / ".claude/projects/-w/a-earlier-fork.jsonl"
        fork.write_text("".join(json.dumps(e) + "\n" for e in [
            {"type": "user", "timestamp": "2026-11-01T00:00:00.000Z", "sessionId": "s0", "message": {"role": "user", "content": "x"}},
            {"type": "assistant", "timestamp": "2026-11-02T00:00:02.000Z", "requestId": "req_1", "sessionId": "s0",
             "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 3, "output_tokens": 1}}}]))
        self.assertEqual(self.assert_stable(claude_code), alone)
        self.assertEqual(alone["claude-code:h1:msg_1:req_1"], 1793577602000)

    def test_aside_rerun_and_untimed_record(self):
        self.copy_fixture("aside")
        path = next(self.home.rglob("messages.jsonl"))
        with open(path, "a") as fh:
            fh.write(json.dumps({"role": "assistant", "model": "gpt-6-astra", "responseId": "r9", "usage": {"input": 5}}) + "\n")
        self.assertNotIn("aside:h1:response:12:openai-codex:r9", self.assert_stable(aside))

    def test_sqlite_and_vent_clients_read_time_from_the_record(self):
        SqliteClientsTest.db(self, ".hermes/state.db", """
            CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT, started_at REAL, message_count INT, input_tokens INT,
              output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, actual_cost_usd REAL, estimated_cost_usd REAL);
            INSERT INTO sessions VALUES ('b', 'gpt-4.1', NULL, 1793000100, 2, 50, 5, 0, 0, 0, NULL, 0);""")
        SqliteClientsTest.db(self, ".local/share/goose/sessions/sessions.db", """
            CREATE TABLE sessions (id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT, total_tokens INT,
              input_tokens INT, output_tokens INT, accumulated_total_tokens INT, accumulated_input_tokens INT, accumulated_output_tokens INT);
            INSERT INTO sessions VALUES ('g1', '{"model_name":"claude-sonnet-4-6"}', 'anthropic', '2026-11-01 00:00:00', 10, 5, 5, NULL, NULL, NULL);""")
        msg = {"role": "assistant", "modelID": "m", "providerID": "anthropic", "tokens": {"input": 1, "output": 1},
               "time": {"created": 1793000000000}}
        SqliteClientsTest.db(self, ".local/share/opencode/opencode.db",
                             f"CREATE TABLE message (id TEXT, session_id TEXT, data TEXT); INSERT INTO message VALUES ('m1', 's', '{json.dumps(msg)}');")
        self.assertEqual(self.assert_stable(hermes), {"hermes:h1:b": 1793000100000})
        self.assertEqual(self.assert_stable(goose), {"goose:h1:g1": 1793491200000})
        self.assertEqual(self.assert_stable(opencode), {"opencode:h1:m1": 1793000000000})
        page = VentTest.page(None, 1795400000123456789)
        runs = [[r["call_at"] for r in vent.collect(ctx(self.home, since=1795400000000), query=lambda sql: [page], now_ns=1795400000200000000)
                 if r is not core.CHECKPOINT] for _ in range(2)]
        self.assertEqual(runs, [[1795400000123], [1795400000123]])


class PricesTest(unittest.TestCase):
    def test_anthropic_one_hour_writes_cost_twice_input(self):
        c = prices.cost("claude-opus-4-5-20251101", "anthropic", 0, 0, 0, 1_000_000, 400_000)
        self.assertAlmostEqual(c["cost_cache_write_usd"], 6.25 * 0.6 + 10.0 * 0.4)

    def test_suffixes_dates_and_prefixes_resolve(self):
        for model in ("claude-opus-5-5(high)", "claude-opus-4-6[1m]", "anthropic/claude-opus-4-6", "claude-sonnet-4-5-20250929"):
            self.assertIsNotNone(prices.lookup(model), model)

    def test_vendor_price_beats_a_resellers(self):
        self.assertTrue(prices.lookup("gpt-5-codex")[5].startswith("litellm"))

    def test_unknown_model_is_unpriced_not_zero_priced(self):
        self.assertEqual(prices.cost("no-such-model", "", 1, 1, 0, 0)["cost_source"], prices.UNPRICED)


if __name__ == "__main__":
    unittest.main()
