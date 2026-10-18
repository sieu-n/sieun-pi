// 10-18 12:03Z: 18e1484e took the check-in duty to 6 metrics, over c75's one headline and 3 more, and every check-in summary asked for a rework.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_IN_DUTY, dutyShapeProblem, shapeNote } from "../src/shared/chat-duties.ts";

test("the built-in check-in duty keeps c75's shape: one headline, goal_gaps, and at most 3 more", () => {
  assert.equal(dutyShapeProblem(CHECK_IN_DUTY.metrics), null);
  assert.equal(shapeNote(CHECK_IN_DUTY.metrics), null);
  assert.deepEqual(CHECK_IN_DUTY.metrics.map(metric => metric.key), ["goal_gaps", "stuck_steps", "no_done_line", "plan_risks"]);
});
