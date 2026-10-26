// AI harness 10-26: d5 missed skills_or_tools_to_fix at 21:49 KST and started fix jobs on p1095 and p1096 (d5/skills_or_tools_to_fix) under
// p700, and the check-in started two more jobs on the same problems 3 min later, one against the d5 job. The check-in input now names the fix
// steps already on a gap, with their job and start, and a start reads the goal on the board first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrompt } from "../src/chat-checkin.ts";
import { goalDueLine, goalPushes } from "../src/checkin-goals.ts";
import { classifyBoard, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-26T13:05:00Z");
const measured = "2026-10-26T12:50:00Z";
const LINK = "d5/skills_or_tools_to_fix";
const fix: PlanItem = { id: "p1096", text: "Skills and tools stops flagging principle-type-system-discipline as unread", status: "doing", job: "d5 type-system skill unread",
  sessionId: "01a1784c-6fa8-75fe-9889-9bc61d0dc19a", duty: LINK, children: [] };
const goal = (children: PlanItem[]): PlanItem => ({ id: "p700", text: "Every host has the skills and tools that make sense for it, and each one works", status: "doing", children,
  target: { metric: "skills and tools to fix on us-metal02", target: 0, unit: "to fix", current: 2, measuredAt: measured, direction: "down",
    source: "duty d5 metric skills_or_tools_to_fix, its run at 2026-10-26T12:50Z" } });
const still = { p700: { readings: [{ value: 2, at: now - 3 * 60 * 60_000 }, { value: 2, at: now - 2 * 60 * 60_000 }], still: 2 } };
const run = (plan: PlanItem[], facts: JobFact[]) => {
  const board = { v: 2, rev: 1, updatedAt: measured, plan, todos: [] } as unknown as ChatBoard;
  const views = classifyBoard(board, facts, () => now - 5 * 60_000, new Set(["AI harness"]), [], now, new Set());
  return goalPushes(board, views, still as never, 60 * 60_000, now).pushes.find(push => push.goal.id === "p700")!;
};
const job = (state: JobFact["state"]): JobFact => ({ key: "sub-d5-type", name: "d5 type-system skill unread", state, activityAt: now - 60_000 });

test("an open step on the goal's duty metric with a working job is listed as the fix in progress, and the check-in steers it", () => {
  const push = run([goal([fix])], [job("working")]);
  const prompt = checkInPrompt({ goals: [push], end: [] }, null);
  assert.match(prompt, /Fix in progress: p1096 \(job d5 type-system skill unread, working, started 10-26 13:00Z\)/);
  assert.notEqual(push.act, "start");
  assert.doesNotMatch(goalDueLine(push) ?? "", /Add a push step|a new one/);
});

test("a fix step on the goal's duty metric outside the goal owns it too", () => {
  const push = run([goal([]), fix], [job("working")]);
  assert.equal(push.owner?.name, "d5 type-system skill unread");
  assert.notEqual(push.act, "start");
  assert.match(checkInPrompt({ goals: [push], end: [] }, null), /Fix in progress: p1096/);
});

test("a fix whose job stopped is listed to restart, and a start with no fix reads the board for one first", () => {
  assert.match(checkInPrompt({ goals: [run([goal([fix])], [job("ended")])], end: [] }, null), /Stopped fix: p1096 \(job d5 type-system skill unread, idle/);
  const bare = run([goal([])], []);
  assert.equal(bare.act, "start");
  assert.equal(bare.fixes, undefined);
  assert.match(goalDueLine(bare) ?? "", /Read board\.get\("p700"\) first: a duty job may have added a fix step since this brief, and when one has a working job, steer that job instead and start none/);
});
