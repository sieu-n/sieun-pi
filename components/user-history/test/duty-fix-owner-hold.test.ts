// AI harness 10-23: every d5 run told its job to start a fix job on p919, and d9's 04:07Z push told the chat to replace p919's fix, while
// p919 waited only on the owner's Apple sign-in, Railway Breach's open For you t11, and owner_fixes' step on the same todo. A red duty whose
// fix steps an open todo holds by an explicit link waits on the owner: no new job, no stuck duty, no fix_not_moving.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, type RedDuty } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { missLine } from "../src/chat-duty-job.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import { dutyFixes } from "../src/shared/duty-fixes.ts";
import type { MetricStreak } from "../src/shared/duty-streak.ts";
import { dutyHold, holdingTodo, todoName, withLinkedBoards } from "../src/shared/todo-hold.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const BREACH = "01a16213-54c6-73fa-b399-20e2713c41ba";
const WAIT = `thread:${BREACH} t11`;
const at = (clock: string) => Date.parse(`2026-10-23T${clock}Z`);
const off = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const p919: PlanItem = { id: "p919", text: "Codex account fhnyq29tw5 is signed back into the account pool", status: "blocked", children: [],
  duty: "d5/skills_or_tools_to_fix", job: "codex fhnyq29tw5 sign-in", waitFor: WAIT };
const p947: PlanItem = { id: "p947", text: "The owner signs fhnyq29tw5 back in", status: "blocked", children: [], duty: "d5/owner_fixes", waitFor: WAIT };
const signIn = (done: boolean): OwnerTodo => ({ id: "t11", text: "Sign fhnyq29tw5 back in with Apple", done, from: "agent", at: "2026-10-22T10:13:13Z" });
const ownT11: OwnerTodo = { id: "t11", text: "Delete the old Slack app?", done: true, from: "agent", at: "2026-10-08T07:46:05Z", reply: "just delete now" };
const board = (plan: PlanItem[], todos: OwnerTodo[] = [ownT11]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-23T03:00:00Z", plan, todos });
const breach = (done: boolean): ChatBoard => board([], [signIn(done)]);
const linked = (plan: PlanItem[], done = false, todos?: OwnerTodo[]) => withLinkedBoards(board(plan, todos), HARNESS, new Map([[BREACH, breach(done)]]));

test("the duty run's fix link carries the todo that holds its open fix step", async () => {
  const todos = linked([p919]).todos;
  const held = (item: PlanItem) => { const todo = holdingTodo(item, todos); return todo && todoName(todo); };
  const fixes = await dutyFixes(board([p919]), "d5", ["skills_or_tools_to_fix"], async () => false, [], undefined, held);
  assert.deepEqual(fixes.skills_or_tools_to_fix, { step: "p919", job: "codex fhnyq29tw5 sign-in", live: false, hold: `t11 on thread ${BREACH}` });
  const live = await dutyFixes(board([p919]), "d5", ["skills_or_tools_to_fix"], async () => true, [], undefined, held);
  assert.equal(live.skills_or_tools_to_fix?.live, true, "a live fix job is steered as before");
});

test("a held fix step asks for no job, stuck or not", () => {
  const streak: MetricStreak = { key: "skills_or_tools_to_fix", misses: 5, moved: false, since: at("00:00:00"), value: 1, target: 0, op: "<=", stuck: true,
    fix: { step: "p919", job: "codex fhnyq29tw5 sign-in", live: false, hold: `t11 on thread ${BREACH}` } };
  const line = missLine("d5", streak, "Skills or tools to fix");
  assert.match(line, new RegExp(`p919 waits on the owner's open For you todo t11 on thread ${BREACH}`));
  assert.match(line, /Start no job/);
  assert.doesNotMatch(line, /rlm\.create_session|Change approach/);
});

test("a duty is held only while every missed metric's open fix step waits on an open todo by an explicit link", () => {
  const keys = ["skills_or_tools_to_fix", "owner_fixes"];
  assert.equal(dutyHold("d5", keys, linked([p919, p947])), `p919 on t11 on thread ${BREACH}, p947 on t11 on thread ${BREACH}`);
  assert.equal(dutyHold("d5", keys, linked([p919])), undefined, "owner_fixes has no held step");
  assert.equal(dutyHold("d5", keys, linked([p919, p947], true)), undefined, "the other thread's todo is done");
  assert.equal(dutyHold("d5", keys, linked([p919, p947], true, [{ ...ownT11, done: false }])), undefined, "this chat's own t11 holds no wait on Breach's t11");
  assert.equal(dutyHold("d5", keys, linked([p919, { ...p947, waitFor: "the owner's Apple sign-in on Breach" }])), undefined, "a shared word is no link (c88)");
});

test("d9 counts a held red duty in neither stuck_duties nor fix_not_moving", () => {
  const runs: DutyRunRecord[] = [{ duty: "d5", at: at("03:37:00"), trigger: "schedule", ms: 1, verdict: "missed", summary: "",
    metrics: { skills_or_tools_to_fix: off(1), owner_fixes: off(1) } }];
  const inputs = (plan: PlanItem[], done: boolean) => ({ now: at("04:07:00"), chats: [{ id: HARNESS, name: "AI harness developer environment VP", runs,
    duties: [{ id: "d5", name: "Skills and tools" }], paused: false, everyMs: 120 * 60_000 }],
    boards: new Map([[HARNESS, board(plan)], [BREACH, breach(done)]]), ownerActivity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(),
    named: new Map() }) as unknown as PlanInputs;
  assert.equal(planCounts(inputs([p919, p947], false)).redDuties.length, 0);
  assert.equal(planCounts(inputs([p919, p947], true)).redDuties.length, 1);
  const metric: MetricStreak = { key: "skills_or_tools_to_fix", misses: 5, moved: false, since: at("00:00:00"), value: 1, target: 0, op: "<=", stuck: true,
    fix: { step: "p919", job: "codex fhnyq29tw5 sign-in", live: true } };
  const red: RedDuty = { chat: HARNESS, duty: "d5", name: "Skills and tools", green: false, misses: 5, stuck: false, metric, fix: "p919",
    underFix: { misses: 5, moved: false } };
  assert.equal(fixNotMoving([red], () => "AI harness").length, 1);
  assert.equal(fixNotMoving([{ ...red, held: `p919 on t11 on thread ${BREACH}` }], () => "AI harness").length, 0);
});
