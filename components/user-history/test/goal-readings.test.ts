import assert from "node:assert/strict";
import { test } from "node:test";
import { goalReadingOps } from "../src/goal-readings.ts";
import { applyBoardOp } from "../src/shared/chat-board.ts";
import type { ChatBoard } from "../src/shared/types.ts";

// AI harness p453 on 10-18: the board still read duties green 25.7% from 10-16 06:27Z while the newest measure said 29.7%.
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-17T20:00:00.000Z", todos: [], plan: [
  { id: "p453", text: "Every duty in every chat is green", status: "doing",
    target: { metric: "duties green", target: 100, unit: "%", current: 25.7, measuredAt: "2026-10-16T06:27:00.000Z", source: "duty-fleet.ts" },
    children: [{ id: "p470", text: "Every duty meets every target on its last run", status: "todo", duty: "d1/duties_green_pct", children: [] }] },
  { id: "p1", text: "CI waits", status: "doing", target: { metric: "job start wait p90", target: 10, unit: "min" },
    children: [{ id: "p2", text: "Cut the wait", status: "doing", duty: "d1/wait_p90", children: [] }] },
] }) as ChatBoard;
const AT = Date.parse("2026-10-17T22:07:00.000Z");
const metric = (value: number, target: number, op: ">=" | "<=") => ({ value, target, op, met: op === ">=" ? value >= target : value <= target });

test("goal readings: a measured run writes its value into the goal whose step fixes that metric, with the goal's target and direction, and the board takes it", () => {
  const ops = goalReadingOps(board(), "d1", AT, { duties_green_pct: metric(29.7, 100, ">="), wait_p90: metric(42, 10, "<=") });
  assert.deepEqual(ops.map(op => op.op === "plan_update" ? [op.id, op.target?.current, op.target?.measuredAt] : []),
    [["p453", 29.7, "2026-10-17T22:07:00.000Z"], ["p1", 42, "2026-10-17T22:07:00.000Z"]]);
  let next = board();
  for (const op of ops) next = applyBoardOp(next, op, "agent", "2026-10-17T22:08:00.000Z", () => "x").board;
  assert.equal(next.plan[0]!.target?.current, 29.7);
  assert.equal(next.plan[0]!.target?.source, "duty d1 metric duties_green_pct, its run at 2026-10-17T22:07Z");
});

test("goal readings: an older run, another target, another direction, another duty or a negative error value writes nothing", () => {
  assert.deepEqual(goalReadingOps(board(), "d1", Date.parse("2026-10-15T00:00:00.000Z"), { duties_green_pct: metric(20, 100, ">=") }).map(op => op.op === "plan_update" && op.id), []);
  assert.deepEqual(goalReadingOps(board(), "d1", AT, { duties_green_pct: metric(29.7, 90, ">=") }), []);
  assert.deepEqual(goalReadingOps(board(), "d1", AT, { wait_p90: metric(42, 10, ">=") }), []);
  assert.deepEqual(goalReadingOps(board(), "d2", AT, { duties_green_pct: metric(29.7, 100, ">=") }), []);
  assert.deepEqual(goalReadingOps(board(), "d1", AT, { duties_green_pct: metric(-1, 100, ">=") }), []);
});
