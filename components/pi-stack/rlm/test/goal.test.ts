import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_ENTRY, GoalState } from "../src/goal.ts";

function fakePi() {
  const entries: { customType: string; data: unknown }[] = [];
  const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ customType, data: structuredClone(data) }), events: { emit: () => {} } } as unknown as ExtensionAPI;
  return { pi, entries };
}

test("a goal counts input and output tokens, hits its budget once, and answers in Prime's shape", () => {
  const { pi, entries } = fakePi();
  const goal = new GoalState(pi);
  const created = goal.create({ objective: "ship it", token_budget: 100 }) as { goal: Record<string, unknown>; remaining_tokens: number };
  assert.equal(created.goal.status, "active");
  assert.equal(typeof created.goal.goal_id, "string");
  assert.equal(created.remaining_tokens, 100);
  assert.equal(goal.account({ stopReason: "stop", usage: { input: 40, output: 20 } }), false);
  assert.equal(goal.account({ stopReason: "aborted", usage: { input: 500, output: 0 } }), false, "an aborted turn is not counted");
  assert.equal(goal.account({ stopReason: "toolUse", usage: { input: 30, output: 20 } }), true);
  assert.equal(goal.goal?.status, "budget_limited");
  assert.equal(goal.account({ stopReason: "stop", usage: { input: 30, output: 20 } }), false);
  assert.match(goal.message("budget_limit").content, /^\[goal: budget-limit\]/);
  goal.resume();
  assert.equal(goal.goal?.status, "budget_limited", "a spent budget stays limited");
  assert.equal(entries.at(-1)?.customType, GOAL_ENTRY);
});

test("/goal sets, pauses, resumes and clears, and continuation counts up", () => {
  const { pi } = fakePi();
  const goal = new GoalState(pi);
  assert.match(goal.command("--budget 2,000 finish the migration"), /Goal active, 0 of 2000 tokens/);
  const next = goal.continuation();
  assert.match(next.content, /^\[goal: continuation\]\n\nContinue working toward the active thread goal/);
  assert.match(next.content, /<objective>\nfinish the migration\n<\/objective>/);
  assert.equal(goal.goal?.continuations_used, 1);
  goal.command("pause");
  assert.equal(goal.active, false);
  goal.command("resume");
  assert.equal(goal.active, true);
  assert.equal(goal.terminal({ stopReason: "error", errorMessage: "provider down" }), true);
  assert.equal(goal.goal?.status, "error");
  assert.equal(goal.command("clear"), "Goal cleared.");
  assert.equal((goal.view() as { goal: unknown }).goal, null);
  const done = (goal.create({ objective: "short one" }), goal.complete()) as { goal: { status: string } };
  assert.equal(done.goal.status, "complete");
});
