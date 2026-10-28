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
        self.tail = feed.Tail(lambda: iter(self.files), walk_every_s=0)

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
                                                         "prime_agent.session.output_tokens", "prime_agent.session.generation_seconds",
                                                         "prime_agent.generation.output_tokens", "prime_agent.generation.seconds"])
        for metric in metrics:
            for point in metric["sum"]["dataPoints"]:
                self.assertIn({"key": "feed", "value": {"stringValue": "transcripts"}}, point["attributes"])

    def test_a_session_stops_going_out_once_idle_and_comes_back_with_its_total_on_its_next_call(self):
        clock = [1000.0]
        usage = feed.Usage(lambda: clock[0])
        usage.record(call(), "s1")
        usage.settle()
        names = lambda: [m["name"] for m in usage.payload({}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]]
        self.assertIn("prime_agent.session.output_tokens", names())
        clock[0] += feed.SESSION_IDLE_S + 1
        self.assertNotIn("prime_agent.session.output_tokens", names())
        self.assertIn("prime_agent.generation.output_tokens", names())
        usage.record(call(output=25), "s1")
        usage.settle()
        points = [p for m in usage.payload({}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] if m["name"] == "prime_agent.session.output_tokens" for p in m["sum"]["dataPoints"]]
        self.assertEqual([p["asInt"] for p in points], ["200"])

    def test_model_speed_counters_carry_no_session_label(self):
        self.usage.record(call(), "s1")
        self.usage.settle()
        metrics = {m["name"]: m for m in self.usage.payload({}, 0, 1)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]}
        for name in ("prime_agent.generation.output_tokens", "prime_agent.generation.seconds"):
            keys = [a["key"] for a in metrics[name]["sum"]["dataPoints"][0]["attributes"]]
            self.assertNotIn("session", keys)
        self.assertEqual(metrics["prime_agent.generation.output_tokens"]["sum"]["dataPoints"][0]["asInt"], "175")
        self.assertAlmostEqual(metrics["prime_agent.generation.seconds"]["sum"]["dataPoints"][0]["asDouble"], 5.0, places=3)

    def test_the_feed_hands_off_when_another_source_writes_this_box(self):
        answers = {"group": [{"metric": {"box": "us-metal02"}}], "count": [{"metric": {}, "value": [0, "3"]}]}
        self.assertEqual(feed.prime_exporter_box("i", lambda q: answers[q.split(" ")[0].split("(")[0]]), "us-metal02")
        answers["count"] = []
        self.assertIsNone(feed.prime_exporter_box("i", lambda q: answers[q.split(" ")[0].split("(")[0]]))


    def test_transcripts_finds_prime_files_pi_host_cwd_folders_and_rlm_children(self):
        prime = self.dir / "agent"
        (prime / "sessions" / "--home-sieun-ws--").mkdir(parents=True)
        (prime / "session-artifacts" / "root" / "sub-0000abcd").mkdir(parents=True)
        for path in [prime / "sessions" / "a.jsonl", prime / "sessions" / "--home-sieun-ws--" / "2026-10-27T07-34-36-470Z_b.jsonl",
                     prime / "session-artifacts" / "root" / "sub-0000abcd" / "c.jsonl"]:
            path.write_text(lines(HEADER))
        (prime / "sessions" / "--home-sieun-ws--" / "notes.txt").write_text("x")
        found = sorted(path.name for path in feed.transcripts(prime))
        self.assertEqual(found, ["2026-10-27T07-34-36-470Z_b.jsonl", "a.jsonl", "c.jsonl"])

    def test_between_walks_only_files_that_grew_since_the_walk_before_are_read(self):
        clock, walks = [1000.0], []
        busy = self.transcript("busy.jsonl", lines(HEADER))
        quiet = self.transcript("quiet.jsonl", lines(HEADER))
        tail = feed.Tail(lambda: walks.append(clock[0]) or iter(self.files), clock=lambda: clock[0])
        tail.read(self.usage)
        busy.write_text(busy.read_text() + lines(call()))
        clock[0] += feed.WALK_EVERY_S
        self.assertEqual(tail.read(self.usage), 1)
        self.assertEqual(tail.hot, {busy})
        busy.write_text(busy.read_text() + lines(call()))
        quiet.write_text(quiet.read_text() + lines(call()))
        clock[0] += feed.INTERVAL_S
        self.assertEqual(tail.read(self.usage), 1)
        self.assertEqual(len(walks), 2)
        clock[0] += feed.WALK_EVERY_S
        self.assertEqual(tail.read(self.usage), 1)
        self.assertEqual(len(walks), 3)
        self.assertEqual(tail.hot, {busy, quiet})

    def test_a_new_file_waits_for_the_next_walk_and_is_read_from_its_start(self):
        clock = [1000.0]
        tail = feed.Tail(lambda: iter(self.files), clock=lambda: clock[0])
        tail.read(self.usage)
        self.transcript("new.jsonl", lines(HEADER, call(), call()))
        clock[0] += feed.INTERVAL_S
        self.assertEqual(tail.read(self.usage), 0)
        clock[0] += feed.WALK_EVERY_S
        self.assertEqual(tail.read(self.usage), 2)

    def test_a_walk_forgets_files_that_are_gone(self):
        path = self.transcript("gone.jsonl", lines(HEADER))
        self.tail.read(self.usage)
        self.files.remove(path)
        self.tail.read(self.usage)
        self.assertNotIn(path, self.tail.offsets)

if __name__ == "__main__":
    unittest.main()
