// Guards Crawler VP's check-in at 21:21Z on 10-18: it flagged goal_gaps on p681, whose push step p696 has the job "tiktok shop products push",
// and its run recorded p671 "linkedin api fixes" under p670 as the fix, because that step came first on the board.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyFixes } from "../src/shared/duty-fixes.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const step = (id: string, fields: Partial<PlanItem> = {}): PlanItem => ({ id, text: id, status: "doing", children: [], ...fields } as PlanItem);
const board = { plan: [
  step("p670", { children: [step("p671", { job: "linkedin api fixes", duty: "checkin/goal_gaps" })] }),
  step("p681", { children: [step("p696", { job: "tiktok shop products push", duty: "checkin/goal_gaps" })] }),
] } as unknown as ChatBoard;
const live = async () => true;

test("a missed metric's fix is the step under the item the run flagged for it", async () => {
  const fixes = await dutyFixes(board, "checkin", ["goal_gaps"], live, [{ kind: "goal_gaps", item: "p681", excerpt: "p681 off pace" }]);
  assert.deepEqual(fixes.goal_gaps, { step: "p696", job: "tiktok shop products push", live: true });
});

test("with no flagged item for the metric the first live step stays the fix", async () => {
  assert.equal((await dutyFixes(board, "checkin", ["goal_gaps"], live))["goal_gaps"]?.step, "p671");
  assert.equal((await dutyFixes(board, "checkin", ["goal_gaps"], live, [{ kind: "stuck_steps", item: "p681", excerpt: "" }]))["goal_gaps"]?.step, "p671");
});

test("the duty's own goal is no fix when the push names it, so a job that holds the goal does not stop the push", async () => {
  // 10-20: "wiki goal hold" on p200 (d4/wiki_problems) slept on a board.wake from 08:19Z, and no d4 push ran until wiki_problems read 26.
  const held = { plan: [step("p200", { job: "wiki goal hold", duty: "d4/wiki_problems", children: [step("p810", { job: "wiki goal hold" })] })] } as unknown as ChatBoard;
  assert.equal((await dutyFixes(held, "d4", ["wiki_problems"], live))["wiki_problems"]?.live, true);
  assert.deepEqual(await dutyFixes(held, "d4", ["wiki_problems"], live, [], "p200"), {});
});
