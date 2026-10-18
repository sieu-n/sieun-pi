// chat-057a 10-18: its check-ins added push steps p50, p58, p64 and p67 under p1 "Finish the current agent recovery repairs" (2 of 6 checks)
// while the fix step p60 "Make message sends finish without blocking updates", linked to checkin/goal_gaps, had the job "metal agent runtime".
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalDueLine, goalPushes } from "../src/checkin-goals.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-18T16:30:00Z");
const p60: PlanItem = { id: "p60", text: "Make message sends finish without blocking updates", status: "doing", job: "metal agent runtime", duty: "checkin/goal_gaps", children: [] };
const p1: PlanItem = { id: "p1", text: "Finish the current agent recovery repairs", status: "doing", children: [{ id: "p8", text: "Fix slow agent messaging", status: "doing", children: [p60] }],
  target: { metric: "repair checks passing", target: 6, unit: "checks", current: 2, measuredAt: "2026-10-18T16:20:00Z", source: "verification job" } };
const board = { v: 2, rev: 1, updatedAt: "2026-10-18T16:20:00Z", plan: [p1], todos: [] } as unknown as ChatBoard;
const runtime = (state: JobFact["state"]): JobFact => ({ key: "sub-runtime", name: "metal agent runtime", state });
const views = (state: JobFact["state"]): StepView[] => [{ item: p60, owner: runtime(state), mine: false, changedAt: now - 3_600_000, cls: "doing", openTodos: [], goal: { id: "p1", text: p1.text } } as unknown as StepView];
const memo = { p1: { readings: [{ value: 2, at: now - 3_600_000 }, { value: 2, at: now - 600_000 }], still: 2 } };

test("an off-pace goal whose fix step has a live job gets a steer of that job and no new step", () => {
  const [push] = goalPushes(board, views("working"), memo as never, 30 * 60_000, now).pushes;
  assert.equal(push?.act, "steer");
  const line = goalDueLine(push!) ?? "";
  assert.match(line, /^Steer job metal agent runtime/);
  assert.match(line, /add no step/);
  assert.doesNotMatch(line, /Add a push step/);
});

test("when that job is not live, the check-in steers or restarts it on its step instead of adding a push step", () => {
  const [push] = goalPushes(board, views("ended"), memo as never, 30 * 60_000, now).pushes;
  assert.equal(push?.act, "start");
  const line = goalDueLine(push!) ?? "";
  assert.match(line, /^Steer the job metal agent runtime on p60, the push step/);
  assert.match(line, /Add no new step/);
  assert.doesNotMatch(line, /Add a push step/);
});
