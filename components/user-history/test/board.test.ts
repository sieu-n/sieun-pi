import assert from "node:assert/strict";
import { test } from "node:test";
import { boardActionText, isBoardAction, isEmptyBoard, openAgentTodos, orderTodos, planProgress } from "../src/client/board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const item = (id: string, status: PlanItem["status"], children: PlanItem[] = []): PlanItem => ({ id, text: id, status, children });

test("planProgress counts every step below a goal except dropped ones", () => {
  const goal = item("p1", "doing", [
    item("p2", "done"),
    item("p3", "doing", [item("p4", "done"), item("p5", "todo"), item("p6", "dropped")]),
    item("p7", "blocked"),
  ]);
  assert.deepEqual(planProgress(goal), { done: 2, total: 5 });
  assert.equal(planProgress(item("p8", "todo")), null);
});

test("orderTodos puts open items first and newest first within each half", () => {
  const todo = (id: string, done: boolean, at: string): OwnerTodo => ({ id, text: id, done, from: "agent", at });
  const ordered = orderTodos([todo("t1", true, "2026-10-06T01:00:00Z"), todo("t2", false, "2026-10-06T02:00:00Z"), todo("t3", false, "2026-10-06T03:00:00Z"), todo("t4", true, "2026-10-06T04:00:00Z")]);
  assert.deepEqual(ordered.map(todo => todo.id), ["t3", "t2", "t4", "t1"]);
});

test("openAgentTodos counts only open asks from the agent, and an empty board is one with nothing on it", () => {
  const board: ChatBoard = { v: 1, rev: 3, plan: [], scratchpad: " ", updatedAt: "2026-10-06T00:00:00Z", todos: [
    { id: "t1", text: "a", done: false, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t2", text: "b", done: true, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t3", text: "c", done: false, from: "owner", at: "2026-10-06T00:00:00Z" },
  ] };
  assert.equal(openAgentTodos(board), 1);
  assert.equal(openAgentTodos(null), 0);
  assert.equal(isEmptyBoard(null), true);
  assert.equal(isEmptyBoard({ ...board, todos: [] }), true);
  assert.equal(isEmptyBoard(board), false);
});

test("a [board] user message is an owner action line", () => {
  assert.equal(isBoardAction('[board] Owner checked "Approve the Email picks"'), true);
  assert.equal(isBoardAction("[boards] no"), false);
  assert.equal(boardActionText('[board] Owner checked "Approve the Email picks"'), 'Owner checked "Approve the Email picks"');
});
