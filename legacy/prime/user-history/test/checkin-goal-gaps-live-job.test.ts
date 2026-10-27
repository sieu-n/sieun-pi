// Chat system duty (d9) 10-20 00:29Z: 11 of 12 check-ins read red on goal_gaps, Crawler VP's for 71 runs in a row, on goals a live job worked on
// whose number was off pace, such as p828 (200M creators, about 48 days to target), and on goals whose working job held a step under them but not
// their push step (vent p26 under the working "vent cutover train"). goal_gaps now counts only a goal no live job works on; the others are steered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { convergenceMisses, type BoardFindings } from "../src/chat-checkin.ts";
import { goalGap, goalPushes, pushNeeded } from "../src/checkin-goals.ts";
import { classifyBoard, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-20T00:30:00Z");
const measured = "2026-10-20T00:20:00Z";
const goal = (id: string, text: string, target: number, current: number, children: PlanItem[]): PlanItem =>
  ({ id, text, status: "doing", children, target: { metric: text, target, unit: "", current, measuredAt: measured, source: "a read" } });
const step = (id: string, job: string, duty?: string): PlanItem => ({ id, text: `Work on ${id}`, status: "doing", job, ...duty ? { duty } : {}, children: [] });

const creators = goal("p828", "Instagram creators indexed", 200_000_000, 18_629_424, [step("p829", "census seed order", "checkin/goal_gaps")]);
const keys = goal("p26", "Provider keys moved into Vent", 100, 12, [step("p3", "vent cutover train")]);
const forms = goal("p29", "Form kinds stored in Convex", 3, 0, [step("p24", "contact form storage")]);
const board = { v: 2, rev: 1, updatedAt: measured, plan: [creators, keys, forms], todos: [] } as unknown as ChatBoard;
const facts: JobFact[] = [
  { key: "sub-census", name: "census seed order", state: "working", activityAt: now - 60_000 },
  { key: "sub-train", name: "vent cutover train", state: "working", activityAt: now - 60_000 },
  { key: "sub-forms", name: "contact form storage", state: "ended", activityAt: now - 5 * 60 * 60_000 },
];
const still = (value: number) => ({ readings: [{ value, at: now - 3 * 60 * 60_000 }, { value, at: now - 2 * 60 * 60_000 }], still: 2 });
const memos = { p828: still(18_629_424), p26: still(12), p29: still(0) };
const views = classifyBoard(board, facts, () => now - 60 * 60_000, new Set(["Crawler VP"]), [], now, new Set());
const { pushes } = goalPushes(board, views, memos as never, 30 * 60_000, now);
const byId = (id: string) => pushes.find(push => push.goal.id === id)!;

test("the check-in still steers or starts every off-pace goal", () => {
  assert.deepEqual(pushes.filter(pushNeeded).map(push => push.goal.id).sort(), ["p26", "p29", "p828"]);
  assert.equal(byId("p828").act, "steer");
  assert.equal(byId("p26").act, "steer", "the live job on a step under it owns it");
});

test("goal_gaps counts only the goal no live job works on", () => {
  assert.equal(goalGap(byId("p828")), false, "its push step's job works on it");
  assert.equal(goalGap(byId("p26")), false, "a live job works on a step under it");
  assert.equal(byId("p26").owner?.name, "vent cutover train");
  assert.equal(goalGap(byId("p29")), true, "its only job ended");
});

test("the check-in measure judges goal_gaps 1 and reports the two off-pace goals in goals_off_pace", () => {
  const findings: BoardFindings = { scope: [], gates: [], stalled: [], goals: pushes, blocked: [], done: [], loose: [], extra: [], underClosed: [], held: [],
    waitsMet: [], noProgress: null, stale: [], fold: [] };
  const { metrics, flagged } = convergenceMisses("chat", [], findings, {}, 30 * 60_000, now);
  assert.equal(metrics.goal_gaps, 1);
  assert.equal(metrics.goals_off_pace, 2);
  assert.deepEqual(flagged.filter(slice => slice.kind === "goal_gaps").map(slice => slice.item), ["p29"]);
});
