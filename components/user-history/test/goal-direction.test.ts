import assert from "node:assert/strict";
import { test } from "node:test";
import { goalNumber, goalTrend } from "../src/checkin-goals.ts";
import { targetMet, targetOp } from "../src/shared/chat-board.ts";
import type { GoalTarget, PlanItem } from "../src/shared/types.ts";

// VP of CI (01a1180e) on 10-18 07:04 KST: p1 read the m1-air job start wait p90 at 157.8 against a 10 min target and p60 the land run time p50
// at 141.7 against 45 min. Both came out "at target", so goal_gaps read 0 and the two biggest CI goals were hidden.
const P1: GoalTarget = { metric: "m1-air job start wait from the push, p90, 24 h", target: 10, unit: "min", current: 157.8, measuredAt: "2026-10-15T16:37:00.000Z", source: "ci-system-duty.mjs" };
const P60: GoalTarget = { metric: "passed land run time, p50 over 7 days", target: 45, unit: "min", current: 141.7, measuredAt: "2026-10-15T16:37:00.000Z", source: "ci-system-duty.mjs" };
const DAYS: GoalTarget = { metric: "Days of the last 7 with a daily code health report for both repos", target: 7, unit: "days", current: 2, measuredAt: "2026-10-17T20:11:00.000Z", source: "report store" };
const goal = (id: string, target: GoalTarget): PlanItem => ({ id, text: target.metric, status: "doing", target, children: [] });

test("targetOp: a wait, a time, latency, misses and errors are lower-is-better; counts and shares are higher-is-better; direction overrides the words", () => {
  assert.equal(targetOp(P1), "<=");
  assert.equal(targetOp(P60), "<=");
  for (const metric of ["p95 latency", "missed slots", "error reads share", "failed runs", "cancelled jobs", "stuck steps"]) assert.equal(targetOp({ metric }), "<=", metric);
  assert.equal(targetOp(DAYS), ">=");
  for (const metric of ["gaps measured", "duties green", "uptime", "listings measured", "clean minutes of the last 30"]) assert.equal(targetOp({ metric }), ">=", metric);
  assert.equal(targetOp({ metric: "time saved per week", direction: "up" }), ">=");
  assert.equal(targetOp({ metric: "pages per day", direction: "down" }), "<=");
});

test("VP of CI p1 and p60: a lower-is-better goal above its target is off target, and below it is met; a higher-is-better goal the other way", () => {
  for (const [id, target] of [["p1", P1], ["p60", P60]] as const) {
    const number = goalNumber(goal(id, target), 30 * 60_000, new Map())!;
    assert.equal(number.op, "<=");
    assert.notEqual(goalTrend(number, undefined).trend.kind, "met", `${id} is not at target`);
    assert.equal(targetMet(target), false);
    assert.equal(goalTrend({ ...number, value: target.target - 1 }, undefined).trend.kind, "met", `${id} under its target is met`);
  }
  const days = goalNumber(goal("p5", DAYS), 30 * 60_000, new Map())!;
  assert.equal(days.op, ">=");
  assert.notEqual(goalTrend(days, undefined).trend.kind, "met");
  assert.equal(goalTrend({ ...days, value: 7 }, undefined).trend.kind, "met");
});

test("goal reading: a duty metric a step under the goal fixes, with the goal's target, read after the target's reading, is the goal's number (AI harness p453, 10-18)", () => {
  const p453: PlanItem = { id: "p453", text: "Every duty in every chat is green", status: "doing",
    target: { metric: "duties green", target: 100, unit: "%", current: 25.7, measuredAt: "2026-10-16T06:27:00.000Z", source: "duty-fleet.ts" },
    children: [{ id: "p470", text: "Every duty meets every target on its last run", status: "todo", duty: "d1/duties_green_pct", children: [] }] };
  const at = Date.parse("2026-10-17T22:07:00.000Z");
  const newer = goalNumber(p453, 30 * 60_000, new Map([["d1/duties_green_pct", { met: false, at, value: 29.7, target: 100, op: ">=" as const }]]))!;
  assert.deepEqual([newer.value, newer.measuredAt, newer.source], [29.7, at, "the last run of duty metric d1/duties_green_pct"]);
  const older = goalNumber(p453, 30 * 60_000, new Map([["d1/duties_green_pct", { met: false, at: Date.parse("2026-10-15T00:00:00.000Z"), value: 20, target: 100, op: ">=" as const }]]))!;
  assert.equal(older.value, 25.7, "an older run leaves the target's reading");
  const other = goalNumber(p453, 30 * 60_000, new Map([["d1/duties_green_pct", { met: false, at, value: 3, target: 5, op: ">=" as const }]]))!;
  assert.equal(other.value, 25.7, "a metric with another target is another number");
});
