"""usage-feed turns transcript usage into the counters Prime's OTLP exporter writes, and counts only calls after it starts."""
import importlib.util, json, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("feed", Path(__file__).resolve().parents[1] / "feed.py")
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)

HEADER = {"type": "session", "version": 3, "id": "s1", "timestamp": "2026-10-19T15:37:49.437Z"}


def call(output=175, cache_read=636, stop="toolUse"):
    return {"type": "message", "timestamp": "2026-10-19T15:38:07.084Z", "message": {
        "role": "assistant", "provider": "anthropic", "model": "claude-opus-5-5", "stopReason": stop, "timestamp": 1792424282084,
        "usage": {"input": 4, "output": output, "cacheRead": cache_read, "cacheWrite": 14968, "cost": {"total": 0.12}}}}


def lines(*entries):
    return "".join(json.dumps(entry) + "\n" for entry in entries)


def values(usage, name):
    metric = next(m for m in usage.payload({"service.name": "prime-agent"}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] if m["name"] == name)
    return {tuple((a["key"], a["value"]["stringValue"]) for a in p["attributes"] if a["key"] in ("kind", "stop_reason")): p.get("asInt", p.get("asDouble")) for p in metric["sum"]["dataPoints"]}


class Feed(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.files = []
        self.usage = feed.Usage()
        self.tail = feed.Tail(lambda: iter(self.files))

    def transcript(self, name, text):
        path = self.dir / name
        path.write_text(text)
        if path not in self.files:
            self.files.append(path)
        return path

    def test_calls_before_the_feed_started_are_not_counted_and_later_ones_are(self):
        path = self.transcript("old.jsonl", lines(HEADER, call(output=999)))
        self.assertEqual(self.tail.read(self.usage), 0)
        path.write_text(path.read_text() + lines(call()))
        self.assertEqual(self.tail.read(self.usage), 1)
        self.usage.settle()
        self.assertEqual(values(self.usage, "prime_agent.tokens")[(("kind", "output"),)], "175")

    def test_a_transcript_that_appears_later_is_read_from_its_start_with_its_session(self):
        self.tail.read(self.usage)
        self.transcript("new.jsonl", lines(HEADER, call(), call(stop="stop")))
        self.assertEqual(self.tail.read(self.usage), 2)
        self.usage.settle()
        self.assertEqual(values(self.usage, "prime_agent.calls"), {(("stop_reason", "toolUse"),): "1", (("stop_reason", "stop"),): "1"})
        points = [p for m in self.usage.payload({}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] if m["name"] == "prime_agent.session.output_tokens" for p in m["sum"]["dataPoints"]]
        self.assertIn({"key": "session", "value": {"stringValue": "s1"}}, points[0]["attributes"])

    def test_a_partial_last_line_waits_for_its_newline(self):
        self.tail.read(self.usage)
        text = lines(HEADER) + json.dumps(call())
        path = self.transcript("partial.jsonl", text)
        self.assertEqual(self.tail.read(self.usage), 0)
        path.write_text(text + "\n")
        self.assertEqual(self.tail.read(self.usage), 1)

    def test_a_new_series_goes_out_as_zero_first_so_increase_counts_its_first_call(self):
        self.tail.read(self.usage)
        self.transcript("new.jsonl", lines(HEADER, call()))
        self.tail.read(self.usage)
        self.assertEqual(values(self.usage, "prime_agent.tokens")[(("kind", "cache_read"),)], "0")
        self.usage.settle()
        self.assertEqual(values(self.usage, "prime_agent.tokens")[(("kind", "cache_read"),)], "636")

    def test_series_carry_the_feed_label_and_the_names_lgtm_reads(self):
        self.tail.read(self.usage)
        self.transcript("new.jsonl", lines(HEADER, call()))
        self.tail.read(self.usage)
        metrics = self.usage.payload({}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        self.assertEqual([m["name"] for m in metrics], ["prime_agent.tokens", "prime_agent.cost", "prime_agent.calls",
                                                         "prime_agent.session.output_tokens", "prime_agent.session.generation_seconds"])
        for metric in metrics:
            for point in metric["sum"]["dataPoints"]:
                self.assertIn({"key": "feed", "value": {"stringValue": "transcripts"}}, point["attributes"])

    def test_the_feed_hands_off_when_another_source_writes_this_box(self):
        answers = {"group": [{"metric": {"box": "us-metal02"}}], "count": [{"metric": {}, "value": [0, "3"]}]}
        self.assertEqual(feed.prime_exporter_box("i", lambda q: answers[q.split(" ")[0].split("(")[0]]), "us-metal02")
        answers["count"] = []
        self.assertIsNone(feed.prime_exporter_box("i", lambda q: answers[q.split(" ")[0].split("(")[0]]))


if __name__ == "__main__":
    unittest.main()
