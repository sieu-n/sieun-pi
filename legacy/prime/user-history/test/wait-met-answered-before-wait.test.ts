// sep launch!! 11-02: p144 waited for "walk 28; t52 Jev credits", meaning the TypeSafe credits todo on chat 01a11af8 (its p695), and three
// check-ins in a row flagged it wait_met because waitsMet read this board's own t52, a crawl pricing ask the owner answered on 10-28. A wait set
// after a todo's answer is not waiting on that answer, so the board stamps when a waitFor got its text and when a todo was answered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsMet } from "../src/checkin-findings.ts";
import { stepView } from "../src/checkin-steps.ts";
import { applyBoardOp, stampBoard } from "../src/shared/chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const now = Date.parse("2026-11-02T16:16:00Z");
const self = new Set([SEP, "sep launch!!"]);
const t52 = (answeredAt?: string): OwnerTodo => ({ id: "t52", text: "How should a new free brand's first crawl bill?", done: true, from: "agent",
  at: "2026-10-28T04:22:02.222Z", step: "p118", reply: "make it 0.1 cent/page. and have up to 80/300/3000 brands included.", answeredBy: "owner",
  ...(answeredAt ? { answeredAt } : {}) });
const p144 = (waitForAt?: string): PlanItem => ({ id: "p144", text: "Onboarding's AI picks read like a real campaign a brand manager would send",
  status: "doing", job: "onboarding staging walk metal", waitFor: "walk 28; t52 Jev credits", ...(waitForAt ? { waitForAt } : {}), children: [] });
const flags = (item: PlanItem, todo: OwnerTodo) => {
  const board = { v: 2, rev: 1, updatedAt: "2026-11-02T15:00:00Z", plan: [item], todos: [todo] } as ChatBoard;
  return waitsMet([stepView(item, now - 3_600_000, self, [], [], [], now)], board, [], self).map(({ view, over }) => [view.item.id, over]);
};
const ANSWERED = ["t52 is answered (read the answer: a hold is not a go)"];

test("p144's wait set on 11-02 is not over because its t52 was answered on 10-28", () => {
  assert.deepEqual(flags(p144("2026-11-02T14:50:00.000Z"), t52("2026-10-28T05:10:00.000Z")), []);
});

test("a todo answered before the board stamped answers predates a stamped wait", () => {
  assert.deepEqual(flags(p144("2026-11-02T14:50:00.000Z"), t52()), []);
});

test("a wait set before its todo's answer is over once the owner answers", () => {
  assert.deepEqual(flags(p144("2026-10-27T09:00:00.000Z"), t52("2026-10-28T05:10:00.000Z")), [["p144", ANSWERED]]);
});

test("a wait set before the board stamped waits reads its todo as before", () => {
  assert.deepEqual(flags(p144(), t52()), [["p144", ANSWERED]]);
});

test("the board stamps a new waitFor and a new answer, and keeps both stamps through other edits", () => {
  const empty: ChatBoard = { v: 2, rev: 0, plan: [], todos: [], updatedAt: "2026-10-27T00:00:00.000Z" };
  const ids = { p: 0, t: 0 };
  const next = (kind: "p" | "t") => `${kind}${++ids[kind]}`;
  const write = (board: ChatBoard, op: Parameters<typeof applyBoardOp>[1], actor: "agent" | "owner", at: string) =>
    stampBoard(board, applyBoardOp(board, op, actor, at, next).board, at);
  let board = write(empty, { op: "plan_add", text: "Walk 28", waitFor: "t1 answer" }, "agent", "2026-10-27T09:00:00.000Z");
  board = write(board, { op: "todo_add", text: "How should the first crawl bill?" }, "agent", "2026-10-27T09:01:00.000Z");
  assert.equal(board.plan[0]!.waitForAt, "2026-10-27T09:00:00.000Z");
  assert.equal(board.todos[0]!.answeredAt, undefined);
  board = write(board, { op: "todo_update", id: "t1", reply: "make it 0.1 cent/page" }, "owner", "2026-10-28T05:10:00.000Z");
  assert.equal(board.todos[0]!.answeredAt, "2026-10-28T05:10:00.000Z");
  board = write(board, { op: "plan_update", id: "p1", note: "walk 27 fixes landed" }, "agent", "2026-10-29T00:00:00.000Z");
  board = write(board, { op: "todo_update", id: "t1", done: true }, "owner", "2026-10-29T01:00:00.000Z");
  assert.equal(board.plan[0]!.waitForAt, "2026-10-27T09:00:00.000Z");
  assert.equal(board.todos[0]!.answeredAt, "2026-10-28T05:10:00.000Z");
  board = write(board, { op: "plan_update", id: "p1", waitFor: "walk 28; t1 credits" }, "agent", "2026-11-02T14:50:00.000Z");
  assert.equal(board.plan[0]!.waitForAt, "2026-11-02T14:50:00.000Z");
  board = write(board, { op: "plan_set", items: [{ id: "p1", text: "Walk 28", waitFor: "walk 28; t1 credits" }] }, "agent", "2026-11-02T15:00:00.000Z");
  assert.equal(board.plan[0]!.waitForAt, "2026-11-02T14:50:00.000Z");
  board = write(board, { op: "plan_update", id: "p1", waitFor: null }, "agent", "2026-11-02T15:10:00.000Z");
  assert.equal(board.plan[0]!.waitForAt, undefined);
});
