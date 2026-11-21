/**
 * The owner's plan ops in the board reducer (web/src/lib/api/shared/chat-board.ts): he adds, renames, closes, reopens and deletes a step, and
 * plan_update's `before` puts a step before a sibling or last, with a bad `before` refused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/plan-owner-ops.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, emptyBoard, nextIds, parseBoardOp } from "../../web/src/lib/api/shared/chat-board.ts";
import type { ChatBoard } from "../../web/src/lib/api/shared/types.ts";

const NOW = "2026-11-22T00:00:00.000Z";
const owner = (board: ChatBoard, raw: unknown) => applyBoardOp(board, parseBoardOp(raw), "owner", NOW, nextIds(board));
const ids = (board: ChatBoard) => board.plan.map(step => step.id);

function seeded(): ChatBoard {
  let board = emptyBoard(NOW);
  for (const text of ["First", "Second", "Third"]) board = owner(board, { op: "plan_add", text }).board;
  return board;
}

test("the owner adds, renames, closes, reopens and deletes a step", () => {
  let board = seeded();
  assert.deepEqual(ids(board), ["p1", "p2", "p3"]);
  const added = owner(board, { op: "plan_add", text: "Under first", parent: "p1" });
  assert.match(added.summary, /^Owner added p4 "Under first" under p1/);
  board = added.board;
  board = owner(board, { op: "plan_update", id: "p2", text: "Second, renamed" }).board;
  assert.equal(board.plan[1]!.text, "Second, renamed");
  board = owner(board, { op: "plan_update", id: "p3", status: "done" }).board;
  assert.equal(board.plan[2]!.status, "done");
  board = owner(board, { op: "plan_update", id: "p3", status: "todo" }).board;
  assert.equal(board.plan[2]!.status, "todo");
  const removed = owner(board, { op: "plan_remove", id: "p1" });
  assert.match(removed.summary, /^Owner removed p1 "First" and its 1 step/);
  assert.deepEqual(ids(removed.board), ["p2", "p3"]);
});

test("before puts a step before a sibling, null puts it last, and a step from another list is refused", () => {
  const board = seeded();
  assert.deepEqual(ids(owner(board, { op: "plan_update", id: "p3", before: "p1" }).board), ["p3", "p1", "p2"]);
  assert.deepEqual(ids(owner(board, { op: "plan_update", id: "p1", before: null }).board), ["p2", "p3", "p1"]);
  const nested = owner(board, { op: "plan_add", text: "Child", parent: "p2" }).board;
  assert.throws(() => owner(nested, { op: "plan_update", id: "p1", before: "p4" }), /p4 is not a step beside p1/);
  const moved = owner(nested, { op: "plan_update", id: "p1", parent: "p2", before: "p4" }).board;
  assert.deepEqual(moved.plan.find(step => step.id === "p2")!.children.map(step => step.id), ["p1", "p4"]);
});

test("the owner still cannot replace the whole plan", () => {
  assert.throws(() => owner(seeded(), { op: "plan_set", items: [] }), /only the agent replaces the whole plan/);
});
