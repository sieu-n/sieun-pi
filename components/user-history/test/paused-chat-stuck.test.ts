// Guards d9's stuck_steps_all in a chat whose check-in the owner paused: on 10-24 it read 0 while ops guy's p506 named a job unloaded 23 h before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyHosts, type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
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

// 10-24 10:03Z: d9 counted frontend bro's p330 and p332, whose jobs sat on the Mac while Tailscale read it offline and For you t30 asked the owner
// to bring it back, while the paused-chat path never asked where a step's owner runs.
const FRONT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const macBoard = { v: 2, rev: 1, updatedAt: "2026-10-24T08:00:00Z", todos: [], plan: [
  { id: "p300", text: "Demo work reaches staging", status: "doing", children: [
    { id: "p330", text: "5180 builds from the newest real app", status: "doing", job: "demo pin past list drop", sessionId: "s-mac", children: [] },
    { id: "p332", text: "Your Mac branch's demo work reaches staging again", status: "doing", job: "mac branch pusher", sessionId: "s-unlisted", children: [] },
    { id: "p309", text: "A prod release no longer takes search down", status: "doing", job: "schema promotes keep serving", sessionId: "s-metal", children: [] },
    { id: "p340", text: "Read the demo log", status: "doing", children: [] }] }] } as unknown as ChatBoard;
const macPlan = (holds: Map<string, { host: string; todo: string }>): PlanInputs => ({ now, boards: new Map([[FRONT, macBoard]]), poolWaiting: new Set<string>(), waking: new Set<string>(),
  named: new Map([[FRONT, new Map([["mac branch pusher", ["s-mac-2"]]])]]), ownerActivity: new Map([["s-mac", now - 5 * 3_600_000], ["s-metal", now - 3 * 3_600_000]]),
  hosts: new Map([[FRONT, "mac"], ["s-mac", "mac"], ["s-mac-2", "mac"], ["s-metal", "us-metal02"]]), away: new Set(holds.keys()), holds,
  chats: [{ id: FRONT, name: "frontend bro", runs: [], everyMs: 7_200_000, paused: true, duties: [] }] }) as unknown as PlanInputs;

test("a paused chat's step whose owners all run on an offline box a For you todo asks back waits on the owner, and one on a reachable box counts", () => {
  const counts = planCounts(macPlan(new Map([["mac", { host: "mac", todo: "t30" }]])));
  assert.deepEqual(counts.stuck.flatMap(entry => entry.items), ["p309"]);
  assert.deepEqual(counts.hostHeld.map(step => [step.chat.id, step.id, step.host, step.todo]), [[FRONT, "p330", "mac", "t30"], [FRONT, "p332", "mac", "t30"], [FRONT, "p340", "mac", "t30"]]);
});

test("a paused chat's steps on an offline box count as stuck while no For you todo asks the owner to bring it back", () => {
  const counts = planCounts(macPlan(new Map()));
  assert.deepEqual(counts.stuck.flatMap(entry => entry.items), ["p330", "p332", "p309", "p340"]);
  assert.deepEqual(counts.hostHeld, []);
});

test("a session both boxes' copies list runs on this box", () => {
  const hosts = copyHosts([{ host: "mac", rows: [{ sessionId: "s-both" }, { sessionId: "s-mac" }] }, { host: null, rows: [{ sessionId: "s-both" }, { sessionId: "s-metal" }] }], "us-metal02");
  assert.deepEqual([...hosts].sort(), [["s-both", "us-metal02"], ["s-mac", "mac"], ["s-metal", "us-metal02"]]);
});
