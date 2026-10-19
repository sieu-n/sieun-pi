// Owner 10-19: "plan should be tasks all eventually clear". d9's plan_upkeep_all read 24 at 21:03Z, all open steps added with no done line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp } from "../src/shared/chat-board.ts";
import { hasDoneLine } from "../src/shared/upkeep-title.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const board = { v: 2, rev: 1, updatedAt: "2026-10-19T22:40:00Z", todos: [], plan: [
  { id: "p1", text: "Ship the import retry", status: "doing", note: "Done when the import e2e passes on staging", children: [
    { id: "p2", text: "Fix the capped message key", status: "doing", children: [] }] },
] } as unknown as ChatBoard;
const at = "2026-10-19T22:45:00Z";

test("a done line is a Done when note, a target or a duty metric", () => {
  assert.equal(hasDoneLine({ note: "Done when the run is green" }), true);
  assert.equal(hasDoneLine({ target: { metric: "x", target: 1 } }), true);
  assert.equal(hasDoneLine({ duty: "d9/plan_upkeep_all" }), true);
  assert.equal(hasDoneLine({ note: "Waits on the land." }), false);
});

test("plan_add flags a new open step with no done line, and saves it", () => {
  const { board: next, summary } = applyBoardOp(board, { op: "plan_add", text: "Fix the search check", parent: "p1" }, "agent", at, () => "p9");
  assert.ok(JSON.stringify(next.plan).includes("p9"));
  assert.match(summary, /p9 "Fix the search check" has no done line/);
});

test("a new step with a duty metric or a target, and a step already on the board, get no done-line flag", () => {
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_add", text: "Fix the search check", parent: "p1", duty: "d2/checks_failed" }, "agent", at, () => "p9").summary, /no done line/);
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_add", text: "Fix the search check", parent: "p1", target: { metric: "search-check reds", target: 0, unit: "reds" } }, "agent", at, () => "p9").summary, /no done line/);
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_update", id: "p2", note: "Working on it" }, "agent", at, () => "p9").summary, /no done line/);
});

test("an upkeep title gets only its upkeep flag", () => {
  const { summary } = applyBoardOp(board, { op: "plan_add", text: "Keep the crawler working" }, "agent", at, () => "p9");
  assert.match(summary, /reads like upkeep/);
  assert.doesNotMatch(summary, /no done line/);
});
