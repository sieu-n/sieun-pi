// A CPU minute whose slow read was the chat service's own route is the harness's minute. At 20:32Z on 10-24 api/threads/<id>/agents took 2.8 s
// on us-metal02 at 1.09 runnable a core, and d7 booked the minute on the apps' side because the apps used 21.99 cores and the harness 20.12.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { measure } from "../scripts/duties/whole-system.ts";
import { slowChat, slowChatRead } from "../src/harness-slow.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-24T20:44:10Z");
const box: LinuxUsable = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 1.4, allowedCpus: 80,
  cpuCores: { harness: 20.12, apps: 21.99, owner: 0, ci: 4, system: 1 } };
const line = (minute: number, chat: NonNullable<WatchLine["chat"]>): WatchLine => ({
  at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box,
  workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0, chat });

test("a CPU minute with a slow chat read is the harness's even when the apps used more cores", () => {
  const fast = { readMs: 60, read: "api/agent/siblings", loopMs: 130 };
  const lines = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 28 ? { readMs: 2836, read: "api/threads/01a16ecf-ead1-77fd-9fcf-d2b07c8563e9/agents", loopMs: 276 } : fast));
  const { metrics } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.harness_unusable_min_30, 1);
  assert.equal(metrics.other_unusable_min_30, 0);
  assert.equal(metrics.cpu_busy_min_30, 29, "the minutes the chat stayed fast stay busy minutes");
});

test("only the box that timed the read owns it, and only past the slow line", () => {
  assert.equal(slowChatRead(true, { readMs: 2836, read: "api/threads/x/agents", loopMs: 1 })?.readMs, 2836);
  assert.equal(slowChatRead(false, { readMs: 2836, loopMs: 1 }), undefined);
  assert.equal(slowChatRead(true, { readMs: 900, loopMs: 1 }), undefined);
});

// At 02:44Z on 10-30 the chat's event loop stalled 1.3 s in a 975 ms major GC, with no slow read, and d7 booked it on the apps' side.
test("a CPU minute whose chat event loop stalled over 1 s in a major GC is the harness's too", () => {
  const fast = { readMs: 60, read: "api/agent/siblings", loopMs: 130 };
  const lines = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 28 ? { readMs: 0, loopMs: 1303, gcMs: 975, gc: "major" } : fast));
  const { metrics } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.harness_unusable_min_30, 1);
  assert.equal(metrics.other_unusable_min_30, 0);
  assert.equal(slowChat(true, { readMs: 0, loopMs: 1303, gcMs: 975, gc: "major" })?.loopMs, 1303);
  assert.equal(slowChat(false, { readMs: 0, loopMs: 1303, gcMs: 975, gc: "major" }), undefined);
  assert.equal(slowChat(true, { readMs: 900, loopMs: 900, gcMs: 800, gc: "major" }), undefined);
  assert.equal(slowChat(true, { readMs: 0, loopMs: 1260, gcMs: 121, gc: "minor" }), undefined, "00:25Z on 10-30: no GC made the stall, so the cores decide");
  assert.equal(slowChat(true, { readMs: 0, loopMs: 1500 }), undefined);
});
