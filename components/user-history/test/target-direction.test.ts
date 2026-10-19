// VP of CI on 10-19: the board guessed a target's direction from its metric's words, so p60, p186, p258, p285 and p289 read as met while far
// off, and the CI auditor set their directions by hand. A target now carries its direction, and one given without it stores the direction its
// numbers show when it is set, never one from its words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalReadingOps } from "../src/goal-readings.ts";
import { applyBoardOp, emptyBoard, targetMet, targetOp } from "../src/shared/chat-board.ts";
import type { ChatBoard, GoalTarget } from "../src/shared/types.ts";

const now = "2026-10-19T15:30:00.000Z";
const reading = (metric: string, target: number, unit: string, current: number, measuredAt = "2026-10-19T15:00:00.000Z"): GoalTarget =>
  ({ metric, target, unit, current, measuredAt, source: "CI auditor" });
const added = (target: GoalTarget): ChatBoard => applyBoardOp(emptyBoard(now), { op: "plan_add", text: "A CI goal", target }, "agent", now, () => "p1").board;
const update = (board: ChatBoard, target: GoalTarget, at = now): ChatBoard => applyBoardOp(board, { op: "plan_update", id: "p1", target }, "agent", at, () => "p2").board;

const ci: { id: string; target: GoalTarget; direction: "up" | "down" }[] = [
  { id: "p60", target: reading("7-day median, land dispatch to green staging", 45, "min", 95.3), direction: "down" },
  { id: "p186", target: reading("7-day median, land dispatch to green staging", 45, "min", 63.8), direction: "down" },
  { id: "p258", target: reading("dev push to verdict p90", 10, "min", 26.1), direction: "down" },
  { id: "p285", target: reading("failed CI jobs that name what failed", 95, "%", 71), direction: "up" },
  { id: "p289", target: reading("repo lines removed", 70, "%", 3), direction: "up" },
];

for (const { id, target, direction } of ci) {
  test(`VP of CI ${id} stores the direction its numbers show and reads as not met`, () => {
    const stored = added(target).plan[0]!.target!;
    assert.equal(stored.direction, direction);
    assert.equal(targetMet(stored), false);
  });
}

test("a later write without a direction keeps the stored one, even once the number crosses its target", () => {
  let board = added(ci[1]!.target);
  board = update(board, reading("7-day median, land dispatch to green staging", 45, "min", 40, "2026-10-19T15:10:00.000Z"));
  assert.equal(board.plan[0]!.target!.direction, "down");
  assert.equal(targetMet(board.plan[0]!.target!), true);
  board = update(board, reading("7-day median, land dispatch to green staging", 45, "min", 63.8, "2026-10-19T15:20:00.000Z"));
  assert.equal(board.plan[0]!.target!.direction, "down");
  assert.equal(targetMet(board.plan[0]!.target!), false);
});

test("a given direction wins over the numbers and replaces a stored one", () => {
  const board = added({ ...ci[3]!.target, current: 99, direction: "up" });
  assert.equal(board.plan[0]!.target!.direction, "up");
  assert.equal(targetMet(board.plan[0]!.target!), true);
  assert.equal(update(board, { ...ci[3]!.target, direction: "down" }).plan[0]!.target!.direction, "down");
});

test("a metric's words never set the direction", () => {
  assert.equal(targetOp({ target: 100, current: 0 }), ">=");
  assert.equal(targetOp({ target: 3, current: 2 }), ">=");
  assert.equal(targetOp({ target: 0 }), "<=");
  assert.equal(targetMet({ metric: "Named duties listed with their 3-day failure counts", target: 100, unit: "%", current: 0 }), false);
});

test("an unmeasured target stores no direction until its first reading, which sets it", () => {
  const board = added({ metric: "dev push to verdict p90", target: 10, unit: "min" });
  assert.equal(board.plan[0]!.target!.direction, undefined);
  assert.equal(update(board, reading("dev push to verdict p90", 10, "min", 26.1)).plan[0]!.target!.direction, "down");
});

test("a duty reading of an unmeasured target writes the duty metric's direction", () => {
  const board: ChatBoard = { ...emptyBoard(now), plan: [{ id: "p258", text: "A push gets its result within 10 minutes", status: "doing",
    target: { metric: "dev push to verdict p90", target: 10, unit: "min" }, children: [{ id: "p259", text: "fix", status: "doing", duty: "d1/push_to_verdict_p90_min", children: [] }] }] };
  const ops = goalReadingOps(board, "d1", Date.parse(now), { push_to_verdict_p90_min: { value: 8, target: 10, op: "<=", met: true } });
  assert.equal(ops.length, 1);
  assert.ok(ops[0]!.op === "plan_update");
  assert.equal(ops[0]!.target?.direction, "down");
  assert.equal(ops[0]!.target?.current, 8);
});
