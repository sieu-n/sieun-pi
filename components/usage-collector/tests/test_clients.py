from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from helpers import FakeSink, assistant, pi_host_db, transcript

from usage_collector import core
from usage_collector.clients import pi_host, prime
from usage_collector.state import StateStore

T0 = 1795400000000


class ClientCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name) / "home"
        self.store = StateStore(Path(self.dir.name) / "state")
        self.sink = FakeSink()

    def tearDown(self) -> None:
        self.dir.cleanup()

    def run_once(self, module, since: int = 0, cache=None) -> core.Stats:
        ctx = core.Context(host="h1", since=since, home=self.home, state=self.store.load(module.CLIENT), cache=cache if cache is not None else {})
        return core.run_client(module, ctx, self.sink, self.store, 1_000_000)


class PiHostTest(ClientCase):
    def setUp(self) -> None:
        super().setUp()
        chat = self.home / ".pi/agent/chat"
        chat.mkdir(parents=True)
        (chat / "agents.json").write_text(json.dumps({"v": 1, "agents": [
            {"id": "ag_a", "name": "agent a", "workThread": "t-work", "comm": {"dm_a": "t-comm"}}], "aliases": {"t-job": "ag_a"}}))

    def test_rows_keys_agents_and_cursor(self) -> None:
        pi_host_db(self.home, [("t-work", 1, T0, 0.001), ("t-comm", 1, T0 + 1, 0.002), ("t-job", 7, T0 + 2, 0), ("t-other", 2, T0 + 3, 0)],
                   {"t-work": "agent a", "t-other": "loose thread"})
        self.run_once(pi_host)
        rows = {row["source_key"]: row for row in self.sink.rows()}
        self.assertEqual(sorted(rows), ["pi-host:h1:t-comm:1", "pi-host:h1:t-job:7", "pi-host:h1:t-other:2", "pi-host:h1:t-work:1"])
        self.assertEqual([rows[k]["agent"] for k in sorted(rows)], ["agent a", "agent a", "", "agent a"])
        self.assertEqual(rows["pi-host:h1:t-other:2"]["thread_name"], "loose thread")
        self.assertEqual((rows["pi-host:h1:t-work:1"]["provider"], rows["pi-host:h1:t-work:1"]["model"]), ("anthropic", "claude-opus-5-5"))
        self.assertEqual(rows["pi-host:h1:t-work:1"]["cost_cache_write_usd"], "0.001000000")
        self.assertEqual(self.run_once(pi_host).rows, 0)
        pi_host_db(self.home, [("t-work", 2, T0 + 10, 0)], {})
        self.assertEqual(self.run_once(pi_host).rows, 1)

    def test_refine_rows_with_negative_ids(self) -> None:
        pi_host_db(self.home, [("t-work", 1, T0, 0), ("t-work", -1795400000000001, T0 + 1, 0)], {})
        self.run_once(pi_host)
        rows = {row["source_key"]: row for row in self.sink.rows()}
        self.assertEqual(sorted(rows), ["pi-host:h1:t-work:-1795400000000001", "pi-host:h1:t-work:1"])
        self.assertEqual(rows["pi-host:h1:t-work:-1795400000000001"]["agent"], "agent a")

    def test_call_at_is_the_rows_own_time_on_every_run(self) -> None:
        pi_host_db(self.home, [("t-work", 1, T0, 0), ("t-work", 2, T0 + 7, 0)], {})
        self.run_once(pi_host)
        first = {row["source_key"]: row["call_at"] for row in self.sink.rows()}
        self.assertEqual(first["pi-host:h1:t-work:2"], "2026-11-23 02:13:20.007")
        pi_host_db(self.home, [("t-work", 3, T0 + 99, 0)], {})
        self.run_once(pi_host)
        self.store = StateStore(Path(self.dir.name) / "fresh")
        self.run_once(pi_host)
        for row in self.sink.rows():
            if row["source_key"] in first:
                self.assertEqual(row["call_at"], first[row["source_key"]])

    def test_since_skips_old_rows(self) -> None:
        pi_host_db(self.home, [("t-work", 1, T0, 0), ("t-work", 2, T0 + 5000, 0)], {})
        self.assertEqual(self.run_once(pi_host, since=T0 + 1000).rows, 1)

    def test_a_renumbered_table_is_read_again(self) -> None:
        path = pi_host_db(self.home, [("t-work", 1, T0, 0), ("t-work", 2, T0 + 1, 0)], {})
        self.run_once(pi_host)
        db = sqlite3.connect(str(path))
        db.executescript("CREATE TABLE u2 AS SELECT * FROM usage ORDER BY entry_id DESC; DELETE FROM usage; INSERT INTO usage SELECT * FROM u2;")
        db.commit()
        db.close()
        pi_host_db(self.home, [("t-work", 3, T0 + 2, 0)], {})
        self.run_once(pi_host)
        self.assertEqual(sorted({row["source_key"] for row in self.sink.rows()}),
                         ["pi-host:h1:t-work:1", "pi-host:h1:t-work:2", "pi-host:h1:t-work:3"])

    def test_chat_sqlite_agents(self) -> None:
        chat = self.home / ".pi/agent/chat"
        db = sqlite3.connect(str(chat / "chat.sqlite"))
        db.executescript("CREATE TABLE db_kinds (kind TEXT PRIMARY KEY); INSERT INTO db_kinds VALUES ('agents');"
                         "CREATE TABLE agents_agents (id TEXT PRIMARY KEY, ord INTEGER, room, work_thread, body TEXT);"
                         "CREATE TABLE agents_aliases (thread TEXT PRIMARY KEY, ord INTEGER, agent, body TEXT);")
        db.execute("INSERT INTO agents_agents VALUES ('ag_b', 0, 'dm_b', 't-b', ?)", (json.dumps({"id": "ag_b", "name": "agent b", "workThread": "t-b"}),))
        db.execute("INSERT INTO agents_aliases VALUES ('t-bj', 0, 'ag_b', '\"ag_b\"')")
        db.commit()
        db.close()
        self.assertEqual(pi_host.agent_by_thread(self.home), {"t-b": "agent b", "t-bj": "agent b"})


class PrimeTest(ClientCase):
    def setUp(self) -> None:
        super().setUp()
        self.prime = self.home / ".prime/agent"
        (self.prime / "browser-chat").mkdir(parents=True)
        (self.prime / "browser-chat/chat-jobs.json").write_text(json.dumps({"jobs": {"build the thing": {"chat": "CI chat", "chatId": "c1"}}}))

    def test_roots_children_copies_and_growth(self) -> None:
        root = self.prime / "sessions/s-root.jsonl"
        transcript(root, "s-root", [assistant("e1", T0, "msg_1"), assistant("e2", T0 + 10, None)], name="build the thing",
                   partial=b'{"type":"message","id":"e3"')
        child = self.prime / "session-artifacts/s-root/sub-abc/s-child.jsonl"
        transcript(child, "s-child", [assistant("c1", T0 + 20, "msg_2")])
        fork = self.prime / "sessions/s-fork.jsonl"
        transcript(fork, "s-fork", [assistant("e1", T0, "msg_1"), assistant("f2", T0 + 30, "msg_3")])
        (self.prime / "session-artifacts/s-root/sub-abc/rlm-subagents.jsonl").write_text(json.dumps(assistant("x", T0, "msg_x")) + "\n")
        cache: dict = {}
        self.run_once(prime, cache=cache)
        rows = self.sink.rows()
        keys = sorted({row["source_key"] for row in rows})
        self.assertEqual(keys, sorted(["prime:h1:msg_1", "prime:h1:msg_2", "prime:h1:msg_3",
                                       f"prime:h1:msg:e2:{assistant('e2', T0 + 10, None)['timestamp']}"]))
        by_key = {row["source_key"]: row for row in rows}
        self.assertEqual((by_key["prime:h1:msg_2"]["agent"], by_key["prime:h1:msg_2"]["thread"], by_key["prime:h1:msg_2"]["session"]),
                         ("CI chat", "s-root", "s-child"))
        self.assertEqual(by_key["prime:h1:msg_1"]["duration_ms"], 2000)
        self.assertEqual(by_key["prime:h1:msg_2"]["cost_output_usd"], "0.006990000")

        self.assertEqual(self.run_once(prime, cache={}).rows, 0, "a rerun reads nothing new")
        with open(root, "ab") as handle:
            handle.write(b',"timestamp":"x"}\n' + json.dumps(assistant("e4", T0 + 40, "msg_4"), separators=(",", ":")).encode() + b"\n")
        stats = self.run_once(prime, cache={})
        self.assertEqual(stats.rows, 1)
        self.assertEqual(self.sink.rows()[-1]["source_key"], "prime:h1:msg_4")
        self.assertEqual(self.sink.rows()[-1]["agent"], "CI chat")

    def test_call_at_is_the_entrys_own_time_on_every_run_and_copy(self) -> None:
        """call_at is the assistant entry's own timestamp, the end of the call, as usage-feed buckets it in LGTM. A fork copies the entry
        whole, so its copy has the same responseId and timestamp, and the two give one key with one call_at."""
        root = self.prime / "sessions/s-root.jsonl"
        transcript(root, "s-root", [assistant("e1", T0 + 123, "msg_1")])
        self.run_once(prime, cache={})
        first = self.sink.rows()[0]
        self.assertEqual(first["call_at"], "2026-11-23 02:13:20.123")
        with open(root, "ab") as handle:
            handle.write(json.dumps(assistant("e2", T0 + 500, "msg_2"), separators=(",", ":")).encode() + b"\n")
        self.run_once(prime, cache={})
        transcript(self.prime / "sessions/s-fork.jsonl", "s-fork", [assistant("e1", T0 + 123, "msg_1"), assistant("f1", T0 + 900, "msg_3")])
        self.store = StateStore(Path(self.dir.name) / "fresh")
        self.run_once(prime, cache={})
        copies = [row for row in self.sink.rows() if row["source_key"] == "prime:h1:msg_1"]
        self.assertEqual(len(copies), 3, "first run, fresh run of s-root, and the fork's copy")
        self.assertEqual({row["call_at"] for row in copies}, {first["call_at"]})
        self.assertEqual({row["source_key"] for row in copies}, {"prime:h1:msg_1"})

    def test_old_files_are_skipped_and_a_replaced_file_is_read_again(self) -> None:
        old = self.prime / "sessions/s-old.jsonl"
        transcript(old, "s-old", [assistant("o1", T0, "msg_o")])
        os.utime(old, (T0 / 1000 - 86400, T0 / 1000 - 86400))
        self.assertEqual(self.run_once(prime, since=T0 - 1000).rows, 0)
        new = self.prime / "sessions/s-new.jsonl"
        transcript(new, "s-new", [assistant("n1", T0, "msg_n")])
        self.assertEqual(self.run_once(prime, since=T0 - 1000).rows, 1)
        replacement = self.prime / "sessions/s-new.tmp"
        transcript(replacement, "s-new", [assistant("n1", T0, "msg_n"), assistant("n2", T0 + 1, "msg_n2")])
        os.replace(replacement, new)
        self.assertEqual(self.run_once(prime, since=T0 - 1000).rows, 2, "a new inode is read from its start; its old row keeps its key")

    def test_between_walks_only_hot_files_are_read(self) -> None:
        a = self.prime / "sessions/s-a.jsonl"
        transcript(a, "s-a", [assistant("a1", T0, "msg_a1")])
        cache: dict = {}
        self.run_once(prime, cache=cache)
        self.run_once(prime, cache=cache)
        b = self.prime / "sessions/s-b.jsonl"
        transcript(b, "s-b", [assistant("b1", T0, "msg_b1")])
        self.assertEqual(self.run_once(prime, cache=cache).rows, 0, "a new file waits for the next walk")
        cache["walked_at"] = 0
        self.assertEqual(self.run_once(prime, cache=cache).rows, 1)


if __name__ == "__main__":
    unittest.main()
