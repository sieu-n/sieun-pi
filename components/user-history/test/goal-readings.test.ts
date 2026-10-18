import assert from "node:assert/strict";
import { test } from "node:test";
import { goalReadingOps } from "../src/goal-readings.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const step = (id: string, duty: string, status: PlanItem["status"]): PlanItem => ({ id, text: `step ${id}`, status, duty, job: "a job", children: [] });

// VP of CI's p75 on 10-18: the goal's job is the chat's own session id, its fix steps fix d3/review_problems_open, and its push step carries
// the check-in's link checkin/goal_gaps. The 11:57Z and 12:00Z check-ins wrote goal_gaps 3 into its target over d3's 1.
const p75 = (): ChatBoard => ({ v: 2, rev: 1, todos: [], updatedAt: "2026-10-18T11:00:00.000Z", plan: [{
  id: "p75", text: "Monorepo and GitHub Actions are designed right, checked by a qualitative review every week", status: "doing", job: CHAT,
  target: { metric: "open repo design review problems", target: 0, unit: "problems", current: 1, measuredAt: "2026-10-18T11:00:00.000Z", source: "duty d3 metric review_problems_open" },
  children: [step("p239", "d3/review_problems_open", "done"), step("p263", "checkin/goal_gaps", "doing")],
}] });
const at = Date.parse("2026-10-18T12:00:36.163Z");

test("a check-in run's goal_gaps never becomes the number of a goal whose push step carries its link", () => {
  assert.deepEqual(goalReadingOps(p75(), "checkin", at, { goal_gaps: { value: 3, target: 0, op: "<=", met: false } }), []);
});

test("the duty metric a goal's fix step names writes the goal's number", () => {
  const ops = goalReadingOps(p75(), "d3", at, { review_problems_open: { value: 1, target: 0, op: "<=", met: false } });
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.ok(op.op === "plan_update" && op.id === "p75");
  assert.equal(op.target?.current, 1);
  assert.match(op.target?.source ?? "", /^duty d3 metric review_problems_open/);
});

test("a run that measures nothing the goal names leaves it untouched", () => {
  assert.deepEqual(goalReadingOps(p75(), "d3", at, { apps_without_lane: { value: 2, target: 0, op: "<=", met: false } }), []);
});
