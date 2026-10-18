// ops guy 10-18: p45 and p221 sat at 64 of 71 and 60 of 69 steps of standing risks like p315 "us-metal01 filesystem fills within 30 days", and the owner said "stop being paranoid in plan under p45, p221" (c110).
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalsWithoutDoneLine, planRiskSteps } from "../src/checkin-findings.ts";
import { convergenceMisses } from "../src/chat-checkin.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const board = { todos: [], plan: [
  { id: "p221", text: "Firing prod alerts", status: "doing", children: [
    { id: "p315", text: "us-metal01 filesystem fills within 30 days", status: "todo", children: [] },
    { id: "p316", text: "CPU saturated", status: "done", children: [] }] },
  { id: "p195", text: "Overhaul obs.virev.ai", status: "doing", note: "Done when the owner opens obs.virev.ai and sees only owned boards", children: [] },
  { id: "p192", text: "Everything lands on staging", status: "doing", target: { metric: "landed", target: 1 }, children: [] },
  { id: "p45", text: "Mac and Airs stay healthy", status: "doing", note: "Mac and Air health is upkeep", children: [] },
] } as unknown as ChatBoard;

test("a goal with neither a target nor a Done when note has no done line", () => {
  assert.deepEqual(goalsWithoutDoneLine(board).map(goal => goal.id), ["p221", "p45"]);
});

test("open steps under the alert goal count as standing risks, closed ones do not", () => {
  assert.deepEqual(planRiskSteps(board).map(step => step.id), ["p315"]);
});

test("the check-in measure counts both and flags each item", () => {
  const empty = { scope: [], gates: [], stalled: [], goals: [], blocked: [], done: [], loose: [], extra: [], underClosed: [], held: [], waitsMet: [], noProgress: null, stale: [], fold: [] };
  const out = convergenceMisses("chat", [], { ...empty, noDoneLine: goalsWithoutDoneLine(board), risks: planRiskSteps(board) }, {}, 7_200_000, Date.now());
  assert.equal(out.metrics.no_done_line, 2);
  assert.equal(out.metrics.plan_risks, 1);
  assert.deepEqual(out.flagged.map(slice => [slice.kind, slice.item]), [["no_done_line", "p221"], ["no_done_line", "p45"], ["plan_risks", "p315"]]);
});
