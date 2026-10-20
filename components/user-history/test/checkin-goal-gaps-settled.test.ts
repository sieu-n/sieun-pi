// frontend bro 10-20: the Chat system check (d9) read its check-in red for 26 runs. A goal that waits only on the owner, through an open For you
// todo or a step his correction parks, is settled by the board rule (c64 and the board skill's check-ins reference), so goal_gaps must not count
// it, while an off-pace goal and a goal whose step has no live job still count. p62 kept no number on purpose, because with one its c40-parked
// steps p52 and p31 read as a goal no live job owns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalLine, goalPushes, pushNeeded } from "../src/checkin-goals.ts";
import { classifyBoard, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-20T00:30:00Z");
const hourAgo = now - 60 * 60_000;
const measured = "2026-10-20T00:20:00Z";
const target = (metric: string, current: number) => ({ metric, target: 5, unit: "parts", current, measuredAt: measured, source: "a walk" });
const goal = (id: string, text: string, current: number, children: PlanItem[]): PlanItem => ({ id, text, status: "doing", children, target: target(text, current) });

const todoGoal = goal("p10", "Campaigns parts ready for your check", 4, [
  { id: "p11", text: "You check Campaigns on 5180 and say if it's good", status: "blocked", children: [] }]);
const parkedGoal = goal("p20", "Picked Staging versions in the real app", 0, [
  { id: "p21", text: "Ship the held bug fixes", status: "blocked", waitFor: "your go on 5180", children: [],
    note: "Done when the owner says 5180 is good enough. Parked by owner correction c40, with no job and no For you todo until then." }]);
const liveGoal = goal("p30", "Prod search filters that find creators", 2, [
  { id: "p31", text: "Push the search filters to target", status: "doing", job: "search push", duty: "checkin/goal_gaps", children: [] }]);
const stalledGoal = goal("p40", "Onboarding pages finished in light and dark", 1, [
  { id: "p41", text: "Finish the last onboarding pages", status: "doing", job: "onboarding build", children: [] }]);

const t1: OwnerTodo = { id: "t1", text: "Campaigns on 5180 is ready for your check.", done: false, from: "agent", at: measured, step: "p11" };
const board = (todos: OwnerTodo[] = [t1]) =>
  ({ v: 2, rev: 1, updatedAt: measured, plan: [todoGoal, parkedGoal, liveGoal, stalledGoal], todos }) as unknown as ChatBoard;
const facts: JobFact[] = [
  { key: "sub-search", name: "search push", state: "working", activityAt: now - 60_000 },
  { key: "sub-onboarding", name: "onboarding build", state: "ended", activityAt: now - 5 * 60 * 60_000 },
];
const views = (b: ChatBoard, active: ReadonlySet<string> = new Set(["c40"])) =>
  classifyBoard(b, facts, () => hourAgo, new Set(["frontend bro"]), [], now, active);
const onPace = { p30: { readings: [{ value: 1, at: now - 2 * 60 * 60_000 }], still: 0 } };
const pushes = (b = board(), memos: object = onPace, active?: ReadonlySet<string>) =>
  goalPushes(b, views(b, active), memos as never, 30 * 60_000, now).pushes;
const act = (list: ReturnType<typeof pushes>, id: string) => list.find(push => push.goal.id === id)?.act;
const gaps = (list: ReturnType<typeof pushes>) => list.filter(pushNeeded).map(push => push.goal.id).sort();

test("goal_gaps counts only the goal whose step has no live job, of a todo-held, a parked, a live and a stalled goal", () => {
  const list = pushes();
  assert.equal(act(list, "p10"), "owner");
  assert.equal(act(list, "p20"), "owner");
  assert.equal(act(list, "p30"), "on_pace");
  assert.equal(act(list, "p40"), "start");
  assert.deepEqual(gaps(list), ["p40"]);
});

test("a goal parked by a correction says so, and counts again once the correction is retired", () => {
  const parked = pushes().find(push => push.goal.id === "p20")!;
  assert.match(goalLine(parked), /moves on the owner's word on p21 \(parked by c40\)/);
  assert.equal(act(pushes(board(), onPace, new Set(["c12"])), "p20"), "start");
});

test("a goal whose For you todo is answered counts again", () => {
  assert.equal(act(pushes(board([{ ...t1, done: true }])), "p10"), "start");
});

test("a live job does not settle an off-pace goal: its number has to move (board skill, check-ins item 10)", () => {
  const still = { p30: { readings: [{ value: 2, at: now - 3 * 60 * 60_000 }, { value: 2, at: now - 2 * 60 * 60_000 }], still: 2 } };
  const list = pushes(board(), still);
  assert.equal(act(list, "p30"), "steer");
  assert.deepEqual(gaps(list), ["p30", "p40"]);
});
