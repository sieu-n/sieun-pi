// chat-health.ts judges d7's minutes as whole-system.ts does, so the Mac's 10:27Z minute on 11-25 (7,690 swapouts a second at pressure
// level 1, swap 12.3 to 9.2 GB) reads clean here too, and 20:33Z on 11-19 (13,856 a second at warn, swap 16.8 to 18.9 GB) stays dirty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeMinutes, unusable } from "../readers/chat-health.ts";
import type { UsableReading, WatchLine } from "../../../legacy/prime/user-history/src/mac-usable-watch.ts";

const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.1, allowedCpus: 80 } as const;
const calm: UsableReading = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 };
const freeing: UsableReading = { pressureLevel: 1, swapoutsPerS: 7689.8, kernelTaskPct: 31 };
const paging: UsableReading = { pressureLevel: 2, swapoutsPerS: 13856.1, kernelTaskPct: 77.6 };

function watch(run: number, swapGb: number, last: UsableReading, lastSwapGb: number): WatchLine[] {
  const end = Math.floor(run / 60_000) * 60_000 - 60_000;
  return Array.from({ length: 32 }, (_, index) => {
    const final = index === 31;
    return { host: "us-metal02", at: new Date(end - (31 - index) * 60_000 + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0,
      queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
      hosts: [{ name: "mac", usable: final ? last : calm, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: final ? lastSwapGb : swapGb }] } as WatchLine;
  });
}
const clean = (run: number, lines: WatchLine[]) => judgeMinutes({ now: run, watch: lines, holds: [], pool: [], faults: [], misses: [] }).clean;

test("the feed reads a Mac swapouts minute at normal pressure while swap shrinks clean, as d7 does", () => {
  assert.deepEqual(unusable(freeing, true), []);
  const run = Date.parse("2026-11-25T10:28:12Z");
  assert.equal(clean(run, watch(run, 12.3, freeing, 9.2)), 30);
  assert.equal(clean(run, watch(run, 9.2, freeing, 12.3)), 29);
});

test("the feed keeps a Mac swapouts minute at warn dirty whatever swap did", () => {
  const run = Date.parse("2026-11-19T20:34:12Z");
  assert.equal(clean(run, watch(run, 16.8, paging, 18.9)), 29);
  assert.equal(clean(run, watch(run, 18.9, paging, 16.8)), 29);
});
