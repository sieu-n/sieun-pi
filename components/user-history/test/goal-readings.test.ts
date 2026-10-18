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

// Crawler VP's p146 at 17:17Z on 10-18: its target reads d3's new unbacked limits, and the done fix step p538 carries checkin/stuck_steps,
// whose target and direction match. The check-in wrote its stuck_steps 2 into the goal.
test("a check-in run's board counts never become a goal's number through a fix step's checkin link", () => {
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-18T17:00:00.000Z", plan: [{
    id: "p146", text: "Crawler ops", status: "doing",
    target: { metric: "new unbacked limits", target: 0, unit: "limits", current: 0, measuredAt: "2026-10-18T15:59:48.000Z", source: "d3 scanner" },
    children: [step("p538", "checkin/stuck_steps", "done"), step("p748", "d3/new_unbacked_limits", "doing")],
  }] };
  const run = Date.parse("2026-10-18T17:17:56.231Z");
  assert.deepEqual(goalReadingOps(board, "checkin", run, { stuck_steps: { value: 2, target: 0, op: "<=", met: false } }), []);
  const ops = goalReadingOps(board, "d3", run, { new_unbacked_limits: { value: 0, target: 0, op: "<=", met: true } });
  assert.equal(ops.length, 1);
  assert.match(ops[0]!.op === "plan_update" ? ops[0]!.target?.source ?? "" : "", /^duty d3 metric new_unbacked_limits/);
});

// Crawler VP's p146 on 10-18: the done d2 fix steps p511 (dropped) and p700 carry d2/supply_hold_minutes with the goal's target 0, so each d2 run
// wrote its supply hold into "new unbacked limits", and the open d3/repo_unbacked_limits p506 (2) sits beside the done d3/new_unbacked_limits p504.
const p146 = (): ChatBoard => ({ v: 2, rev: 1, todos: [], updatedAt: "2026-10-18T17:00:00.000Z", plan: [{
  id: "p146", text: "Crawler ops", status: "doing",
  target: { metric: "new unbacked limits", target: 0, unit: "limits", current: 0, measuredAt: "2026-10-18T15:59:48.000Z", source: "d3 scanner" },
  children: [step("p504", "d3/new_unbacked_limits", "done"), step("p511", "d2/supply_hold_minutes", "dropped"), step("p506", "d3/repo_unbacked_limits", "doing"),
    step("p700", "d2/supply_hold_minutes", "done")],
}] });
const run1721 = Date.parse("2026-10-18T17:21:00.000Z");

test("a done step's duty link writes nothing into a goal whose metric does not name it", () => {
  assert.deepEqual(goalReadingOps(p146(), "d2", run1721, { supply_hold_minutes: { value: 0, target: 0, op: "<=", met: true } }), []);
});

test("the link a goal's metric names wins over an open step's link to another metric of the same duty", () => {
  const ops = goalReadingOps(p146(), "d3", run1721, {
    repo_unbacked_limits: { value: 2, target: 0, op: "<=", met: false }, new_unbacked_limits: { value: 0, target: 0, op: "<=", met: true } });
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.ok(op.op === "plan_update");
  assert.equal(op.target?.current, 0);
  assert.match(op.target?.source ?? "", /^duty d3 metric new_unbacked_limits/);
});
