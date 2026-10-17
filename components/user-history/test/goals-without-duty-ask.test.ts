import assert from "node:assert/strict";
import { test } from "node:test";
import { goalsWithoutDuty } from "../src/checkin-findings.ts";
import type { ChatBoard } from "../src/shared/types.ts";

// 'spec and monitoring system' (01a140fb): goals_without_duty flagged p5 in 14 check-ins in a row while t1, linked to p5, already asked the
// owner on For you from 10-16 04:54Z whether to add the morning report read.
const board = (todoDone: boolean, step = "p5"): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-17T20:11:00.000Z", plan: [
  { id: "p5", text: "Track code health of agent work with a daily git report", status: "todo",
    target: { metric: "Days of the last 7 with a daily code health report for both repos", target: 7, unit: "days", current: 2, measuredAt: "2026-10-17T20:11:00.000Z", source: "report store" },
    children: [{ id: "p6", text: "Build: the daily runner", status: "doing", children: [] }] },
  { id: "p9", text: "Spec the monitoring app", status: "todo", children: [] },
], todos: [{ id: "t1", text: "Want me to read the code health report every morning and push the jobs when a day is missing? The report work goes on either way.",
  done: todoDone, choices: ["Yes, add it", "No"], step, from: "agent", at: "2026-10-16T04:54:08.310Z" }] }) as ChatBoard;

test("goals without duty: a goal For you already asks about, by an open todo linked to it or to its step, is not flagged again (01a140fb p5 and t1)", () => {
  assert.deepEqual(goalsWithoutDuty(board(false), []).map(goal => goal.id), ["p9"], "t1 is the ask for p5");
  assert.deepEqual(goalsWithoutDuty(board(false, "p6"), []).map(goal => goal.id), ["p9"], "a todo linked to a step of p5 asks for p5 too");
  assert.deepEqual(goalsWithoutDuty(board(true), []).map(goal => goal.id), ["p5", "p9"], "an answered todo asks nothing now");
});
