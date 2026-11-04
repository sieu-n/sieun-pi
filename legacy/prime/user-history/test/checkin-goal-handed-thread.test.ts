// Prospect feature bro on 11-05: its goal p307 and the goal's push step p308 named the live ops guy thread as job and session, and that thread
// had fixed 2,099 of 5,316 staging blanks by 04:46 KST. goal_gaps and extra_goals still read p307 "no live job owns it" in 4 check-ins in a
// row, because a goal's owner came only from the chat's own jobs, and the 04:21 KST check-in started a duplicate job, "blank creators fill".
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { goalGap, type GoalPush, pushNeeded } from "../src/checkin-goals.ts";
import { extraGoals } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const NOW = Date.parse("2026-11-04T20:21:00Z");
const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-11-04T20:15:00Z", todos: [], plan: [{
  id: "p307", text: "Fill in creators left blank because their first metrics read failed", status: "doing", job: OPS, sessionId: OPS,
  target: { metric: "prod Instagram creators with no followers shown", target: 0, unit: "creators", current: 1288, measuredAt: "2026-11-04T17:30:00.000Z", direction: "down" },
  children: [{ id: "p308", text: "Push p307 to 0 blank creators: staging fill", status: "doing", job: OPS, sessionId: OPS, duty: "checkin/goal_gaps", children: [] }] }] } as unknown as ChatBoard);
const ops = (state: JobFact["state"], wake?: string): JobFact => ({ key: `thread:${OPS}`, sessionId: OPS, name: "ops guy (+observability)", state, chat: true,
  activityAt: NOW - 60_000, ...wake ? { wake } : {} });
const memo = { readings: [{ value: 1288, at: Date.parse("2026-11-04T16:30:00Z") }, { value: 1288, at: Date.parse("2026-11-04T17:30:00Z") }], still: 2 };
const p307 = (facts: JobFact[]): GoalPush =>
  checkInPrecheck({ at: NOW - 3_600_000, steps: {}, goals: { p307: memo } } as never, facts, board(), NOW, { jobs: [] }).goals.find(push => push.goal.id === "p307")!;
const crowd = (push: GoalPush): GoalPush[] => [push, ...Array.from({ length: 7 }, (_, n) => ({ ...push, goal: { ...push.goal, id: `g${n}` }, act: "on_pace" as const }))];

test("another chat's live thread that owns a goal's push step owns the goal: no goal_gaps, no extra_goals, no steer", () => {
  const push = p307([ops("working", "a board.wake on a check by 05:30Z")]);
  assert.equal(push.act, "waiting", `p307 read ${push.act}`);
  assert.equal(pushNeeded(push), false);
  assert.equal(goalGap(push), false);
  assert.equal(push.owner, undefined, "the ops guy thread is no job of this chat, so the check-in steers nothing into it");
  assert.match(push.waits ?? "", /ops guy \(\+observability\) thread of another chat, which owns p308/);
  assert.deepEqual(extraGoals(crowd(push)).map(entry => entry.goal.id), []);
});

test("a stopped or archived thread on the push step still leaves the goal with no live owner", () => {
  const push = p307([ops("ended")]);
  assert.equal(push.act, "start");
  assert.equal(goalGap(push), true);
  assert.deepEqual(extraGoals(crowd(push)).map(entry => entry.goal.id), ["p307"]);
  assert.equal(p307([]).act, "start", "a thread no row lists anymore owns nothing");
});
