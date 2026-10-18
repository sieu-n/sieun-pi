// ops guy 10-18: p45 and p221 sat at 64 of 71 and 60 of 69 steps of standing risks like p315 "us-metal01 filesystem fills within 30 days", and the owner said "stop being paranoid in plan under p45, p221" (c110).
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertSteps, goalsWithoutDoneLine, planRiskSteps } from "../src/checkin-findings.ts";
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

// VP of CI 10-18: p273 "CI history ingest has not read GitHub for 15 min", a firing alert with a fixable cause, read as a standing risk 12 check-ins in a row.
test("a bridge step whose alert still fires is work, and a bridge step whose alert resolved is a risk wherever it sits", () => {
  const ci = { todos: [], plan: [
    { id: "p250", text: "Firing prod alerts", status: "doing", children: [
      { id: "p273", text: "CI history ingest has not read GitHub for 15 min", status: "todo", children: [] },
      { id: "p272", text: "CI cache box disk under 10%", status: "todo", children: [] }] },
    { id: "p146", text: "Crawler ops", status: "doing", note: "Done when no alert fires", children: [
      { id: "p700", text: "Production Kafka dead-letter topic grows", status: "todo", children: [] },
      { id: "p701", text: "Production PostgreSQL backends over 80%", status: "todo", children: [] },
      { id: "p702", text: "Ship the triage split", status: "doing", children: [] }] },
  ] } as unknown as ChatBoard;
  const state = { v: 2, rules: {
    a: { chat: "ci", step: "p273", startsAt: "x", instances: {} },
    b: { chat: "ci", step: "p272", resolvedAt: 1, instances: {} },
    c: { chat: "ci", step: "p700", instances: {} },
    d: { chat: "ci", step: "p701", resolvedAt: 2, instances: {} },
    e: { chat: "other", step: "p702", resolvedAt: 3, instances: {} } } };
  assert.deepEqual(planRiskSteps(ci, alertSteps(state, "ci")).map(step => step.id), ["p272", "p701"]);
  assert.deepEqual(alertSteps("not a state", "ci").firing.size, 0);
});
