// Guards d7's 10:27Z minute on 11-25: the Mac read 7,690 swapouts a second at pressure level 1 while its swap went from 12.3 to 9.2 GB, a
// minute after Helium went from 15.0 to 5.8 GB, and d7 counted the minute dirty. At 20:33Z on 11-19 it read 13,856 a second at pressure
// level 2 with swap growing from 16.8 to 18.9 GB, which is paging and stays dirty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { unusable, type UsableReading, type WatchLine } from "../src/mac-usable-watch.ts";

const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.1, allowedCpus: 80 } as const;
const calm: UsableReading = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 };
const freeing: UsableReading = { pressureLevel: 1, swapoutsPerS: 7689.8, kernelTaskPct: 31 };
const paging: UsableReading = { pressureLevel: 2, swapoutsPerS: 13856.1, kernelTaskPct: 77.6 };

/** 32 watch lines a minute apart ending in the minute before `run`'s, the Mac at `calm` and `swapGb` but for the last line. */
function watch(run: number, swapGb: number, last: UsableReading, lastSwapGb: number): WatchLine[] {
  const end = Math.floor(run / 60_000) * 60_000 - 60_000;
  return Array.from({ length: 32 }, (_, index) => {
    const final = index === 31;
    return { host: "us-metal02", at: new Date(end - (31 - index) * 60_000 + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0,
      queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
      hosts: [{ name: "mac", usable: final ? last : calm, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: final ? lastSwapGb : swapGb }] } as WatchLine;
  });
}
const clean = (run: number, lines: WatchLine[]) => measure({ now: run, watch: lines, log: { holds: [] }, chats: [] }).metrics.clean_min_30;

test("a Mac swapouts minute at normal pressure while swap shrinks reads usable", () => {
  assert.deepEqual(unusable(freeing, true), []);
  assert.deepEqual(unusable(freeing), ["swapouts"], "with no shrink known the minute stays dirty");
  const run = Date.parse("2026-11-25T10:28:12Z");
  assert.equal(clean(run, watch(run, 12.3, freeing, 9.2)), 30);
  assert.equal(clean(run, watch(run, 9.2, freeing, 12.3)), 29, "the same reading with swap growing is paging");
});

test("a Mac swapouts minute at warn stays unusable whatever swap did", () => {
  const run = Date.parse("2026-11-19T20:34:12Z");
  assert.equal(clean(run, watch(run, 16.8, paging, 18.9)), 29);
  assert.equal(clean(run, watch(run, 18.9, paging, 16.8)), 29);
  assert.deepEqual(unusable(paging, true), ["swapouts"]);
});
