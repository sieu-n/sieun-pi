// A slow chat minute within 90 s of the chat's own start is the start's work. At 18:57:45Z on 11-03 systemd killed a chat stop after 90 s, the
// next run listened at 18:59:20.125Z with the last run's saved heads gone, and its CPU profile spent 9.5 s in fileOrigin and 4.0 s in scanFirst
// on the main thread. The 18:59:30Z line read a 1.2 s loop stall with no cpuCores, since the start sample's cgroup read was cut, and d7's 04:09
// KST run on 11-04 read the minute with no cause. 19:02Z (start 19:01:49.705Z) read 1.2 s with CI leading and was booked on CI's side.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CpuSides, LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { measure, readChatStarts } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-11-03T19:09:39.979Z");
const START = Date.parse("2026-11-03T18:39:00Z");
const fast = { readMs: 89, read: "api/agent/siblings", loopMs: 203 };
const cores: CpuSides = { harness: 26.69, apps: 6.26, owner: 0, ci: 15.13, system: 0.72 };
const box = (sides: CpuSides | null): LinuxUsable => ({ kind: "linux", memSomeAvg10: 2.5, memFullAvg10: 2.5, cpuSomeAvg10: 34.11, swapoutsPerS: 7895,
  runnablePerCore: 2.8, allowedCpus: 80, ...sides ? { cpuCores: sides } : {} });
const line = (minute: number, sides: CpuSides | null, chat: NonNullable<WatchLine["chat"]> = fast): WatchLine => ({
  at: new Date(START + minute * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box(sides),
  workers: 22, workerGb: 39.39, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0, chat });
const stall = (loopMs: number) => ({ readMs: 2, read: "api/slack", loopMs, gcMs: 318, gc: "major" as const });
// 18:59Z is minute 20 and 19:02Z minute 23 of the window.
const watch = (): WatchLine[] => Array.from({ length: 30 }, (_, minute) => minute === 20 ? line(20, null, stall(1162))
  : minute === 23 ? line(23, { ...cores, harness: 29.91, ci: 40.86 }, { ...stall(1153), gcMs: 160 }) : line(minute, cores));
const LOG = ["2026-11-03T18:45:35.915Z serve: listening 4249 ms after start, main thread CPU 3820 ms, from the bundle",
  "2026-11-03T18:59:20.125Z serve: listening 3512 ms after start, main thread CPU 3170 ms, from the bundle",
  "2026-11-03T19:01:43.565Z stop: begins",
  "2026-11-03T19:01:49.705Z serve: listening 4612 ms after start, main thread CPU 3560 ms, from the bundle"];

test("service.log's listening lines are the chat's starts", () => {
  assert.deepEqual(readChatStarts(LOG), [Date.parse("2026-11-03T18:45:35.915Z"), Date.parse("2026-11-03T18:59:20.125Z"), Date.parse("2026-11-03T19:01:49.705Z")]);
});

test("a loop stall 10 s after the chat's start is the harness's and names the start, though its line has no cpuCores", () => {
  const { metrics, flagged } = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], chatStarts: readChatStarts(LOG) });
  assert.equal(metrics.clean_min_30, 28, "a start minute stays dirty (c172)");
  assert.equal(metrics.unattributed_unusable_min_30, 0);
  assert.equal(metrics.harness_unusable_min_30, 2);
  assert.equal(metrics.ci_unusable_min_30, 0);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /18:59Z us-metal02 unusable \(cpu: the chat's event loop stalled 1\.2 s, 10 s after the chat started at 18:59:20Z\)/);
  assert.match(dirty, /19:02Z us-metal02 unusable \(cpu: the chat's event loop stalled 1\.2 s, 40 s after the chat started at 19:01:49Z; CI 40\.86 of 80 cores, up from 15\.13 at 18:57Z/);
});

test("a stall more than 90 s after the last start keeps its side by cores", () => {
  const { metrics } = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], chatStarts: [Date.parse("2026-11-03T18:45:35.915Z")] });
  assert.equal(metrics.unattributed_unusable_min_30, 1);
  assert.equal(metrics.ci_unusable_min_30, 1);
});
