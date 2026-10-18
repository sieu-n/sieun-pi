import assert from "node:assert/strict";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import type { CiRun } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { applyBoardOp, targetMet, targetOp, targetText } from "../src/shared/chat-board.ts";
import type { ChatBoard, GoalTarget, PlanItem, SessionRow } from "../src/shared/types.ts";

/**
 * The AI harness chat (01a1164b), 10-17 23:10Z to 10-18 00:30Z, while the owner's migration focus pause stopped every chat but frontend bro.
 * p453 "duties green" waited on For you t51 through its push step p530 while p523 and p528 under it were live, and goal_gaps flagged it 27
 * times in a row; the old job "checkin pushes goals" owned steps that all waited on t51, and held_elsewhere told p200's two wiki threads to
 * finish steps that waited on t51 too.
 */
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const NOW = Date.parse("2026-10-18T00:00:38Z");
const MIN = 60_000;
const EVERY = 15 * MIN;
const iso = (at: number) => new Date(at).toISOString();
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const row = (id: string, name: string): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none" } as SessionRow);
const T51 = "The owner answers t51 and lifts the migration focus pause (mvd017n9); then restart checkin pushes goals";
const t51 = { id: "t51", text: "Lift the migration focus pause for this chat's own check-in and wiki work?", from: "agent" as const, done: false, at: iso(NOW - 60 * MIN) };
const duties = (children: PlanItem[], extra: Partial<PlanItem> = {}): PlanItem => step("p453", "Every duty in every chat is green", "doing", {
  target: { metric: "duties green", target: 100, unit: "%", current: 35.2, measuredAt: iso(NOW - 62 * MIN), source: "duty-fleet.ts" },
  children: [step("p454", "The duty system holds each duty to a few readable metrics", "done"), ...children], ...extra });
const live = step("p528", "Clean minutes reach 30 of 30", "doing", { job: "clean minutes 10-18" });
const p530 = (extra: Partial<PlanItem> = {}): PlanItem => step("p530", "Open goals off pace reach 0", "doing", { job: "checkin pushes goals", duty: "checkin/goal_gaps", ...extra });
const boardOf = (plan: PlanItem[], todos = [t51]): ChatBoard => ({ v: 2, rev: 1, updatedAt: iso(NOW - 120 * MIN), plan, todos });
const cleanJob: JobFact = { key: "c1", name: "clean minutes 10-18", state: "working", activityAt: NOW };
const oldJob: JobFact = { key: "c2", name: "checkin pushes goals", state: "ended", activityAt: NOW - 180 * MIN };
const gaps = (board: ChatBoard, facts: JobFact[], context: Parameters<typeof checkInPrecheck>[4] = {}) => {
  const precheck = checkInPrecheck(undefined, facts, board, NOW, { everyMs: EVERY, self: [CHAT], ...context });
  return { precheck, goalGaps: convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, NOW).metrics.goal_gaps };
};

test("a goal whose push step waits on an open For you todo is owner-held, whatever its other steps do (AI harness p453, 27 flags in a row)", () => {
  const { precheck, goalGaps } = gaps(boardOf([duties([live, p530({ waitFor: T51 })])]), [cleanJob, oldJob]);
  assert.equal(precheck.goals[0]!.act, "owner");
  assert.deepEqual(precheck.goals[0]!.asks, ["p530"]);
  assert.equal(goalGaps, 0);
  // Once the owner answers t51, the same goal is the chat's to push again: its push step has no live job.
  const answered = gaps(boardOf([duties([live, p530({ waitFor: T51 })])], [{ ...t51, done: true }]), [cleanJob, oldJob]);
  assert.equal(answered.precheck.goals[0]!.act, "start");
  assert.equal(answered.goalGaps, 1);
});

test("a goal whose own wait names an open todo is owner-held, and a waitUntil ahead or the owner's pause of its push thread makes it wait", () => {
  const own = gaps(boardOf([duties([live, p530()], { waitFor: "t51" })]), [cleanJob, oldJob]);
  assert.deepEqual([own.precheck.goals[0]!.act, own.precheck.goals[0]!.asks, own.goalGaps], ["owner", ["p453"], 0]);
  const later = gaps(boardOf([duties([live, p530({ waitUntil: iso(NOW + 30 * MIN) })])], []), [cleanJob, oldJob]);
  assert.deepEqual([later.precheck.goals[0]!.act, later.precheck.goals[0]!.waits, later.goalGaps], ["waiting", "until 10-18 00:30Z", 0]);
  const crawler = "01a115e2-9544-7204-b8db-8ce4d5319048";
  const thread: JobFact = { key: `thread:${crawler}`, name: "Crawler VP", state: "ended", activityAt: NOW - 70 * MIN };
  const board = boardOf([duties([live, p530({ job: `thread:${crawler}`, sessionId: crawler })])], []);
  const paused = gaps(board, [cleanJob, thread], { rows: [row(crawler, "Crawler VP")], paused: new Set([crawler]) });
  assert.deepEqual([paused.precheck.goals[0]!.act, paused.goalGaps], ["waiting", 0]);
  assert.equal(gaps(board, [cleanJob, thread], { rows: [row(crawler, "Crawler VP")] }).goalGaps, 1, "without the pause the goal has no live owner");
});

test("the check-in pushes no job whose every open step the owner holds, and no thread of a chat he paused", () => {
  const previous: CheckInMemory = { at: NOW - EVERY, steps: {}, jobs: { c2: { mark: NOW - 180 * MIN, since: NOW - 180 * MIN }, [`thread:${"01a14b75-84d5-74cc-9f26-cfe5ddbf8741"}`]: { mark: NOW - 180 * MIN, since: NOW - 180 * MIN } } };
  const held = (todos = [t51]) => checkInPrecheck(previous, [{ ...oldJob, state: "working" }], boardOf([duties([p530({ waitFor: T51 }), step("p470", "duties_green_pct 100", "doing", { job: "checkin pushes goals", waitFor: T51 })])], todos), NOW, { everyMs: EVERY }).jobs;
  assert.deepEqual(held(), []);
  assert.deepEqual(held([]).map(push => [push.fact.name, push.act]), [["checkin pushes goals", "restart"]], "with t51 answered the idle job is restarted");
  const wiki = "01a14b75-84d5-74cc-9f26-cfe5ddbf8741";
  const thread: JobFact = { key: `thread:${wiki}`, name: "fix wiki dream page pairs 10-18", state: "ended", activityAt: NOW - 180 * MIN };
  const board = boardOf([step("p534", "Unjudged page pairs stay at 0", "doing", { job: `thread:${wiki}`, sessionId: wiki })], []);
  const pushes = (paused?: Set<string>) => checkInPrecheck(previous, [thread], board, NOW, { everyMs: EVERY, jobs: [wiki], ...(paused ? { paused } : {}) }).jobs.map(push => push.fact.name);
  assert.deepEqual(pushes(new Set([wiki])), []);
  assert.deepEqual(pushes(), ["fix wiki dream page pairs 10-18"]);
});

test("held_elsewhere never hands a goal to a thread whose step waits on an open todo or whose chat the owner paused (p200, 10-18 00:00Z)", () => {
  const wiki = "01a14b75-84d5-74cc-9f26-cfe5ddbf8741";
  const thread: JobFact = { key: `thread:${wiki}`, name: "fix wiki dream page pairs 10-18", state: "ended", activityAt: NOW - 30 * MIN };
  const goal = (waitFor?: string) => step("p200", "llm-wiki is reliable and every page reads like a plain blog post", "doing", { children: [
    step("p533", "Wiki dream precheck reads 0", "done"),
    step("p534", "Unjudged page pairs stay at 0", "doing", { job: `thread:${wiki}`, sessionId: wiki, ...(waitFor ? { waitFor } : {}) })] });
  const held = (board: ChatBoard, paused?: Set<string>) => checkInPrecheck(undefined, [thread], board, NOW,
    { everyMs: EVERY, self: [CHAT], rows: [row(wiki, "fix wiki dream page pairs 10-18")], ...(paused ? { paused } : {}) }).held.map(entry => entry.goal.id);
  assert.deepEqual(held(boardOf([goal(T51)])), []);
  assert.deepEqual(held(boardOf([goal()], []), new Set([wiki])), []);
  assert.deepEqual(held(boardOf([goal()], [])), ["p200"]);
  const asleep = { ...thread, state: "working" as const, wake: "run 39081582639" };
  assert.deepEqual(checkInPrecheck(undefined, [asleep], boardOf([goal("verify-dev run 39081582639")], []), NOW,
    { everyMs: EVERY, self: [CHAT], rows: [row(wiki, "fix wiki dream page pairs 10-18")] }).held.map(entry => entry.goal.id), [], "a thread asleep on its own CI run moves the step");
});

test("a goal reading older than the one on the board never replaces it, and a target given with no measurement keeps it (p453, 10-17 22:27Z)", () => {
  const newer: GoalTarget = { metric: "duties green", target: 100, unit: "%", current: 31.5, measuredAt: "2026-10-17T22:27:00.000Z", source: "duty-fleet.ts" };
  const board = boardOf([duties([], { target: newer })], []);
  const apply = (target: GoalTarget) => applyBoardOp(board, { op: "plan_update", id: "p453", target }, "agent", iso(NOW), kind => `${kind}9`).board.plan[0]!.target;
  assert.deepEqual(apply({ ...newer, current: 29.7, measuredAt: "2026-10-17T21:31:00.000Z", source: "the check-in's precheck" }), newer);
  assert.deepEqual(apply({ metric: "duties green", target: 100, unit: "%" }), newer);
  const later = { ...newer, current: 35.2, measuredAt: "2026-10-17T22:58:00.000Z" };
  assert.deepEqual(apply(later), later);
});

test("a target of 0 and a lower-is-better metric named with underscores read as not met above it (p529 stuck_steps_all 6 of target 0)", () => {
  const p529: GoalTarget = { metric: "stuck_steps_all", target: 0, unit: "steps", current: 6, measuredAt: "2026-10-17T23:39:22.000Z", source: "d7" };
  assert.equal(targetOp(p529), "<=");
  assert.equal(targetMet(p529), false);
  assert.equal(targetText(p529), "6 / 0 steps (0%)");
  assert.equal(targetOp({ metric: "job_start_wait_p90", target: 10 }), "<=");
  assert.equal(targetOp({ metric: "duties green", target: 100 }), ">=");
});

test("a step whose wait names a CI run still queued, with a live-able owner, is moving (frontend bro p160 and p174, 10-18 00:09Z)", () => {
  const owner: JobFact = { key: "thread:01a14c02-b593-70aa-b656-bf01fcedc020", name: "5180 kill guard landing", state: "ended", activityAt: NOW - 20 * MIN };
  const p160 = step("p160", "Nothing kills the 5180 dev server between config edits", "doing", { job: "thread:01a14c02-b593-70aa-b656-bf01fcedc020", waitFor: "verify-dev run 39080012885" });
  const runs = new Map<string, CiRun>([["39080012885", { id: "39080012885", running: true, conclusion: null, updatedAt: NOW - 5 * MIN }]]);
  const view = { item: p160, owner, mine: false, cls: "waiting" as const, changedAt: NOW - 180 * MIN, goal: undefined };
  const state = (movers: Parameters<typeof endState>[6]) => endState(view as never, [], [], new Set([CHAT]), NOW, [], movers).state;
  assert.equal(state({ runs }), "moving");
  assert.equal(state({}), "ci");
  assert.equal(state({ runs: new Map([["39080012885", { ...runs.get("39080012885")!, running: false, conclusion: "success" }]]) }), "ci");
});
