// Crawler VP 10-21: loose_goals flagged p683 "Refresh every read Instagram account at least weekly" in 9 check-ins in a row. p683 is a step
// under goal p829 with a target as its measured done line, a live job and a dated wait, and needs no step of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { looseGoals } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, GoalTarget, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-21T00:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const target = (metric: string, value: number, goal: number, direction: "up" | "down"): GoalTarget =>
  ({ metric, target: goal, unit: "%", current: value, measuredAt: at(10), source: "a probe", cadence: "daily", direction });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: at(5), plan, todos: [] }) as unknown as ChatBoard;
const job: JobFact = { key: "sub-weekly", name: "instagram weekly refresh", state: "working", activityAt: now - 60_000 };

const p683: PlanItem = { id: "p683", text: "Refresh every read Instagram account at least weekly", status: "doing", job: "instagram weekly refresh",
  note: "Done when a 1% sample shows under 1% of read accounts older than 7 days.", waitFor: "a 1% prod sample at or after 10-21 00:00Z",
  target: target("read Instagram accounts past 7 days since their last read", 0.82, 1, "down"), children: [] };
const p829: PlanItem = { id: "p829", text: "Every Instagram profile is re-read at least once every 2 weeks", status: "doing",
  target: target("Read Instagram profiles re-read within 14 days", 100, 100, "up"), children: [p683] };

const loose = (plan: PlanItem[], facts: JobFact[] = []) => {
  const precheck = checkInPrecheck(undefined, facts, board(plan), now);
  return convergenceMisses("chat", precheck.steps, precheck, {}, 30 * 60_000, now).flagged.filter(slice => slice.kind === "loose_goals").map(slice => slice.item);
};

test("a step with a target under a goal is no loose goal, with or without a live job", () => {
  assert.deepEqual(looseGoals(board([p829])), []);
  assert.deepEqual(loose([p829], [job]), []);
  const { job: _job, waitFor: _wait, ...bare } = p683;
  assert.deepEqual(loose([{ ...p829, children: [bare] }]), []);
});

test("a step with a target under an area is no loose goal", () => {
  assert.deepEqual(loose([{ id: "p1", text: "Instagram", status: "doing", children: [p683] }]), []);
});

test("a top-level item with no steps is still a loose goal, with or without a target", () => {
  const bare: PlanItem = { id: "p91", text: "Simplify the box's web addresses", status: "doing", children: [] };
  assert.deepEqual(loose([p829, bare, { ...p683, id: "p700" }]), ["p91", "p700"]);
});
