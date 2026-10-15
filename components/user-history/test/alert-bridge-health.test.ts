import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, GrafanaError, readGrafanaAlerts, type FiringAlert } from "../src/alert-bridge.ts";
import { BridgeWatch, PollHealth, REPEAT_MS, STALE_MS, type BridgeStatus } from "../src/alert-bridge-health.ts";
import { OPS_ROUTE } from "../src/alert-routes.ts";
import { BoardStore } from "../src/chat-board-store.ts";

const NOW = Date.parse("2026-10-15T06:00:00Z");
const TICK = 30_000;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "alert-watch-"));
  let now = NOW;
  let answer: () => Promise<FiringAlert[] | null> = async () => [];
  let woke: number | null = null;
  const sent: { session: string; text: string }[] = [];
  const health = new PollHealth(() => now);
  const statusFile = join(dir, "cache", "alert-bridge-status.json");
  const configFile = join(dir, "grafana-alerts.json");
  const watch = () => new BridgeWatch({ health, statusFile, configFile, now: () => now, wokeAt: async () => woke, log: () => {},
    deliver: async (session, text) => { sent.push({ session, text }); return "sent"; } });
  const poll = () => health.poll(answer).catch(() => null);
  return { dir, health, sent, statusFile, configFile, watch, poll, answer: (next: typeof answer) => { answer = next; }, at: (ms: number) => { now = ms; }, woke: (ms: number) => { woke = ms; },
    status: async () => JSON.parse(await readFile(statusFile, "utf8")) as BridgeStatus };
}

async function run(f: Awaited<ReturnType<typeof fixture>>, watch: BridgeWatch, from: number, to: number, poll = true) {
  for (let at = from; at <= to; at += TICK) {
    f.at(at);
    if (poll) await f.poll();
    await watch.tick();
  }
}

test("no successful poll for 5 min sends ops guy one message that names the last good poll and the last error", async () => {
  const f = await fixture();
  const watch = f.watch();
  await run(f, watch, NOW, NOW);
  f.answer(async () => { throw new Error("Grafana answered 502 for the alert list"); });
  await run(f, watch, NOW + TICK, NOW + STALE_MS - TICK);
  assert.equal(f.sent.length, 0);
  await run(f, watch, NOW + STALE_MS, NOW + STALE_MS + 10 * TICK);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.session, OPS_ROUTE.session);
  assert.match(f.sent[0]!.text, /^\[alert-bridge-down\] The alert bridge has not read Grafana's firing list from obs\.virev\.ai for 5 min/);
  assert.match(f.sent[0]!.text, /last good poll 2026-10-15T06:00Z; last error at 2026-10-15T06:05Z: Grafana answered 502/);
});

test("a poll loop that stops calling Grafana alerts after 5 min from the watchdog's own timer", async () => {
  const f = await fixture();
  const watch = f.watch();
  await run(f, watch, NOW, NOW);
  await run(f, watch, NOW + TICK, NOW + STALE_MS, false);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /no poll error, the poll loop stopped calling Grafana/);
});

test("polls that fail while the Mac sleeps with its lid closed page nobody, and 5 awake min after a wake still page", async () => {
  const f = await fixture();
  const watch = f.watch();
  await run(f, watch, NOW, NOW);
  f.answer(async () => { throw new Error("fetch failed"); });
  for (const wake of [3, 5.5, 8, 10.5, 13]) {
    f.woke(NOW + wake * 60_000);
    await run(f, watch, NOW + wake * 60_000, NOW + wake * 60_000 + 10_000);
  }
  assert.equal(f.sent.length, 0);
  f.woke(NOW + 15 * 60_000);
  await run(f, watch, NOW + 15 * 60_000, NOW + 20 * 60_000 - TICK);
  assert.equal(f.sent.length, 0);
  await run(f, watch, NOW + 20 * 60_000, NOW + 20 * 60_000);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /for 20 min, so .*\(last good poll 2026-10-15T06:00Z; last error at 2026-10-15T06:20Z: fetch failed\)/);
});

test("a throwaway config with a bad Viewer token gets 401, and the watchdog tells ops guy at once with the cause", async () => {
  const f = await fixture();
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.url} ${request.headers.authorization}`);
    response.writeHead(401, { "content-type": "application/json" }).end('{"message":"invalid API key"}');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    await writeFile(f.configFile, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "glsa_throwaway_bad" }));
    const bridge = new AlertBridge({ file: join(f.dir, "alert-bridge.json"), boards: new BoardStore(f.dir), log: () => {}, now: () => NOW,
      alerts: () => f.health.poll(() => readGrafanaAlerts(f.configFile)), deliver: async () => { throw new Error("the bridge itself must not send"); } });
    await assert.rejects(bridge.tick(), /Grafana answered 401/);
    assert.deepEqual(seen, ["/api/alertmanager/grafana/api/v2/alerts Bearer glsa_throwaway_bad"]);
    await f.watch().tick();
  } finally { server.close(); }
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.session, OPS_ROUTE.session);
  assert.match(f.sent[0]!.text, /refused the alert bridge's Viewer token \(HTTP 401\)/);
  assert.match(f.sent[0]!.text, /no good poll since the chat service started polling at 2026-10-15T06:00Z; last error at 2026-10-15T06:00Z: Grafana answered 401/);
  assert.ok(f.sent[0]!.text.includes(f.configFile));
  assert.equal((await f.status()).health, "refused");
});

test("a 403 counts as a refused token too", async () => {
  const f = await fixture();
  f.answer(async () => { throw new GrafanaError(403); });
  await run(f, f.watch(), NOW, NOW);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /HTTP 403/);
});

test("an outage repeats to ops guy at most every 30 min", async () => {
  const f = await fixture();
  const watch = f.watch();
  await run(f, watch, NOW, NOW);
  f.answer(async () => { throw new Error("fetch failed"); });
  await run(f, watch, NOW + TICK, NOW + 70 * 60_000);
  assert.equal(f.sent.length, 3);
  const at = f.sent.map(sent => /for (\d+) min/.exec(sent.text)?.[1]);
  assert.deepEqual(at, ["5", "35", "65"]);
  assert.equal(REPEAT_MS, 30 * 60_000);
});

test("a chat service restart in an outage keeps the 30 min gap from the status file", async () => {
  const f = await fixture();
  f.answer(async () => { throw new GrafanaError(401); });
  await run(f, f.watch(), NOW, NOW);
  assert.equal(f.sent.length, 1);
  const fresh = await fixture();
  const again = new BridgeWatch({ health: fresh.health, statusFile: f.statusFile, configFile: f.configFile, now: () => NOW + 10 * 60_000, wokeAt: async () => null, log: () => {},
    deliver: async (session, text) => { f.sent.push({ session, text }); return "sent"; } });
  fresh.answer(async () => { throw new GrafanaError(401); });
  fresh.at(NOW + 10 * 60_000);
  await fresh.poll();
  await again.tick();
  assert.equal(f.sent.length, 1);
});

test("recovery sends ops guy one line", async () => {
  const f = await fixture();
  const watch = f.watch();
  f.answer(async () => { throw new GrafanaError(401); });
  await run(f, watch, NOW, NOW + 2 * TICK);
  assert.equal(f.sent.length, 1);
  f.answer(async () => [{ fingerprint: "a1", startsAt: "2026-10-15T05:00:00.000Z", alertname: "x", labels: {}, summary: "", url: "" }]);
  await run(f, watch, NOW + 3 * TICK, NOW + 40 * 60_000);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1]!.session, OPS_ROUTE.session);
  assert.equal(f.sent[1]!.text, "[alert-bridge-recovered] The alert bridge read Grafana's firing list again at 2026-10-15T06:01Z (1 firing); it had no good poll from 2026-10-15T06:00Z.");
  const status = await f.status();
  assert.equal(status.health, "ok");
  assert.equal(status.alert_since, null);
});

test("a failed send to ops guy is tried again on the next tick", async () => {
  const f = await fixture();
  const sent: string[] = [];
  let down = true;
  const watch = new BridgeWatch({ health: f.health, statusFile: f.statusFile, configFile: f.configFile, now: () => NOW, wokeAt: async () => null, log: () => {},
    deliver: async (_session, text) => { if (down) throw new Error("Timed out waiting for daemon worker response"); sent.push(text); return "sent"; } });
  f.answer(async () => { throw new GrafanaError(401); });
  await f.poll();
  await watch.tick();
  assert.equal(sent.length, 0);
  down = false;
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1);
});

test("the status file is written each tick with last_ok, last_error, firing_count and ts", async () => {
  const f = await fixture();
  const watch = f.watch();
  f.answer(async () => [{ fingerprint: "a1", startsAt: "2026-10-15T05:00:00.000Z", alertname: "x", labels: {}, summary: "", url: "" }]);
  f.at(NOW);
  await f.poll();
  await watch.tick();
  assert.deepEqual(await f.status(), { v: 1, ts: "2026-10-15T06:00:00.000Z", pid: process.pid, poll_every_s: 30, health: "ok", last_ok: "2026-10-15T06:00:00.000Z",
    last_error: null, firing_count: 1, alert_since: null, alert_sent_at: null });
  f.answer(async () => { throw new Error("fetch failed"); });
  f.at(NOW + TICK);
  await f.poll();
  await watch.tick();
  const second = await f.status();
  assert.equal(second.ts, "2026-10-15T06:00:30.000Z");
  assert.equal(second.health, "failing");
  assert.deepEqual(second.last_error, { at: "2026-10-15T06:00:30.000Z", status: null, message: "fetch failed" });
  f.at(NOW + 2 * TICK);
  await watch.tick();
  assert.equal((await f.status()).ts, "2026-10-15T06:01:00.000Z");
  assert.equal(f.sent.length, 0);
});

test("a chat service with no Grafana config writes no status file and sends nothing", async () => {
  const f = await fixture();
  f.answer(async () => null);
  await run(f, f.watch(), NOW, NOW + 60 * 60_000);
  assert.equal(f.sent.length, 0);
  await assert.rejects(stat(f.statusFile), { code: "ENOENT" });
});
