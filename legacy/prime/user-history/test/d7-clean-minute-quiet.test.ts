// Guards d7's runs of 11-19: the Mac's 20:33Z minute alone held clean_min_30 at 29 in the 20:35Z, 20:39Z and 20:54Z runs, the precheck gave no
// lastEventAt, and the 20:54Z run read 3 misses that did not move, called the fix p1600 failed and asked for a new root-cause job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, owedKeys, unreadWindows, WINDOW_MS } from "../scripts/duties/whole-system.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const clean: DutyMetric = { key: "clean_min_30", label: "Minutes in the last 30 the system ran clean", op: ">=", target: 30, headline: true };
const t = (iso: string): number => Date.parse(iso);
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const line = (minute: number): WatchLine => ({ host: "us-metal02",
  at: new Date(minute + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 18 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null }] } as WatchLine);
const watch = Array.from({ length: 60 }, (_, minute) => line(t("2026-11-19T20:00:00Z") + minute * 60_000));
const slowOpen = (at: string) => ({ at: t(at), host: "mac", session: "01a11ba8", what: "opening it failed, attach timed out after 30 s" });

function run(at: string, faults: readonly string[]): DutyRunRecord {
  const output = measure({ now: t(at), log: { holds: [] }, chats: [], watch: watch.filter(entry => t(entry.at) < t(at)), daemonFaults: faults.map(slowOpen) });
  const { verdict, metrics, summary } = judge([clean], output);
  return { duty: "d7", at: t(at), trigger: "schedule", ms: 1, verdict, metrics, summary };
}

test("a dirty minute dates clean_min_30 by the minute's end, with the 30 min window, and a clean window gives no date", () => {
  const dirty = measure({ now: t("2026-11-19T20:54:03Z"), log: { holds: [] }, chats: [], watch, daemonFaults: [slowOpen("2026-11-19T20:33:50Z")] });
  assert.equal(dirty.metrics.clean_min_30, 29);
  assert.equal(dirty.lastEventAt?.clean_min_30, t("2026-11-19T20:34:00Z"));
  assert.equal(dirty.windowMs?.clean_min_30, WINDOW_MS);
  const quiet = measure({ now: t("2026-11-19T20:54:03Z"), log: { holds: [] }, chats: [], watch, daemonFaults: [] });
  assert.equal(quiet.metrics.clean_min_30, 30);
  assert.equal(quiet.lastEventAt?.clean_min_30, undefined);
});

test("one dirty minute seen by three runs reads quiet, not stuck, so the 20:54Z run starts no new root-cause job", () => {
  const runs = ["2026-11-19T20:54:03Z", "2026-11-19T20:39:03Z", "2026-11-19T20:35:03Z"].map(at => run(at, ["2026-11-19T20:33:50Z"]));
  assert.deepEqual(runs.map(entry => entry.metrics.clean_min_30!.value), [29, 29, 29]);
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.misses, 3);
  assert.equal(streak!.quietSince, t("2026-11-19T20:34:00Z"));
  assert.equal(streak!.stuck, false);
});

test("a new dirty minute after the run before keeps three misses stuck", () => {
  const faults = ["2026-11-19T20:33:50Z", "2026-11-19T20:45:10Z"];
  const runs = ["2026-11-19T20:54:03Z", "2026-11-19T20:39:03Z", "2026-11-19T20:35:03Z"].map(at => run(at, faults));
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.misses, 3);
  assert.equal(streak!.quietSince, undefined);
  assert.equal(streak!.stuck, true);
});

test("a dirty minute still open at the run before is not yet in its window, so it reads fresh", () => {
  const runs = ["2026-11-19T20:54:03Z", "2026-11-19T20:39:03Z", "2026-11-19T20:33:55Z"].map(at => run(at, ["2026-11-19T20:33:50Z", "2026-11-19T20:20:10Z"]));
  assert.equal(metricStreaks(runs.slice(1))[0]!.quietSince, undefined);
});

test("d9 reads the dated clean_min_30 as no lagging window and owes no fix job for a quiet one", () => {
  const runs = ["2026-11-19T20:54:03Z", "2026-11-19T20:39:03Z", "2026-11-19T20:35:03Z"].map(at => run(at, ["2026-11-19T20:33:50Z"]));
  assert.deepEqual(unreadWindows(["clean_min_30"], runs[0]!.metrics), []);
  assert.deepEqual(owedKeys(["clean_min_30"], runs, new Set()), []);
  const fresh = ["2026-11-19T20:54:03Z", "2026-11-19T20:39:03Z", "2026-11-19T20:35:03Z"].map(at => run(at, ["2026-11-19T20:33:50Z", "2026-11-19T20:45:10Z"]));
  assert.deepEqual(owedKeys(["clean_min_30"], fresh, new Set()), ["clean_min_30"]);
});
