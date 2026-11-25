/**
 * Each board step's `updatedAt` (web/src/lib/api/shared/chat-board.ts `stampSteps`): an op stamps the steps it adds or changes, keeps the time
 * of every other step, leaves a parent's time when only a step under it changes, and keeps a step's time through a plan_set that rewrites it
 * unchanged. GET /api/agents/<id>/board answers the board as stored, so a reader there counts how long a step sat unchanged.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/step-updated-at.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, emptyBoard, findItem, nextIds, parseBoardOp, stampSteps } from "../../web/src/lib/api/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../../web/src/lib/api/shared/types.ts";

const T1 = "2026-11-26T01:00:00.000Z";
const T2 = "2026-11-26T02:00:00.000Z";
const T3 = "2026-11-26T03:00:00.000Z";
const agent = (board: ChatBoard, raw: unknown, now: string) => applyBoardOp(board, parseBoardOp(raw), "agent", now, nextIds(board)).board;
const at = (board: ChatBoard, id: string) => findItem(board.plan, id)?.item.updatedAt;

test("an op stamps the steps it adds or changes and keeps every other step's time", () => {
  let board = emptyBoard(T1);
  board = agent(board, { op: "plan_add", text: "Goal" }, T1);
  board = agent(board, { op: "plan_add", text: "Step under it", parent: "p1" }, T1);
  board = agent(board, { op: "plan_add", text: "Other goal" }, T1);
  assert.deepEqual([at(board, "p1"), at(board, "p2"), at(board, "p3")], [T1, T1, T1]);
  board = agent(board, { op: "plan_update", id: "p3", note: "Measured 4 of 5." }, T2);
  assert.equal(at(board, "p3"), T2);
  assert.equal(at(board, "p1"), T1);
  board = agent(board, { op: "plan_update", id: "p2", status: "doing" }, T3);
  assert.equal(at(board, "p2"), T3);
  assert.equal(at(board, "p1"), T1, "a change under a step leaves the step's own time");
  assert.equal(at(board, "p3"), T2);
});

test("a plan_set that rewrites a step unchanged keeps its time, and a changed one gets the new time", () => {
  let board = emptyBoard(T1);
  board = agent(board, { op: "plan_add", text: "Keep" }, T1);
  board = agent(board, { op: "plan_add", text: "Rename" }, T1);
  const plan = board.plan.map(({ id, text, status }) => ({ id, text: text === "Rename" ? "Renamed" : text, status, children: [] }));
  board = agent(board, { op: "plan_set", items: plan }, T2);
  assert.equal(at(board, "p1"), T1);
  assert.equal(at(board, "p2"), T2);
});

test("a step stored before the field carries none until its next change", () => {
  const old: PlanItem[] = [{ id: "p1", text: "Old", status: "todo", children: [] }, { id: "p2", text: "Old too", status: "todo", children: [] }];
  const next = stampSteps(old, [old[0]!, { ...old[1]!, status: "done" }], T2);
  assert.equal(next[0]!.updatedAt, undefined);
  assert.equal(next[0], old[0], "an unchanged step keeps its object");
  assert.equal(next[1]!.updatedAt, T2);
});
