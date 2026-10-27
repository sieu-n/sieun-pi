// CI and RepoOps 10-19: a check-in moved p258 from d1/push_to_verdict_p90_min to checkin/goal_gaps between 16:19Z and 18:19Z, and the CI system
// duty read off target with no linked fix step in every Chat system run after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalDueLine, goalPushes } from "../src/checkin-goals.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-19T17:00:00Z");
const step = (duty: string): PlanItem => ({ id: "p258", text: "A push in the busy hours gets its test result as fast as a quiet push", status: "doing", job: "ci redesign build", duty, children: [] });
const goal = (child: PlanItem): PlanItem => ({ id: "p1", text: "Every push gets its test result within 10 minutes at p90", status: "doing", children: [child],
  target: { metric: "push to verdict p90", target: 10, unit: "min", current: 52, measuredAt: "2026-10-19T16:50:00Z", source: "CI system duty" } } as PlanItem);
const pushFor = (duty: string) => {
  const child = step(duty);
  const parent = goal(child);
  const board = { v: 2, rev: 1, updatedAt: "2026-10-19T16:50:00Z", plan: [parent], todos: [] } as unknown as ChatBoard;
  const ended: JobFact = { key: "sub-ci", name: "ci redesign build", state: "ended" };
  const views = [{ item: child, owner: ended, mine: false, changedAt: now - 3_600_000, cls: "doing", openTodos: [], goal: { id: "p1", text: parent.text } } as unknown as StepView];
  return goalPushes(board, views, {}, 30 * 60_000, now).pushes[0]!;
};

test("the check-in keeps a standing duty's fix step on its link and adds a push step with the same job", () => {
  const push = pushFor("d1/push_to_verdict_p90_min");
  assert.equal(push.act, "start");
  const line = goalDueLine(push) ?? "";
  assert.match(line, /^Steer the job ci redesign build on p258/);
  assert.match(line, /Keep p258 linked to "d1\/push_to_verdict_p90_min"/);
  assert.match(line, /add a push step under p1 with duty "checkin\/goal_gaps", the job ci redesign build and a Done when line/);
  assert.doesNotMatch(line, /set the duty of p258/);
});

test("a step on a check-in link still moves to the goal's push link, with no new step", () => {
  const line = goalDueLine(pushFor("checkin/stuck_steps")) ?? "";
  assert.match(line, /set the duty of p258 to "checkin\/goal_gaps"/);
  assert.match(line, /Add no new step/);
});
