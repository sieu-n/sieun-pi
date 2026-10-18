// Guards the 10-18 03:53Z dirty minute: the Whole system duty (d7) read 29 of 30 clean at 04:17:08Z because its sliding minute (03:52:08, 03:53:08]
// fell between watch lines at 03:52:07.717Z and 03:53:08.347Z, which the drifting once-a-minute interval wrote 60.63 s apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { nextSampleAt, type WatchLine } from "../src/mac-usable-watch.ts";

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

test("a minute with no line still reads unwatched when the watch stops for 2 minutes", () => {
  const result = run(STAMPS.filter(stamp => stamp !== "04:00:23.939" && stamp !== "04:01:23.957"));
  assert.equal(result.metrics.unwatched_min_30, 2);
  assert.equal(result.metrics.clean_min_30, 28);
  assert.match(result.flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /^04:00Z no watch line; 04:01Z no watch line$/);
});

test("the watch samples at each wall-clock minute's middle, so a lagging tick stays in its minute and never drifts", () => {
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:07.717Z"))).toISOString(), "2026-10-18T03:52:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:30.000Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:53:29.999Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
});
