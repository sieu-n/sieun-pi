// chat-057a 10-18: its check-ins added push steps p50, p58, p64 and p67 under p1 "Finish the current agent recovery repairs" (2 of 6 checks)
// while the fix step p60 "Make message sends finish without blocking updates", linked to checkin/goal_gaps, had the job "metal agent runtime".
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalDueLine, goalPushes, goalsDetail, goalsHeadline, unpushed } from "../src/checkin-goals.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-18T16:30:00Z");
const p60: PlanItem = { id: "p60", text: "Make message sends finish without blocking updates", status: "doing", job: "metal agent runtime", duty: "checkin/goal_gaps", children: [] };
const p1: PlanItem = { id: "p1", text: "Finish the current agent recovery repairs", status: "doing", children: [{ id: "p8", text: "Fix slow agent messaging", status: "doing", children: [p60] }],
  target: { metric: "repair checks passing", target: 6, unit: "checks", current: 2, measuredAt: "2026-10-18T16:20:00Z", source: "verification job" } };
const board = { v: 2, rev: 1, updatedAt: "2026-10-18T16:20:00Z", plan: [p1], todos: [] } as unknown as ChatBoard;
const runtime = (state: JobFact["state"]): JobFact => ({ key: "sub-runtime", name: "metal agent runtime", state });
const views = (state: JobFact["state"]): StepView[] => [{ item: p60, owner: runtime(state), mine: false, changedAt: now - 3_600_000, cls: "doing", openTodos: [], goal: { id: "p1", text: p1.text } } as unknown as StepView];
const memo = { p1: { readings: [{ value: 2, at: now - 3_600_000 }, { value: 2, at: now - 600_000 }], still: 2 } };

test("an off-pace goal whose fix step has a live job gets a steer of that job and no new step", () => {
  const [push] = goalPushes(board, views("working"), memo as never, 30 * 60_000, now).pushes;
  assert.equal(push?.act, "steer");
  const line = goalDueLine(push!) ?? "";
  assert.match(line, /^Steer job metal agent runtime/);
  assert.match(line, /add no step/);
  assert.doesNotMatch(line, /Add a push step/);
});

test("when that job is not live, the check-in steers or restarts it on its step instead of adding a push step", () => {
  const [push] = goalPushes(board, views("ended"), memo as never, 30 * 60_000, now).pushes;
  assert.equal(push?.act, "start");
  const line = goalDueLine(push!) ?? "";
  assert.match(line, /^Steer the job metal agent runtime on p60, the push step/);
  assert.match(line, /Add no new step/);
  assert.doesNotMatch(line, /Add a push step/);
});

// From 10-18 17:00Z to 10-19 17:00Z, VP of CI p1 was steered 85 times with the same message while its number stood still.
test("a goal still after its steers gets its blocker acted on, not the same steer alone", () => {
  const still = { p1: { readings: [{ value: 2, at: now - 7_200_000 }, { value: 2, at: now - 3_600_000 }, { value: 2, at: now - 600_000 }], still: 3 } };
  const [push] = goalPushes(board, views("working"), still as never, 30 * 60_000, now).pushes;
  assert.match(goalDueLine(push!) ?? "", /did not move in the last \d+ check-ins[\s\S]*act on that blocker/);
  const first = { p1: { readings: [{ value: 1, at: now - 600_000 }], still: 0 } };
  const [moving] = goalPushes(board, views("working"), first as never, 30 * 60_000, now).pushes;
  assert.doesNotMatch(goalDueLine(moving!) ?? "", /did not move in the last/);
});

// 01a15427 p22 "hours metal held 70 to 80% CPU" (0 of 2 hours) was steered 43 times from 10-19 21:00Z to 10-20 21:00Z with no new reading between
// most of them, and Vent p1 (read once a day) 13 times.
test("a pushed goal with no new reading since gets no new push until its number could change", () => {
  const held = { ...board, plan: board.plan.map(item => item.id === "p1" ? { ...item, target: { metric: "hours metal held 70 to 80% CPU with no memory stall", target: 2, unit: "hours", current: 0,
    measuredAt: new Date(now - 7_200_000).toISOString(), direction: "up" as const } } : item) };
  const prior = { p1: { readings: [{ value: 0, at: now - 10_800_000 }], still: 1 } };
  const first = goalPushes(held as never, views("working"), prior as never, 15 * 60_000, now);
  assert.equal(first.pushes[0]!.quiet, undefined);
  assert.match(goalDueLine(first.pushes[0]!) ?? "", /^Steer/);
  const second = goalPushes(held as never, views("working"), first.memos, 15 * 60_000, now + 15 * 60_000);
  assert.ok(second.pushes[0]!.quiet);
  assert.match(goalDueLine(second.pushes[0]!) ?? "", /send nothing about it this run; its next push is due at a new reading or at \d\d-\d\d \d\d:\d\dZ/);
  // One hour, the unit of the held time, later the push is due again.
  const third = goalPushes(held as never, views("working"), second.memos, 15 * 60_000, now + 61 * 60_000);
  assert.equal(third.pushes[0]!.quiet, undefined);
  // A new reading with a new value makes the next run push again at once.
  const read = { ...held, plan: held.plan.map(item => item.id === "p1" ? { ...item, target: { ...item.target!, current: 0.5, measuredAt: new Date(now + 10 * 60_000).toISOString() } } : item) };
  const fourth = goalPushes(read as never, views("working"), second.memos, 15 * 60_000, now + 20 * 60_000);
  assert.equal(fourth.pushes[0]!.quiet, undefined);
});

test("a check-in that did not start gives back the goal pushes it marked", () => {
  const before = { p1: { readings: [], still: 0, pushed: { at: 1, reading: 0 } }, p2: { readings: [], still: 0 } };
  const after = { p1: { readings: [], still: 0, pushed: { at: 9, reading: 0 } }, p2: { readings: [], still: 0, pushed: { at: 9, reading: 0 } }, p3: { readings: [], still: 0, pushed: { at: 5, reading: 0 } } };
  const back = unpushed(after, before, 9);
  assert.deepEqual(back.p1!.pushed, { at: 1, reading: 0 });
  assert.equal(back.p2!.pushed, undefined);
  assert.deepEqual(back.p3!.pushed, { at: 5, reading: 0 });
});

// 01a15427's job re-read p22 at 0 hours each half hour on 10-21, and the check-in's Goals section kept the full steer under each run.
test("a re-read of the same value keeps a pushed goal quiet, and the Goals section shows the quiet line in place of the steer", () => {
  const at = (ms: number) => ({ ...board, plan: board.plan.map(item => item.id === "p1" ? { ...item, target: { metric: "hours metal held 70 to 80% CPU with no memory stall", target: 2, unit: "hours", current: 0,
    measuredAt: new Date(ms).toISOString(), direction: "up" as const } } : item) });
  const prior = { p1: { readings: [{ value: 0, at: now - 10_800_000 }], still: 1 } };
  const first = goalPushes(at(now - 7_200_000) as never, views("working"), prior as never, 15 * 60_000, now);
  const second = goalPushes(at(now + 10 * 60_000) as never, views("working"), first.memos, 15 * 60_000, now + 15 * 60_000);
  assert.ok(second.pushes[0]!.quiet);
  const detail = goalsDetail(second.pushes);
  assert.match(detail, /send nothing about it this run/);
  assert.doesNotMatch(detail, /Name the biggest blocker/);
  assert.match(goalsHeadline(second.pushes), /1 of them was pushed already and wait for news/);
  const moved = { ...at(now + 10 * 60_000), plan: at(now + 10 * 60_000).plan.map(item => item.id === "p1" ? { ...item, target: { ...item.target!, current: 0.5 } } : item) };
  assert.equal(goalPushes(moved as never, views("working"), first.memos, 15 * 60_000, now + 15 * 60_000).pushes[0]!.quiet, undefined);
});
