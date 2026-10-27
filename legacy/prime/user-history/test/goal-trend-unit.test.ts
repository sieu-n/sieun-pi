// VP of CI p289 "codebase shrinks by 70%" on 10-19: the memo kept raw line counts from before the target moved to percent, and goal_gaps read
// 3.2 of 70% as "-1,429,601.8 points since 10-19 11:25Z".
import assert from "node:assert/strict";
import { test } from "node:test";
import { type GoalNumber, goalTrend, trendText } from "../src/checkin-goals.ts";

const memo = { readings: [{ value: 1429605, at: 1792409100000 }, { value: 1428644, at: 1792409400000 }, { value: 1423140, at: 1792412400000 },
  { value: 2.9, at: 1792422120000 }, { value: 3.1, at: 1792422900000 }, { value: 3.2, at: 1792426800000 }], still: 0 };
const number = (value: number, at: string, unit = "%", metric = "repo lines removed"): GoalNumber =>
  ({ metric, target: 70, unit, op: ">=", value, measuredAt: Date.parse(at), source: "loc.mjs", staleMs: 86_400_000 });

test("readings in another unit drop out of the trend", () => {
  const now = number(5.5, "2026-10-19T17:02:00Z");
  const { trend, memo: next } = goalTrend(now, memo);
  assert.equal(trend.kind, "moving");
  assert.ok(trend.kind === "moving" && Math.abs(trend.delta - 2.6) < 1e-9, JSON.stringify(trend));
  assert.doesNotMatch(trendText(now, trend, false), /1,429/);
  assert.deepEqual(next!.readings.map(reading => reading.value), [2.9, 3.1, 3.2, 5.5]);
});

test("a change of metric or unit restarts the trend; a new target in the same unit does not", () => {
  const { memo: kept } = goalTrend(number(5.5, "2026-10-19T17:02:00Z"), memo);
  const lines = { ...number(1385123, "2026-10-19T18:00:00Z", "lines", "repo lines"), target: 439571, op: "<=" as const };
  assert.equal(goalTrend(lines, kept).trend.kind, "first");
  const retarget = { ...number(6, "2026-10-19T18:00:00Z"), target: 60 };
  assert.equal(goalTrend(retarget, kept).trend.kind, "moving");
});
