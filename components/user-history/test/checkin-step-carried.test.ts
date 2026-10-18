import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * AI harness, 10-18 03:26Z (12:26 KST): p566 under p453 was blocked, waiting for "The chats move to us-metal02 (p565)", and p565's five steps
 * had live jobs. The check-in read p566 stuck and p453 as a goal gap with no live owner, and started "duties green push 10-18" on p563 and p566.
 */
const NOW = Date.parse("2026-10-18T03:26:00Z");
const MIN = 60_000;
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const job = (key: string, name: string): JobFact => ({ key, name, state: "working", activityAt: NOW - MIN });
const board = (p566Wait: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: new Date(NOW - 60 * MIN).toISOString(), todos: [], plan: [
  step("p453", "Every duty in every chat is green", "doing", {
    target: { metric: "duties green", target: 100, unit: "%", current: 36.3, measuredAt: new Date(NOW - 30 * MIN).toISOString(), source: "duty-fleet.ts" },
    children: [
      step("p470", "Every duty meets every target", "doing", { job: "checkin pushes goals" }),
      step("p563", "Push duties green toward 100%", "doing", { job: "duties green push 10-18", duty: "checkin/goal_gaps" }),
      step("p566", "The Mac stays usable every minute", "blocked", { waitFor: p566Wait }),
    ] }),
  step("p524", "Every box is set up the same", "doing", { children: [
    step("p565", "Chats run on us-metal02 through one chat app", "doing", { children: [
      step("p568", "Daemon relay", "doing", { job: "mvp daemon relay" }),
      step("p569", "Chat server on box", "doing", { job: "mvp chat server on box" }),
    ] }),
  ] }),
] });
const facts = [job("c1", "checkin pushes goals"), job("c2", "mvp daemon relay"), job("c3", "mvp chat server on box")];
const run = (wait: string) => {
  const precheck = checkInPrecheck(undefined, facts, board(wait), NOW, { everyMs: 15 * MIN, self: ["chat"] });
  return { precheck, output: convergenceMisses("chat", precheck.steps, precheck, {}, 15 * MIN, NOW) };
};

test("a step blocked on another step that live jobs carry is moving, and its goal waits instead of asking for a push job (AI harness p566 on p565)", () => {
  const { precheck, output } = run("The chats move to us-metal02 (p565), so the Mac's Prime workers leave it");
  const p566 = precheck.end.find(entry => entry.view.item.id === "p566")!;
  assert.equal(p566.state, "moving");
  assert.match(p566.reason, /its wait is on p565, which 2 live jobs carry/);
  const p453 = precheck.goals.find(push => push.goal.id === "p453")!;
  assert.equal(p453.act, "waiting");
  assert.equal(p453.waits, "on p565, which 2 live jobs carry");
  assert.equal(output.metrics.goal_gaps, 0);
  assert.ok(!output.flagged.some(slice => slice.item === "p566"), "p566 gets no stuck or orphan line");
});

test("a wait on a step no live job carries stays stuck, and the goal still asks for a push", () => {
  const { precheck, output } = run("p999 lands");
  assert.notEqual(precheck.end.find(entry => entry.view.item.id === "p566")!.state, "moving");
  assert.equal(precheck.goals.find(push => push.goal.id === "p453")!.act, "start");
  assert.equal(output.metrics.goal_gaps, 1);
});
