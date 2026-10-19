"""backfill writes each call's usage as per-minute counter samples, so increase() over minute-aligned windows adds up those minutes."""
import gzip, importlib.util, json, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("backfill", HERE / "backfill.py")
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


def entry(call_id, ended, output, started_ms):
    return {"type": "message", "id": call_id, "timestamp": ended, "message": {
        "role": "assistant", "provider": "anthropic", "model": "claude-opus-5-5", "responseId": call_id, "stopReason": "stop",
        "timestamp": started_ms, "usage": {"input": 1, "output": output, "cacheRead": 2, "cacheWrite": 3, "cost": {"total": 0.5}}}}


def increase(points, start, end):
    """The delta of a cumulative series over (start, end], as Prometheus reads it when samples sit 1 ms inside the window."""
    inside = [value for at, value in points if start < at <= end]
    return inside[-1] - inside[0] if len(inside) > 1 else 0


class Samples(unittest.TestCase):
    def test_minute_pairs_add_up_each_window(self):
        minutes = {10: 5.0, 12: 7.0}
        points = list(backfill.samples("prime_agent_tokens", minutes, 14))
        self.assertEqual(points[0], (10 * 60_000 + 1, 0.0))
        self.assertEqual(points[-1], (14 * 60_000 + 59_999, 12.0))
        self.assertEqual([increase(points, m * 60_000, (m + 1) * 60_000) for m in range(10, 15)], [5, 0, 7, 0, 0])
        self.assertEqual(increase(points, 10 * 60_000, 15 * 60_000), 12)

    def test_session_series_start_from_the_earlier_total(self):
        points = list(backfill.samples("prime_agent_session_output_tokens", {3: 4.0, 9: 6.0}, 20, active=[9]))
        self.assertEqual(points, [(9 * 60_000 + 1, 4.0), (9 * 60_000 + 59_999, 10.0)])


class Extract(unittest.TestCase):
    def test_copies_count_once_and_calls_after_until_drop(self):
        prime = Path(tempfile.mkdtemp())
        (prime / "sessions").mkdir()
        (prime / "sessions-archive").mkdir()
        header = json.dumps({"type": "session", "id": "s1"}) + "\n"
        body = header + json.dumps(entry("r1", "2026-10-18T01:00:30Z", 10, 1792285200000)) + "\n" \
            + json.dumps(entry("r2", "2026-10-19T17:00:00Z", 20, 1792429190000)) + "\n"
        (prime / "sessions" / "s1.jsonl").write_text(body)
        (prime / "sessions-archive" / "s1.jsonl").write_text(body)
        out = prime / "calls.jsonl.gz"
        args = type("Args", (), {"until": "2026-10-19T16:00Z", "out": str(out), "prime": str(prime)})
        backfill.extract(args)
        calls = [json.loads(line) for line in gzip.open(out, "rt")]
        self.assertEqual([c[0] for c in calls], ["r1"])
        self.assertEqual(calls[0][3:9], ["s1", "anthropic", "claude-opus-5-5", "stop", 1, 10])


if __name__ == "__main__":
    unittest.main()
