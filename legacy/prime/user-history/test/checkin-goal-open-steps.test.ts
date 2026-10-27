// frontend bro 10-20 05:50Z: the check-in said "3 goals meet their target" and told the chat to close p62, p208 and p272. p208 (5 of 5 pages)
// and p272 (4 of 4 parts) each had one open step, p286 and p297, waiting on the owner's check on For you t39 and t40, and p62 has no target: it
// read d1/ssr_timeouts_24h 0 from p143, a done step under its dropped p142, while p52 waited on the owner's word. A goal with an open step is
// not finished, and a goal with no target reads only the duty metric it links itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrompt } from "../src/chat-checkin.ts";
import type { MetricFact } from "../src/checkin-done.ts";
import { goalNumber, goalPromptLine, goalPushes } from "../src/checkin-goals.ts";
import { classifyBoard } from "../src/checkin-steps.ts";
import { GOAL_PUSH_LINK } from "../src/shared/chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-20T05:50:00Z");
const every = 30 * 60_000;
const item = (id: string, fields: Partial<PlanItem> = {}): PlanItem => ({ id, text: `Work on ${id}`, status: "doing", children: [], ...fields });
const pages = { metric: "Onboarding pages finished, of 5", target: 5, unit: "pages", current: 5, measuredAt: "2026-10-19T19:48:00Z", source: "a walk", direction: "up" as const };
const todo = (id: string, step: string): OwnerTodo => ({ id, text: `Check ${step} on 5180`, done: false, from: "agent", at: "2026-10-19T20:00:00Z", step }) as OwnerTodo;
const ssr = new Map<string, MetricFact>([["d1/ssr_timeouts_24h", { met: true, at: now - 60 * 60_000, value: 0, target: 0, op: "<=" }]]);

const pushes = (plan: PlanItem[], todos: OwnerTodo[]) => {
  const board = { v: 2, rev: 1, updatedAt: "2026-10-20T05:00:00Z", plan, todos } as unknown as ChatBoard;
  const views = classifyBoard(board, [], () => now - 60 * 60_000, new Set(["frontend bro"]), [], now, new Set());
  return goalPushes(board, views, undefined, every, now, ssr).pushes;
};
const closeAsk = (plan: PlanItem[], todos: OwnerTodo[]) => /meets? (?:its|their) target/.test(checkInPrompt({ goals: pushes(plan, todos), end: [], risks: [] }, null));

test("a met goal whose only open step waits on a For you todo gets no close ask, and its line names the wait", () => {
  const plan = [item("p208", { status: "todo", target: pages, children: [item("p268", { status: "done" }), item("p286", { status: "blocked", text: "You check onboarding on 5180" })] })];
  assert.equal(closeAsk(plan, [todo("t39", "p286")]), false);
  const line = goalPromptLine(pushes(plan, [todo("t39", "p286")])[0]!);
  assert.match(line, /at target, and it stays open for p286, which waits on the owner's word/);
});

test("a met goal whose only open step is its push step still gets the close ask", () => {
  const plan = [item("p208", { target: pages, children: [item("p300", { duty: GOAL_PUSH_LINK }), item("p286", { status: "done" })] })];
  assert.equal(closeAsk(plan, []), true);
});

test("a goal with no target reads no metric of a step under it, and waits on the owner's word instead of asking for a target", () => {
  const p62 = item("p62", { children: [item("p52", { status: "blocked", waitFor: "your go on 5180" }),
    item("p142", { status: "dropped", children: [item("p143", { status: "done", duty: "d1/ssr_timeouts_24h" })] })] });
  assert.equal(goalNumber(p62, every, ssr), undefined);
  const [push] = pushes([p62], [todo("t8", "p52")]);
  assert.equal(push!.act, "owner");
  assert.equal(closeAsk([p62], [todo("t8", "p52")]), false);
  assert.equal(goalNumber(item("p151", { duty: "d1/ssr_timeouts_24h" }), every, ssr)?.value, 0);
});
