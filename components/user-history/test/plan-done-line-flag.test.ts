// Owner 10-19: "plan should be tasks all eventually clear". d9's plan_upkeep_all read 24 at 21:03Z, all open steps added with no done line.
// At 10-20 00:29Z it read 6: plan_add had dropped the "Done when" note of p27, p104, p771 and p772, and a job's plan_update replaced p136's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, parseBoardOps } from "../src/shared/chat-board.ts";
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

test("plan_add stores its note, so a step added with a Done when note gets no flag", () => {
  const [op] = parseBoardOps([{ op: "plan_add", parent: "p1", status: "doing", job: "chat projection stalls", text: "Stop the projection stalls",
    note: "Done when the live loop's p99 falls under 1 s." }]);
  const { board: next, summary } = applyBoardOp(board, op!, "agent", at, () => "p9");
  assert.equal(next.plan[0]!.children[1]!.note, "Done when the live loop's p99 falls under 1 s.");
  assert.doesNotMatch(summary, /no done line/);
});

test("a plan_update note with no Done when sentence keeps the old one in front, and a new Done when line replaces it", () => {
  const p136 = { ...board, plan: [{ id: "p1", text: "Ship the next release", status: "doing", children: [],
    note: "Done when `curl -s https://crawler.virev.ai/health` reads the promote's sha. Verify 393 failed." }] } as unknown as ChatBoard;
  const kept = applyBoardOp(p136, { op: "plan_update", id: "p1", note: "00:36Z: verify 394 failed too." }, "agent", at, () => "p9");
  assert.equal(kept.board.plan[0]!.note, "Done when `curl -s https://crawler.virev.ai/health` reads the promote's sha. 00:36Z: verify 394 failed too.");
  assert.match(kept.summary, /kept its Done when line/);
  const swapped = applyBoardOp(p136, { op: "plan_update", id: "p1", note: "Done when prod reads the new sha." }, "agent", at, () => "p9");
  assert.equal(swapped.board.plan[0]!.note, "Done when prod reads the new sha.");
  const closed = applyBoardOp(p136, { op: "plan_update", id: "p1", status: "done", note: "Shipped in promote 16." }, "agent", at, () => "p9");
  assert.equal(closed.board.plan[0]!.note, "Shipped in promote 16.");
});
