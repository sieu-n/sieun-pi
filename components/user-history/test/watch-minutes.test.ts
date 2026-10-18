// Guards the 10-18 03:53Z dirty minute: the Whole system duty (d7) read 29 of 30 clean at 04:17:08Z because its sliding minute (03:52:08, 03:53:08]
// fell between watch lines at 03:52:07.717Z and 03:53:08.347Z, which the drifting once-a-minute interval wrote 60.63 s apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import { type Footprints, hostWatchLine, nextSampleAt, parseUsableRaw, unusable, type UsableReading, type WatchLine } from "../src/mac-usable-watch.ts";

// Every watch line stamp from 03:46Z to the d7 run at 04:17:08Z on 10-18, from mac-usable/2026-10-18.jsonl; the jumps after 03:55Z are chat restarts.
const STAMPS = ["03:46:06.734", "03:47:06.735", "03:48:06.734", "03:49:06.921", "03:50:07.210", "03:51:07.469", "03:52:07.717", "03:53:08.347",
  "03:54:08.346", "03:55:06.137", "03:56:00.576", "03:57:00.647", "03:57:12.652", "03:58:07.479", "03:58:28.937", "03:59:23.933", "04:00:23.939",
  "04:01:23.957", "04:02:18.705", "04:02:36.456", "04:03:31.463", "04:04:24.648", "04:05:19.648", "04:06:19.649", "04:07:19.649", "04:08:19.654",
  "04:09:19.654", "04:10:19.679", "04:11:19.693", "04:11:41.913", "04:12:31.911", "04:13:16.729", "04:14:06.728", "04:15:06.729", "04:16:06.731",
  "04:17:06.730"];
const RUN = Date.parse("2026-10-18T04:17:08Z");
const line = (clock: string): WatchLine => ({ at: `2026-10-18T${clock}Z`, usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 },
  workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 });
const run = (stamps: readonly string[]) => measure({ now: RUN, watch: stamps.map(line), log: { holds: [] }, okLimit: 15, chats: [] });

test("the 03:52:07.717Z and 03:53:08.347Z lines watch 03:53Z, so the 04:17:08Z run reads 30 clean minutes", () => {
  const { metrics } = run(STAMPS);
  assert.equal(metrics.unwatched_min_30, 0);
  assert.equal(metrics.clean_min_30, 30);
});

test("a minute with no line reads unwatched and unknown, neither clean nor dirty, when the watch stops for 2 minutes", () => {
  const result = run(STAMPS.filter(stamp => stamp !== "04:00:23.939" && stamp !== "04:01:23.957"));
  assert.equal(result.metrics.unwatched_min_30, 2);
  assert.equal(result.metrics.unknown_min_30, 2);
  assert.equal(result.metrics.clean_min_30, 28);
  assert.equal(result.flagged?.find(slice => slice.kind === "dirty_minutes"), undefined);
  assert.match(result.flagged?.find(slice => slice.kind === "unknown_minutes")?.excerpt ?? "", /^04:00Z no watch line; 04:01Z no watch line$/);
});

test("the watch samples at each wall-clock minute's middle, so a lagging tick stays in its minute and never drifts", () => {
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:07.717Z"))).toISOString(), "2026-10-18T03:52:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:30.000Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:53:29.999Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
});

// From 04:22:55Z on 10-18 the chat ran on us-metal02, whose lines carried usable: null (the Mac's feed has no Linux side) and measured only the
// box's workers, so clean_min_30 counted every box minute dirty and the Mac's workers left sleeping_gb.
const BOX_RUN = Date.parse("2026-10-18T05:00:10Z");
const linux = (memFullAvg10: number, loadPerCore: number): LinuxUsable => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10, cpuSomeAvg10: 0, swapoutsPerS: 0, loadPerCore });
const mac: UsableReading = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 20 };
const boxLine = (minute: number, box: LinuxUsable | null, other: UsableReading | null, sleeping = 0): WatchLine => ({
  at: new Date(BOX_RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box,
  workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0,
  sleeping: { gb: 0, workers: 0, kernels: 0, trees: [] },
  hosts: [{ name: "mac", usable: other, workers: 19, workerGb: 9.68, top: [], live: 46, working: 27, swapGb: 7.8,
    sleeping: { gb: sleeping, workers: sleeping ? 1 : 0, kernels: 0, trees: sleeping ? [{ root: "lmb", tree: "launch main bro", gb: sleeping }] : [] },
    ...other ? {} : { error: "relay mac answered 502 to /v1/watch" } }] });

test("each box is judged on its own reading, a Linux box by memory stall and load a core, and a box with no reading is unknown", () => {
  const lines = Array.from({ length: 30 }, (_, minute) => boxLine(minute, minute === 3 ? linux(72, 0.6) : minute === 4 ? linux(0, 1.2) : linux(0, 0.58),
    minute === 10 ? null : mac));
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, okLimit: 15, chats: [] });
  assert.equal(metrics.clean_min_30, 27);
  assert.equal(metrics.unknown_min_30, 1, "the minute the Mac's relay did not answer is neither clean nor dirty");
  assert.equal(metrics.usable_min_30_us_metal02, 28);
  assert.equal(metrics.unusable_min_30_us_metal02, 2);
  assert.equal(metrics.unknown_min_30_mac, 1);
  assert.equal(metrics.usable_min_30_mac, 29);
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /us-metal02 unusable \(pressure\).*us-metal02 unusable \(cpu\)/);
  assert.match(flagged?.find(slice => slice.kind === "unknown_minutes")?.excerpt ?? "", /mac unread \(relay mac answered 502/);
});

test("sleeping_gb sums every box's sleeping sessions, and the flag names each box", () => {
  const lines = Array.from({ length: 30 }, (_, minute) => boxLine(minute, linux(0, 0.5), mac, 0.31));
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, okLimit: 15, chats: [] });
  assert.equal(metrics.sleeping_gb, 0.31);
  assert.match(flagged?.find(slice => slice.kind === "sleeping")?.excerpt ?? "", /mac 0.31 GB in 1 whole workers and 0 kernels \(launch main bro 0.31 GB\)/);
});

test("another box's watch line comes from its relay's answer, and a relay that fails leaves its numbers unknown", async () => {
  const GB = 1024 ** 3;
  const rows = [{ sessionId: "lmb", activeSessionId: "lmb", lifecycle: "live", activity: "idle", workerPid: 31, sessionName: "launch main bro", lastActivityAt: new Date(BOX_RUN - 40 * 60_000).toISOString() }];
  const footprints: Footprints = { workers: { 31: { pids: 2, bytes: 0.31 * GB } }, kernels: [], swap_used_bytes: 7.8 * GB, pressure_level: 2, cpu_s: 0 };
  const feed = { v: 1, ts: new Date(BOX_RUN - 5_000).toISOString(), pressure_level: 2, swapouts_per_s: 0, kernel_task_cpu_pct: 20 };
  const read = await hostWatchLine({ name: "mac", rows, read: async pids => { assert.deepEqual(pids, [31]); return { usable: { platform: "darwin", feed }, footprints }; } },
    { now: BOX_RUN, chats: new Set(["lmb"]), title: () => null, idleMs: 10 * 60_000 });
  assert.equal(read.workers, 1);
  assert.equal(read.workerGb, 0.31);
  assert.equal(read.sleeping?.gb, 0.31);
  assert.deepEqual(read.usable, { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 20 });
  const failed = await hostWatchLine({ name: "mac", rows, read: async () => { throw new Error("relay mac answered 404 to /v1/watch"); } }, { now: BOX_RUN, chats: new Set(), title: () => null });
  assert.equal(failed.usable, null);
  assert.match(failed.error ?? "", /404/);
  const box = parseUsableRaw({ platform: "linux", reading: linux(0, 0.58) }, BOX_RUN);
  assert.deepEqual(box && unusable(box), []);
});
