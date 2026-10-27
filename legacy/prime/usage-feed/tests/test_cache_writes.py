"""cache_writes splits each call's cache write into growth and a lost prefix, and names why the prefix was lost."""
import importlib.util, json, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("cache_writes", HERE / "cache_writes.py")
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

T0 = 1792700000.0


def call(at, read, write, model="claude-opus-5-5", stop="toolUse"):
    return json.dumps({"type": "message", "timestamp": at * 1000, "message": {"role": "assistant", "provider": "anthropic", "model": model,
                       "stopReason": stop, "usage": {"input": 2, "output": 300, "cacheRead": read, "cacheWrite": write}}})


def rows(*lines):
    return list(cw.session_calls([json.dumps({"type": "session", "id": "s1"}), *lines], "metal", T0, T0 + 7200))


class CacheWrites(unittest.TestCase):
    def test_a_warm_call_writes_only_growth(self):
        calls = rows(call(T0, 636, 20000), call(T0 + 5, 20638, 900))
        self.assertEqual([cw.classify(c, {}) for c in calls], [("first call", 20000), ("growth", 0)])

    def test_a_call_after_an_idle_gap_over_the_ttl_loses_the_prefix(self):
        calls = rows(call(T0, 636, 20000), call(T0 + 3700, 636, 20900))
        self.assertEqual(cw.classify(calls[1], {}, ttl_s=3600), ("idle over TTL", 20002))

    def test_a_pool_switch_between_two_calls_is_named_with_its_reason(self):
        calls = rows(call(T0, 636, 20000), call(T0 + 60, 636, 20900))
        moves = {"s1": [(T0 + 30, "limited")]}
        self.assertEqual(cw.classify(calls[1], moves), ("account switch (limited)", 20002))

    def test_a_pool_switch_of_the_tree_root_counts_for_its_subagent(self):
        calls = list(cw.session_calls([json.dumps({"type": "session", "id": "child"}), call(T0, 636, 20000), call(T0 + 60, 636, 20900)],
                                      "metal", T0, T0 + 7200, root="root1"))
        self.assertEqual(cw.classify(calls[1], {"root1": [(T0 + 30, "depleted")]}), ("account switch (depleted)", 20002))

    def test_a_compaction_and_an_unexplained_break_are_told_apart(self):
        calls = rows(call(T0, 636, 20000), json.dumps({"type": "compaction"}), call(T0 + 60, 636, 9000), call(T0 + 70, 636, 9500))
        self.assertEqual(cw.classify(calls[1], {})[0], "compaction")
        self.assertEqual(cw.classify(calls[2], {})[0], "prefix changed")

    def test_errors_are_skipped_and_the_pool_log_reads_in_its_own_zone(self):
        calls = rows(call(T0, 636, 20000), call(T0 + 10, 0, 0, stop="error"), call(T0 + 20, 20638, 400))
        self.assertEqual(len(calls), 2)
        moves = cw.switches([json.dumps({"ts": "2026-10-23T09:00:00", "event": "switch", "session": "s1", "why": "limited"})], 9)
        self.assertEqual(moves["s1"][0][0], 1792713600.0)

    def test_an_idle_gap_that_follows_a_failed_call_names_the_failure(self):
        failed = json.dumps({"type": "message", "timestamp": (T0 + 10) * 1000, "message": {"role": "assistant", "stopReason": "error",
                             "errorMessage": "Provider rate limit exceeded (rate_limit_error, 429)", "usage": {"input": 0, "cacheRead": 0, "cacheWrite": 0}}})
        calls = rows(call(T0, 636, 20000), failed, call(T0 + 4000, 636, 20900))
        self.assertEqual(cw.classify(calls[1], {}, ttl_s=3600), ("idle over TTL after a failed call (rate_limit)", 20002))

    def test_rank_orders_causes_by_tokens_written(self):
        calls = rows(call(T0, 636, 20000), call(T0 + 3700, 636, 20900), call(T0 + 3705, 21538, 500))
        ranked = cw.rank(calls, {}, ttl_s=3600)
        self.assertEqual(list(ranked["causes"]), ["idle over TTL", "first call", "growth"])
        self.assertEqual(ranked["causes"]["growth"]["written"], 20900 - 20002 + 500)


if __name__ == "__main__":
    unittest.main()
