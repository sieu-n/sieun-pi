// VP of CI 10-18: p1 "m1-air job start wait p90, 24 h" (at most 10 min) read 104.5, and under it p258 fixes d1/push_to_verdict_p90_min and p275
// d1/run_time_p90_min, both at most 10 min too. The 17:11Z check-in read p1 at push to verdict's 221.5 and called the wait doubled.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetricFact } from "../src/checkin-done.ts";
import { goalNumber } from "../src/checkin-goals.ts";
import { goalReadingOps } from "../src/goal-readings.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const target = { metric: "m1-air job start wait p90, 24 h", target: 10, unit: "min", op: "<=", current: 104.5, measuredAt: "2026-10-18T16:45:00Z", source: "wait-p90-win.mjs" };
const step = (id: string, duty: string): PlanItem => ({ id, text: id, status: "doing", duty, children: [] }) as PlanItem;
const goal = (...children: PlanItem[]): PlanItem => ({ id: "p1", text: "CI never waits in a queue", status: "doing", target, children }) as unknown as PlanItem;
const fact = (value: number): MetricFact => ({ met: false, at: Date.parse("2026-10-18T16:53:00Z"), value, target: 10, op: "<=" });
const metrics = new Map([["d1/push_to_verdict_p90_min", fact(221.5)], ["d1/run_time_p90_min", fact(258.4)]]);

test("two duty metrics under a goal that share its target are not its number, so the goal keeps its own reading", () => {
  const number = goalNumber(goal(step("p258", "d1/push_to_verdict_p90_min"), step("p275", "d1/run_time_p90_min")), 30 * 60_000, metrics);
  assert.equal(number?.value, 104.5);
  assert.equal(number?.source, "wait-p90-win.mjs");
});

test("one newer duty metric with the goal's target and direction still replaces the goal's older reading", () => {
  const number = goalNumber(goal(step("p258", "d1/push_to_verdict_p90_min")), 30 * 60_000, metrics);
  assert.equal(number?.value, 221.5);
  assert.equal(number?.source, "the last run of duty metric d1/push_to_verdict_p90_min");
});

test("a duty run writes no reading into a goal when two of its metrics share the goal's target", () => {
  const board = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-18T16:45:00.000Z",
    plan: [goal(step("p258", "d1/push_to_verdict_p90_min"), step("p275", "d1/run_time_p90_min"))] } as unknown as ChatBoard;
  const run = { push_to_verdict_p90_min: { value: 221.5, target: 10, op: "<=" as const, met: false }, run_time_p90_min: { value: 258.4, target: 10, op: "<=" as const, met: false } };
  assert.deepEqual(goalReadingOps(board, "d1", Date.parse("2026-10-18T16:53:00Z"), run), []);
});
