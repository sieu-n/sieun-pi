// Guards d9's stuck_steps_all in a chat whose check-in the owner paused: on 10-24 it read 0 while ops guy's p506 named a job unloaded 23 h before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, pushList } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const now = Date.parse("2026-10-24T08:49:00Z");
const board = { v: 2, rev: 1, updatedAt: "2026-10-24T08:00:00Z", todos: [
  { id: "t9", text: "Pick the seed source", done: false, step: "p510", from: "agent", at: "2026-10-23T09:00:00Z" }], plan: [
  { id: "p500", text: "5180 on the Mac answers 200", status: "doing", children: [
    { id: "p506", text: ":5180 on the Mac answers 500", status: "doing", job: "demo 5180 seed fix", sessionId: "s-unloaded", children: [] },
    { id: "p507", text: "Seed the demo data", status: "doing", job: "demo seed", sessionId: "s-waking", children: [] },
    { id: "p508", text: "Read the demo log", status: "doing", job: "demo log", sessionId: "s-fresh", children: [] },
    { id: "p509", text: "Fix the real app", status: "blocked", note: "Parked by c40 until the owner says 5180 is good enough", children: [] },
    { id: "p510", text: "Seed from the source the owner picks", status: "blocked", children: [] },
    { id: "p511", text: "Old check", status: "done", children: [] }] }] } as unknown as ChatBoard;

const plan = (paused: boolean): PlanInputs => ({ now, boards: new Map([[OPS, board]]), named: new Map(), poolWaiting: new Set<string>(), waking: new Set(["s-waking"]),
  ownerActivity: new Map([["s-unloaded", Date.parse("2026-10-23T09:35:00Z")], ["s-fresh", now - 10 * 60_000]]),
  chats: [{ id: OPS, name: "ops guy (+observability)", runs: [], everyMs: 7_200_000, paused, duties: [] }] }) as unknown as PlanInputs;

test("a chat whose check-in the owner paused counts its open leaf steps that no owner moves and no todo or correction holds", () => {
  const stuck = planCounts(plan(true)).stuck;
  assert.deepEqual(stuck.map(entry => [entry.chat.id, entry.value, entry.items]), [[OPS, 1, ["p506"]]]);
});

test("a step whose owner wrote over the live window ago counts, and one under it does not", () => {
  const input = plan(true);
  const activity = new Map([["s-unloaded", now - 20 * 60_000], ["s-fresh", now - 40 * 60_000]]);
  assert.deepEqual(planCounts({ ...input, ownerActivity: activity }).stuck.flatMap(entry => entry.items), ["p508"]);
});

test("a chat whose check-in runs still counts only from its check-in snapshot", () => {
  assert.deepEqual(planCounts(plan(false)).stuck, []);
});

// 10-24, the AI harness chat on p1004: the owner set those pauses himself and his reason is not on record, so a push must not wake a chat he paused.
test("a paused chat's stuck step counts in stuck_steps_all and reads as in a paused chat, but gets no push", () => {
  const steps = [{ chat: OPS, id: "p506", text: ":5180 on the Mac answers 500", paused: true as const }, { chat: "c2", id: "p9", text: "Fix X" }];
  assert.deepEqual(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], stuck: steps }).map(entry => [entry.chat, entry.steps.map(step => step.id)]), [["c2", ["p9"]]]);
  const out = chatSystemOutput({ names: new Map([[OPS, "ops guy"]]), stuck: steps, upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d9.md" });
  assert.equal(out.metrics.stuck_steps_all, 2);
  assert.match(out.flagged!.find(slice => slice.item === "p506")!.excerpt, /in a paused chat, so push nothing until the owner resumes its check-in\.$/);
});
