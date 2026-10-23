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
  // A new reading that moves toward the target is the job at work, so it stays quiet too.
  const read = { ...held, plan: held.plan.map(item => item.id === "p1" ? { ...item, target: { ...item.target!, current: 0.5, measuredAt: new Date(now + 10 * 60_000).toISOString() } } : item) };
  const fourth = goalPushes(read as never, views("working"), second.memos, 15 * 60_000, now + 20 * 60_000);
  assert.doesNotMatch(goalDueLine(fourth.pushes[0]!) ?? "", /^Steer/);
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
  assert.doesNotMatch(goalDueLine(goalPushes(moved as never, views("working"), first.memos, 15 * 60_000, now + 15 * 60_000).pushes[0]!) ?? "", /^Steer/);
});

// Crawler VP 10-21: p892 "Instagram queues growing over 6 h" (2 queues, last read 14:32Z) and p670 "LinkedIn index gaps passing on prod"
// (6 of 7, last read 14:23Z) got the same steer every hour from 15:00Z to 00:18Z with no new reading, each time their stale time ran out.
const shaped = (target: NonNullable<PlanItem["target"]>) => ({ ...board, plan: board.plan.map(item => item.id === "p1" ? { ...item, target } : item) }) as never;
const p892 = (value: number, at: number, source = "duty d9 metric ig_queues_growing_6h") => shaped({ metric: "Instagram queues growing over 6 h", target: 0, unit: "queues",
  current: value, measuredAt: new Date(at).toISOString(), source, direction: "down" });
const p670 = (value: number, at: number) => shaped({ metric: "LinkedIn index gaps passing on prod", target: 7, unit: "gaps", current: value, measuredAt: new Date(at).toISOString(),
  source: "linkedin gap check", direction: "up" });
const run = (b: never, memos: never, at: number, state: JobFact["state"] = "working") => goalPushes(b, views(state), memos, 15 * 60_000, at);

for (const [name, shape, value, away] of [["p892", p892, 2, 3], ["p670", p670, 6, 5]] as const) {
  test(`${name}: a stale goal steered once stays quiet with no news, and a regression gets one push`, () => {
    const read = now - 30 * 60_000;
    const prior = { p1: { readings: [{ value, at: read - 7_200_000 }], still: 1 } } as never;
    const first = run(shape(value, read), prior, now);
    assert.equal(first.pushes[0]!.quiet, undefined);
    // Each hour after, with no new reading, the stale time running out is no news.
    let memos = first.memos;
    for (let hour = 1; hour <= 9; hour++) {
      const later = run(shape(value, read), memos as never, now + hour * 3_600_000);
      assert.ok(later.pushes[0]!.quiet, `${name} hour ${hour}`);
      memos = later.memos;
    }
    // A re-read of the same value, or a backfill, is no news either.
    assert.ok(run(shape(value, now + 3_600_000), memos as never, now + 4 * 3_600_000).pushes[0]!.quiet);
    if (name === "p892") assert.ok(run(p892(value, now + 3_600_000, "backfill of the 6 h growth"), memos as never, now + 4 * 3_600_000).pushes[0]!.quiet);
    // A move away gets one push, and the same value after it is quiet again.
    const regressed = run(shape(away, now + 3_600_000), memos as never, now + 4 * 3_600_000);
    assert.equal(regressed.pushes[0]!.quiet, undefined);
    assert.ok(run(shape(away, now + 7_200_000), regressed.memos as never, now + 5 * 3_600_000).pushes[0]!.quiet);
    // The owner job ending turns the steer into a start, which is news.
    assert.equal(run(shape(value, read), memos as never, now + 3 * 3_600_000, "ended").pushes[0]!.quiet, undefined);
    // A day with no news renews the push.
    assert.equal(run(shape(value, read), memos as never, now + 25 * 3_600_000).pushes[0]!.quiet, undefined);
  });
}

// 10-22 00:45Z to 05:16Z: 4 of 40 check-in goal steers went to sessions waiting for their account slot, among them VP of CI at 04:20Z
// ("this session waits for its slot at 2026-10-22T05:14:00.000Z").
test("a goal whose job waits for its account slot waits with it, and the check-in gets no steer for it", () => {
  const error = "Provider rate limit exceeded (rate_limit_error, 429). pi-pool: claude3@x is limited until 2026-10-22T06:29:59.000Z; this session waits for its slot at 2026-10-22T05:14:00.000Z. Try again in 58 minutes.";
  const waiting: StepView[] = [{ ...views("failed")[0]!, owner: { ...runtime("failed"), error } } as StepView];
  const before = Date.parse("2026-10-22T04:20:00Z");
  const [push] = goalPushes(board, waiting, memo as never, 30 * 60_000, before).pushes;
  assert.equal(push?.act, "waiting");
  assert.match(push?.waits ?? "", /waits for its account slot until 10-22 05:14Z/);
  assert.equal(goalDueLine(push!), null);
  const [other] = goalPushes(board, [{ ...waiting[0]!, owner: { ...runtime("failed"), error: "Provider returned 500" } } as StepView], memo as never, 30 * 60_000, before).pushes;
  assert.equal(other?.act, "start");
  // Past the slot the goal is pushed again, so a job the resume pass missed gets its restart.
  const [late] = goalPushes(board, waiting, memo as never, 30 * 60_000, Date.parse("2026-10-22T05:20:00Z")).pushes;
  assert.equal(late?.act, "start");
});

// VP of CI p1 "push to verdict p90" (at most 10 min) swung between 249.5 and 298 min on 10-22 and got a steer at each swing either way.
test("a swinging number gets one push at a new worst value and none for a swing back or a repeat of that worst", () => {
  const p1 = (value: number, at: number) => shaped({ metric: "push to verdict p90, 24 h", target: 10, unit: "min", current: value, measuredAt: new Date(at).toISOString(),
    source: "d1 precheck", direction: "down" });
  const prior = { p1: { readings: [{ value: 249.5, at: now - 7_200_000 }], still: 1 } } as never;
  const first = run(p1(249.5, now - 3_600_000), prior, now);
  assert.equal(first.pushes[0]!.quiet, undefined);
  const worse = run(p1(298.1, now + 30 * 60_000), first.memos as never, now + 60 * 60_000);
  assert.equal(worse.pushes[0]!.quiet, undefined, "a new worst value is a regression, which gets one push");
  const back = run(p1(249.5, now + 90 * 60_000), worse.memos as never, now + 2 * 3_600_000);
  assert.ok(back.pushes[0]!.quiet, "a swing back toward the target is no news");
  const again = run(p1(298.1, now + 150 * 60_000), back.memos as never, now + 3 * 3_600_000);
  assert.ok(again.pushes[0]!.quiet, "the same worst value again is no news");
});
