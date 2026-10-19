// Owner 10-18 (goal p16): the chat page feels fast from the Mac and never breaks; these cases pin how the Chat page from the Mac duty reads its sources.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserReadings, median, parsePing, releaseBreaks, replyExtra, type SendTiming } from "../scripts/duties/chat-page-mac.ts";

const at = Date.parse("2026-10-19T15:00:00Z");

test("median and ping parsing", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(parsePing("--- 100.83.139.73 ping statistics ---\n5 packets transmitted, 5 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 189.151/191.666/194.255/2.115 ms\n"), 191.666);
  assert.equal(parsePing("rtt min/avg/max/mdev = 0.020/0.031/0.045/0.008 ms"), 0.031);
  assert.equal(parsePing("ping: cannot resolve us-metal02-dev: Unknown host"), undefined);
});

test("cold loads take the median shown time in seconds, and a switch that never painted counts as the timeout", () => {
  const { load, tabs } = browserReadings({
    loads: [{ shown: 1619.6 }, { shown: 1493.7 }, { shown: null }, { error: "page.goto: net::ERR_TIMED_OUT" }, { shown: 1540.7, banner: "The Prime Agent daemon is not reachable." }],
    tabs: { switches: [{ id: "a", ms: 7.3 }, { id: "b", ms: 46 }, { id: "c", ms: null }], banner: null },
    load: 6.37,
  }, at, 10_000);
  assert.equal(load.value, 1.54);
  assert.equal(tabs.value, 46);
  assert.deepEqual(load.flagged.map(item => item.kind), ["cold_load", "cold_load_failed", "cold_load_failed", "banner_now"]);
  assert.match(load.flagged[0]!.excerpt, /3 of 5 cold loads showed the chat, median 1541 ms, worst 1620 ms; Mac 1-min load 6.4/);
  assert.equal(load.flagged[2]!.excerpt, "page.goto: net::ERR_TIMED_OUT");
  assert.deepEqual(tabs.flagged.map(item => [item.kind, item.item]), [["tab_switch", undefined], ["tab_switch_stuck", "c"]]);
});

test("tab switches that did not run leave the metric out with a source error", () => {
  const { tabs } = browserReadings({ loads: [{ shown: 900 }], tabs: { error: "locator.click: Timeout 5000ms exceeded" } }, at, 10_000);
  assert.equal(tabs.value, undefined);
  assert.equal(tabs.flagged[0]!.kind, "source_error");
});

const entry = (role: string, timestamp: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", timestamp, message: { role, content: [{ type: "text", text }], ...extra } });

test("the extra wait is the box's wait less the Mac's own turn, in round trips, and an error reply is timed and listed", () => {
  const session = [
    JSON.stringify({ type: "session", id: "x" }),
    entry("user", "2026-10-19T15:10:00.000Z", "chat page probe aaaa. Reply with exactly: ok"),
    entry("assistant", "2026-10-19T15:10:02.000Z", "ok", { stopReason: "stop" }),
    entry("user", "2026-10-19T15:10:10.000Z", "chat page probe bbbb. Reply with exactly: ok"),
    entry("assistant", "2026-10-19T15:10:13.000Z", "ok", { stopReason: "stop" }),
    entry("user", "2026-10-19T15:10:20.000Z", "chat page probe cccc. Reply with exactly: ok"),
    entry("assistant", "2026-10-19T15:10:20.100Z", "", { stopReason: "error", errorMessage: "pi-pool: this session waits for its slot" }),
  ].join("\n");
  const sends: SendTiming[] = [
    { marker: "chat page probe aaaa.", sentAt: 1_000, firstTokenAt: 1_000 + 2_000 + 380 },
    { marker: "chat page probe bbbb.", sentAt: 5_000, firstTokenAt: 5_000 + 3_000 + 190 },
    { marker: "chat page probe cccc.", sentAt: 9_000, firstTokenAt: 9_000 + 100 + 950 },
    { marker: "chat page probe dddd.", sentAt: 9_000, firstTokenAt: 9_500 },
  ];
  const reading = replyExtra(sends, session, 190, at);
  assert.equal(reading.value, 2);
  assert.deepEqual(reading.flagged.map(item => item.kind), ["reply", "reply", "reply_error", "reply", "reply_unmatched"]);
  assert.match(reading.flagged[0]!.excerpt, /first reply frame on the box 2380 ms after the send, the Mac's own turn 2000 ms, extra 380 ms = 2.00 round trips of 190 ms/);
  assert.match(reading.flagged[2]!.excerpt, /waits for its slot/);
});

const journal = (lines: string[]) => lines.map(line => `${line.slice(0, 32)} us-metal02 systemd[257985]: ${line.slice(33)}`).join("\n");

test("a release counts as broken when the service exits after its restart within the window, and message drops do not count", () => {
  const text = journal([
    "2026-10-18T10:00:00.000000+00:00 Stopping sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182...",
    "2026-10-18T10:00:02.000000+00:00 Started sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182.",
    "2026-10-19T01:14:15.208612+00:00 Stopping sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182...",
    "2026-10-19T01:14:17.349673+00:00 Started sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182.",
    "2026-10-19T01:14:24.119495+00:00 sieun-pi-chat.service: Main process exited, code=exited, status=1/FAILURE",
    "2026-10-19T12:46:46.000000+00:00 Stopping sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182...",
    "2026-10-19T12:46:49.000000+00:00 Started sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182.",
    "2026-10-19T13:06:49.000000+00:00 Stopping sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182...",
    "2026-10-19T13:06:51.000000+00:00 Started sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182.",
    "2026-10-19T14:12:29.000000+00:00 Stopping sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182...",
    "2026-10-19T14:12:31.000000+00:00 Started sieun-pi-chat.service - sieun-pi browser chat on 127.0.0.1:5182.",
  ]);
  const reading = releaseBreaks(text, at);
  assert.equal(reading.value, 1);
  assert.deepEqual(reading.flagged.map(item => item.item ?? item.kind), ["2026-10-19T01:14:15.208Z", "releases"]);
  assert.match(reading.flagged[0]!.excerpt, /1 break, first Main process exited, code=exited, status=1\/FAILURE/);
  assert.equal(reading.flagged[1]!.excerpt, "4 chat releases in 24 h, 1 with a break");
});
