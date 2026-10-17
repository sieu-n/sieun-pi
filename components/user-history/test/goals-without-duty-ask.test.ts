import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInDuties, type DutyRef, goalsToFold, goalsWithoutDuty } from "../src/checkin-findings.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";

// 'spec and monitoring system' (01a140fb): goals_without_duty flagged p5 in 14 check-ins in a row while t1, linked to p5, already asked the
// owner on For you from 10-16 04:54Z whether to add the morning report read.
const board = (todoDone: boolean, step = "p5"): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-17T20:11:00.000Z", plan: [
  { id: "p5", text: "Track code health of agent work with a daily git report", status: "todo",
    target: { metric: "Days of the last 7 with a daily code health report for both repos", target: 7, unit: "days", current: 2, measuredAt: "2026-10-17T20:11:00.000Z", source: "report store" },
    children: [{ id: "p6", text: "Build: the daily runner", status: "doing", children: [] }] },
  { id: "p9", text: "Spec the monitoring app", status: "todo", children: [] },
], todos: [{ id: "t1", text: "Want me to read the code health report every morning and push the jobs when a day is missing? The report work goes on either way.",
  done: todoDone, choices: ["Yes, add it", "No"], step, from: "agent", at: "2026-10-16T04:54:08.310Z" }] }) as ChatBoard;

test("goals without duty: a goal For you already asks about, by an open todo linked to it or to its step, is not flagged again (01a140fb p5 and t1)", () => {
  assert.deepEqual(goalsWithoutDuty(board(false), []).map(goal => goal.id), ["p9"], "t1 is the ask for p5");
  assert.deepEqual(goalsWithoutDuty(board(false, "p6"), []).map(goal => goal.id), ["p9"], "a todo linked to a step of p5 asks for p5 too");
  assert.deepEqual(goalsWithoutDuty(board(true), []).map(goal => goal.id), ["p5", "p9"], "an answered todo asks nothing now");
});

// chat-057a (01a14210): goals_without_duty flagged p1 in 14 check-ins in a row, though its note names the AI harness chat's Whole system duty as
// its cover, a choice the chat has kept since 10-16.
const AI_HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const CHAT_057A = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const NOTE = "The existing Whole system duty in the AI harness developer environment chat plus this chat's check-in watch this goal, so the chat adds no " +
  "separate duty and does not ask the owner again (chat decision, kept since 10-16).";
const board057a = (note: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-17T20:00:00.000Z", todos: [], plan: [
  { id: "p1", text: "Keep local agents working and fix recurring failures", status: "doing", note, children: [] }] }) as ChatBoard;
const WHOLE: DutyRef = { id: "d7", name: "Whole system", goal: "Every agent on the Mac works.", status: "active", chat: AI_HARNESS };

test("goals without duty: a goal whose note names another chat's active duty as its cover is not flagged (chat-057a p1 and the Whole system duty)", () => {
  assert.deepEqual(goalsWithoutDuty(board057a(NOTE), [WHOLE]).map(goal => goal.id), [], "the note names the Whole system duty");
  assert.deepEqual(goalsWithoutDuty(board057a('Covered by the duty "Whole system".'), [WHOLE]).map(goal => goal.id), [], "quoted, after the word duty");
  assert.deepEqual(goalsWithoutDuty(board057a(NOTE), []).map(goal => goal.id), ["p1"], "a duty that does not exist covers nothing");
  assert.deepEqual(goalsWithoutDuty(board057a(NOTE), [{ ...WHOLE, status: "paused" }]).map(goal => goal.id), ["p1"], "a paused duty covers nothing");
  assert.deepEqual(goalsWithoutDuty(board057a("Watch the whole system."), [WHOLE]).map(goal => goal.id), ["p1"], "the name alone, without duty, is no cover");
  assert.deepEqual(goalsToFold(board057a(NOTE), [], new Set([CHAT_057A]), [{ ...WHOLE, boardGoal: "p1" }]), [], "nothing folds into another chat's duty");
});

test("checkInDuties: the chat's own duties marked by their runs, then the active duties of the other live chats, marked with their chat", async () => {
  const duty = (id: string, name: string, status: "active" | "paused" = "active") => ({ id, name, goal: name, status } as Duty);
  const files: Record<string, Duty[]> = { [CHAT_057A]: [duty("d1", "Agents answer")], [AI_HARNESS]: [duty("d7", "Whole system"), duty("d8", "Old", "paused")],
    gone: [duty("d1", "Archived chat duty")] };
  const store = { chats: async () => Object.keys(files), list: async (id: string) => files[id] ?? [], runs: async () => [] };
  const read = await checkInDuties(store, CHAT_057A, async id => id !== "gone");
  assert.deepEqual(read.map(item => `${item.id} ${item.name}${"unmeasured" in item && item.unmeasured ? " unmeasured" : ""}${"chat" in item && item.chat ? ` of ${item.chat.slice(0, 8)}` : ""}`),
    ["d1 Agents answer unmeasured", "d7 Whole system of 01a1164b"]);
  assert.deepEqual(goalsWithoutDuty(board057a(NOTE), read), [], "its own active duty covers every goal");
});
