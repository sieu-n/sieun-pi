import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const result = (value: number, target = 0): MetricResult => ({ value, target, op: "<=", met: value <= target });
const run = (at: number, values: Record<string, number>, extra: Partial<DutyRunRecord> = {}): DutyRunRecord => {
  const metrics = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, result(value)]));
  return { duty: "d1", at, trigger: "schedule", ms: 0, verdict: Object.values(metrics).every(entry => entry.met) ? "met" : "missed", metrics, summary: "", ...extra };
};

test("a metric missed 3 runs with no move is stuck, one that moved is not", () => {
  const runs = [run(4, { a: 5, b: 2 }), run(3, { a: 5, b: 4 }), run(2, { a: 5, b: 6 }), run(1, { a: 0, b: 0 })];
  const streaks = metricStreaks(runs);
  assert.deepEqual(streaks.map(entry => [entry.key, entry.misses, entry.moved, entry.stuck]), [["a", 3, false, true], ["b", 3, true, false]]);
});

test("skipped and error runs neither extend nor break a streak, and the after-job measure wins", () => {
  const runs = [run(5, { a: 3 }, { after: { at: 6, verdict: "met", metrics: { a: result(0) }, summary: "" } }), run(4, { a: 3 }), { ...run(3, {}), verdict: "skipped" as const },
    { ...run(2, {}), verdict: "error" as const }, run(1, { a: 3 })];
  assert.deepEqual(metricStreaks(runs), []);
  const missed = metricStreaks(runs.slice(1));
  assert.equal(missed[0]?.misses, 2);
});

test("the newest run's fix step comes with the streak", () => {
  const streaks = metricStreaks([run(2, { a: 1 }, { fixes: { a: { step: "p4", job: "fix a", live: true } } }), run(1, { a: 1 })]);
  assert.deepEqual(streaks[0]?.fix, { step: "p4", job: "fix a", live: true });
});
