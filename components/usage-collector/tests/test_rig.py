"""Against a real ClickHouse: set USAGE_RIG_URL (the rig in ~/work/usage-one-source/rig.md is http://127.0.0.1:18123/). Each test makes its
own table from schema.sql and drops it after."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import assistant, pi_host_db, transcript

from usage_collector import cli
from usage_collector.sink import DATABASE, TABLE, Sink

RIG = os.environ.get("USAGE_RIG_URL")
SCHEMA = Path(__file__).resolve().parents[1] / "schema.sql"
T0 = 1795400000000


@unittest.skipUnless(RIG, "USAGE_RIG_URL is not set")
class RigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.table = f"{DATABASE}.test_calls_{os.getpid()}"
        self.sink = Sink({"url": RIG, "table": self.table})
        statements = [s for s in "\n".join(l for l in SCHEMA.read_text().splitlines() if not l.startswith("--")).split(";") if s.strip()]
        for statement in statements:
            self.sink.query(statement.replace(TABLE, self.table))
        # a background merge would fold duplicate keys at a random moment, and the raw counts below must count every inserted row
        self.sink.query(f"SYSTEM STOP MERGES {self.table}")
        self.config = root / "sink.json"
        self.config.write_text(json.dumps({"url": RIG, "table": self.table, "max_body_bytes": 2000}))
        self.home = root / "home"
        chat = self.home / ".pi/agent/chat"
        chat.mkdir(parents=True)
        (chat / "agents.json").write_text(json.dumps({"v": 1, "agents": [{"id": "ag_a", "name": "agent a", "workThread": "t1"}], "aliases": {}}))
        pi_host_db(self.home, [("t1", n, T0 + n, 0.001) for n in range(1, 21)], {"t1": "agent a"})
        prime = self.home / ".prime/agent"
        transcript(prime / "sessions/s1.jsonl", "s1", [assistant(f"e{n}", T0 + n, f"msg_{n}") for n in range(1, 16)], name="chat one")
        transcript(prime / "sessions/s2.jsonl", "s2", [assistant("e1", T0 + 1, "msg_1"), assistant("x1", T0 + 99, "msg_99")])

    def tearDown(self) -> None:
        self.sink.query(f"DROP TABLE IF EXISTS {self.table}")
        self.dir.cleanup()

    def collect(self, state: str) -> int:
        return cli.main(["collect", "--since", "3650d", "--client", "pi-host", "--client", "prime", "--sink", str(self.config),
                         "--state-dir", str(Path(self.dir.name) / state), "--home", str(self.home), "--host", "rig"])

    def counts(self) -> tuple:
        final = int(self.sink.query(f"SELECT count() FROM {self.table} FINAL"))
        raw = int(self.sink.query(f"SELECT count() FROM {self.table}"))
        return final, raw

    def test_rerun_writes_no_row(self) -> None:
        self.assertEqual(self.collect("state"), 0)
        # 20 pi-host rows and 16 Prime calls. s2 repeats msg_1 from s1 in another POST, so that key has two rows until a merge.
        self.assertEqual(self.counts(), (36, 37))
        self.assertEqual(self.collect("state"), 0)
        self.assertEqual(self.counts(), (36, 37), "a second run with its cursor sends nothing")
        self.assertEqual(self.collect("fresh-state"), 0)
        self.assertEqual(self.counts(), (36, 37), "a run with no cursor sends the same batches, and insert dedup drops each")
        cost = self.sink.query(f"SELECT toString(sum(cost_usd)) FROM {self.table} FINAL WHERE client = 'pi-host'").strip()
        self.assertEqual(cost, "0.0802", "20 rows of 0.00001 + 0.0025 + 0.0005 + 0.001")

    def test_copies_that_disagree_on_call_at_fold_into_one_row(self) -> None:
        """call_at is not in the sort key, so even a copy with another time (none seen: 0 of 3,169,290 Prime keys on us-metal02 on 11-23
        had two call_at values) is one row under FINAL."""
        transcript(self.home / ".prime/agent/sessions/s3.jsonl", "s3", [assistant("e1", T0 + 5000, "msg_1")])
        self.assertEqual(self.collect("state"), 0)
        self.assertEqual(int(self.sink.query(f"SELECT count() FROM {self.table} FINAL WHERE source_key = 'prime:rig:msg_1'")), 1)
        self.assertGreaterEqual(int(self.sink.query(f"SELECT count() FROM {self.table} WHERE source_key = 'prime:rig:msg_1'")), 2)
        self.assertEqual(int(self.sink.query(f"SELECT uniqExact(call_at) FROM {self.table} WHERE source_key = 'prime:rig:msg_1'")), 2)

    def test_a_new_sink_is_backfilled(self) -> None:
        self.assertEqual(self.collect("state"), 0)
        other = f"{self.table}_next"
        for statement in [s for s in "\n".join(l for l in SCHEMA.read_text().splitlines() if not l.startswith("--")).split(";") if s.strip()]:
            self.sink.query(statement.replace(TABLE, other))
        try:
            self.config.write_text(json.dumps({"url": RIG, "table": other, "max_body_bytes": 2000}))
            self.assertEqual(self.collect("state"), 0)
            self.assertEqual(int(self.sink.query(f"SELECT count() FROM {other} FINAL")), 36, "the same state folder starts the new sink from no cursor")
        finally:
            self.sink.query(f"DROP TABLE IF EXISTS {other}")

    def test_crash_mid_run_then_rerun(self) -> None:
        real = Sink.insert
        calls = {"n": 0}

        def flaky(sink, body, token):
            calls["n"] += 1
            if calls["n"] == 4:
                raise OSError("connection reset")
            return real(sink, body, token)

        with mock.patch.object(Sink, "insert", flaky):
            self.assertEqual(self.collect("state"), 1)
        self.assertLess(self.counts()[0], 36)
        self.assertEqual(self.collect("state"), 0)
        self.assertEqual(self.counts(), (36, 37), "the rerun resends the failed POST's batch and the ones the crash dropped, nothing more")
        self.assertEqual(self.collect("fresh-state"), 0)
        self.assertEqual(self.counts(), (36, 37))


if __name__ == "__main__":
    unittest.main()
