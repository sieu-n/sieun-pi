// A busy box from real job work is no harness fault (the chat VP's call on 10-18 at 11:58Z). d7 at 11:54Z read 28 CPU-dirty minutes on
// us-metal02, most of them load from jobs' test runs, builds and scratch services while the chat answered and every worker kept up.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import { measure } from "../scripts/duties/whole-system.ts";
import { createServer } from "node:http";
import { readRoute, takeLatency, timeRead, waitedOnHost } from "../src/chat-latency.ts";
import { chatLatency, harnessSlow, waitedOnCpu, workerMisses } from "../src/harness-slow.ts";
import type { UsableReading, WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-18T11:54:10Z");
const box = (runnablePerCore: number): LinuxUsable => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore, allowedCpus: 80,
  cpuCores: { harness: 50, apps: 3, owner: 0, ci: 10, system: 1 } });
const mac: UsableReading = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 };
const minuteAt = (minute: number): number => RUN - 10_000 - (30 - minute) * 60_000 + 30_000;
const line = (minute: number, runnable: number, chat?: WatchLine["chat"]): WatchLine => ({ at: new Date(minuteAt(minute)).toISOString(), host: "us-metal02", usable: box(runnable),
  workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0, ...chat ? { chat } : {},
  hosts: [{ name: "mac", usable: mac, workers: 1, workerGb: 1, top: [], live: 1, working: 1, swapGb: 0 }] });

test("a CPU-busy minute is dirty only when the chat was slow, a worker missed its poll, or a send or wake timed out in it", () => {
  // Minutes 20 to 24 read 1.4 runnable a core. 20: nothing slow. 21: a 1.6 s read. 22: a worker's poll timed out. 23: a wake's send timed out.
  // 24: a send failed on the Mac, which says nothing about us-metal02's CPU.
  const lines = Array.from({ length: 30 }, (_, minute) => minute === 21 ? line(minute, 1.4, { readMs: 1600, read: "api/threads", loopMs: 30 })
    : line(minute, minute >= 20 && minute <= 24 ? 1.4 : 0.5, { readMs: 120, loopMs: 30 }));
  const fault = (minute: number, host: string) => ({ at: minuteAt(minute) - 20_000, host, session: "01a14e9c", what: "a wake's send failed, the handshake timed out after 10 s" });
  const { metrics, flagged } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [], workerMisses: [minuteAt(22) - 5_000],
    daemonFaults: [fault(23, "us-metal02"), fault(24, "mac")] });
  assert.equal(metrics.cpu_busy_min_30, 2, "20 and 24");
  assert.equal(metrics.unusable_min_30_us_metal02, 3);
  assert.equal(metrics.clean_min_30, 26, "20 is clean; 24 is dirty only for its daemon fault");
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /us-metal02 unusable \(cpu: the chat answered api\/threads in 1\.6 s\)/);
  assert.match(dirty, /us-metal02 unusable \(cpu: 1 worker poll went unanswered\)/);
  assert.match(dirty, /us-metal02 unusable \(cpu: 1 send or wake timed out\)/);
  assert.match(flagged?.find(slice => slice.kind === "busy_minutes")?.excerpt ?? "", /^2 minutes the box was CPU-busy and the harness stayed fast/);
});

test("the slow signals: a read or loop stall over 1 s, the supervisor's unanswered polls, and only the line's own box", () => {
  const base = { box: "us-metal02", own: true, from: 0, to: 60_000, misses: [], faults: [] };
  assert.deepEqual(harnessSlow({ ...base, latency: { readMs: 1000, loopMs: 1000 } }), [], "exactly 1 s is not over it");
  assert.deepEqual(harnessSlow({ ...base, latency: { readMs: 40, loopMs: 2300 } }), ["the chat's event loop stalled 2.3 s"]);
  assert.deepEqual(harnessSlow({ ...base, own: false, latency: { readMs: 5000, loopMs: 0 }, misses: [10] }), [], "another box's line has no chat or poll of its own");
  assert.equal(chatLatency({ readMs: -1, loopMs: 3 }), undefined);
  assert.equal(waitedOnCpu("an outbox send failed, the session refused it with too many pending messages"), false, "a refusal is no wait");
  assert.equal(waitedOnCpu("an outbox send failed, send_message timed out after 30 s"), true);
  assert.deepEqual(workerMisses([
    "[2026-10-18T10:54:00.613Z] supervisor: Could not list scheduled jobs from a worker: Timed out waiting for daemon worker response to cron_list",
    "[2026-10-18T11:05:42.617Z] supervisor: Could not list heartbeats from a worker: Session worker is stopping",
    "[2026-10-18T11:06:00.000Z] supervisor: Worker 4ff289cedff3 is unresponsive; parked failed after 3 probe rounds",
  ]), [Date.parse("2026-10-18T10:54:00.613Z"), Date.parse("2026-10-18T11:06:00.000Z")]);
  assert.equal(readRoute("/cap123/app.3f9c1a2b.js?x=1", "/cap123/"), "app.js");
  assert.equal(readRoute("/cap123/api/threads?id=1", "/cap123/"), "api/threads");
});

test("the chat times each GET it answers and keeps the slowest, with the event loop's longest stall, until the watch takes them", async () => {
  const server = createServer((req, res) => { timeRead(req, res, "/cap/"); setTimeout(() => res.end("ok"), req.url?.includes("slow") ? 120 : 1); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    for (const path of ["/cap/api/labels", "/cap/api/threads?slow=1", "/cap/app.js"]) await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
    await fetch(`http://127.0.0.1:${port}/cap/api/threads?slow=1`, { method: "POST" }).then(res => res.text());
    const taken = takeLatency();
    assert.equal(taken?.read, "api/threads");
    assert.ok(taken!.readMs >= 110 && taken!.readMs < 1000, JSON.stringify(taken));
    assert.ok(taken!.loopMs >= 0);
    assert.equal(takeLatency()?.readMs, 0, "a new window starts empty");
  } finally { server.close(); }
});

test("a GET that waited on another box is timed apart from this box's reads, so d7 does not count a slow relay as this box's CPU", async () => {
  // As the 10-22 15:01Z older page of a Mac chat: the handler awaits, then reads through the Mac relay, which marks the request.
  const server = createServer((req, res) => {
    timeRead(req, res, "/cap/");
    const remote = req.url?.includes("older");
    void Promise.resolve().then(() => { if (remote) waitedOnHost(); }).then(() => setTimeout(() => res.end("ok"), remote ? 150 : 30));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    takeLatency();
    await Promise.all(["/cap/api/threads/a/older?cursor=m1.0", "/cap/api/labels"].map(path => fetch(`http://127.0.0.1:${port}${path}`).then(res => res.text())));
    const taken = takeLatency()!;
    assert.equal(taken.read, "api/labels", "the local read stays this box's");
    assert.ok(taken.readMs >= 25 && taken.readMs < 140, JSON.stringify(taken));
    assert.equal(taken.remote, "api/threads/a/older");
    assert.ok(taken.remoteMs! >= 140, JSON.stringify(taken));
    assert.equal(takeLatency()?.remoteMs, undefined, "a new window starts empty");
  } finally { server.close(); }
  const own = { box: "us-metal02", own: true, from: 0, to: 60_000, misses: [], faults: [] };
  assert.deepEqual(harnessSlow({ ...own, latency: { readMs: 60, read: "api/agent/siblings", remoteMs: 2105, remote: "api/threads/a/older", loopMs: 279 } }), [],
    "a read that waited 2.1 s on the Mac relay does not make a busy us-metal02 minute dirty");
});
