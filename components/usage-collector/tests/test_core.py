from __future__ import annotations

import tempfile
import types
import unittest
from pathlib import Path

from helpers import FakeSink

from usage_collector import core
from usage_collector.state import StateStore


def numbered(count: int, per_checkpoint: int):
    """A client that yields `count` rows and stores how far it got, with a checkpoint every `per_checkpoint` rows."""

    def collect(ctx):
        start = ctx.state.get("next", 0)
        for n in range(start, count):
            yield {"source_key": f"test:h1:{n}", "call_at": 1795400000000 + n, "provider": "anthropic", "model": "m",
                   "input_tokens": 1, "output_tokens": 2, "cost_output_usd": 1.6e-05, "cost_source": "reported"}
            ctx.state["next"] = n + 1
            if (n + 1) % per_checkpoint == 0:
                yield core.CHECKPOINT
        ctx.state["next"] = count

    return types.SimpleNamespace(CLIENT="test", collect=collect)


def context(store: StateStore) -> core.Context:
    return core.Context(host="h1", since=0, home=Path("/nonexistent"), state=store.load("test"))


class CoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.dir.name))

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_normalize_formats_time_and_costs(self) -> None:
        row = core.normalize({"source_key": "test:h1:1", "call_at": 1795473490322, "provider": "p", "model": "m",
                              "cost_input_usd": 1.6e-05, "input_tokens": 2**40, "cost_source": "reported"}, "test", "h1")
        self.assertEqual(row["call_at"], "2026-11-23 22:38:10.322")
        self.assertEqual(row["cost_input_usd"], "0.000016000")
        self.assertEqual(row["input_tokens"], 2**32 - 1)
        self.assertEqual(list(row), list(core.COLUMNS))

    def test_key_must_name_client_and_host(self) -> None:
        with self.assertRaises(core.RowError):
            core.normalize({"source_key": "other:h1:1", "call_at": 0, "provider": "p", "model": "m", "cost_source": "x"}, "test", "h1")

    def test_cursor_is_saved_only_after_the_rows_are_written(self) -> None:
        sink = FakeSink(fail_on=3)
        module = numbered(10, 2)
        with self.assertRaises(OSError):
            core.run_client(module, context(self.store), sink, self.store, max_bytes=500)
        self.assertEqual(len(sink.posts), 2, "a row is about 400 bytes, so each POST of at most 500 bytes holds one row")
        self.assertEqual(self.store.load("test").get("next"), 2, "the cursor stops at the last checkpoint whose POSTs all landed")
        stats = core.run_client(module, context(self.store), FakeSink(), self.store, max_bytes=500)
        self.assertEqual(stats.rows, 8)
        self.assertEqual(self.store.load("test")["next"], 10)

    def test_rerun_after_a_crash_ends_with_the_same_rows(self) -> None:
        clean = FakeSink()
        core.run_client(numbered(10, 2), context(StateStore(Path(self.dir.name) / "clean")), clean, StateStore(Path(self.dir.name) / "clean"), 500)
        crashed = FakeSink(fail_on=3)
        with self.assertRaises(OSError):
            core.run_client(numbered(10, 2), context(self.store), crashed, self.store, 500)
        core.run_client(numbered(10, 2), context(self.store), crashed, self.store, 500)
        self.assertEqual(sorted(r["source_key"] for r in crashed.rows()), sorted(r["source_key"] for r in clean.rows()))
        self.assertEqual([t for _, t in crashed.posts], [t for _, t in clean.posts], "the same batches carry the same tokens")

    def test_second_run_writes_nothing(self) -> None:
        sink = FakeSink()
        core.run_client(numbered(5, 2), context(self.store), sink, self.store, 500)
        posts = len(sink.posts)
        stats = core.run_client(numbered(5, 2), context(self.store), sink, self.store, 500)
        self.assertEqual((stats.rows, len(sink.posts)), (0, posts))

    def test_batches_respect_the_body_cap(self) -> None:
        sink = FakeSink()
        core.run_client(numbered(50, 50), context(self.store), sink, self.store, 1000)
        self.assertTrue(all(len(body) <= 1000 for body, _ in sink.posts))
        self.assertEqual(len(sink.rows()), 50)

    def test_dry_run_saves_nothing(self) -> None:
        stats = core.run_client(numbered(5, 2), context(self.store), None, None, 500)
        self.assertEqual(stats.rows, 5)
        self.assertFalse(self.store.exists())

    def test_a_second_process_cannot_take_a_held_client(self) -> None:
        held = self.store.lock("test")
        self.assertIsNotNone(held)
        self.assertIsNone(self.store.lock("test"))
        held.release()
        again = self.store.lock("test")
        self.assertIsNotNone(again)
        again.release()


if __name__ == "__main__":
    unittest.main()
