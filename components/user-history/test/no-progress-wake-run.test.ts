import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { Train } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

// Frontend bro 10-15: p145's job slept on a board.wake for verify-dev run 38724412490 from 11:01:58Z, and the 11:31Z, 11:46Z and 12:02Z check-ins
// read no_progress 1 with p145 as the one moving step, while the run's guards and lint on macOS jobs waited for pool-light and m1-air runners.

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan });
const NOW = Date.parse("2026-10-15T11:31:09Z");
const RUN = "38724412490";
const plan = board([step("p142", "Both daily checks pass again", "doing", { children: [
  step("p145", "A hand edit of a generated demo file no longer makes 5180 restart in a loop", "doing", { job: "5180 materialize crash loop fix" })] })]);
const facts: JobFact[] = [{ key: "job:5180 materialize crash loop fix", name: "5180 materialize crash loop fix", state: "working", activityAt: NOW - 30 * 60_000,
  wake: `a board.wake on run ${RUN}` }];
const train = (running: boolean, conclusion: string | null): Train =>
  ({ runs: [], readAt: NOW, all: new Map([[RUN, { id: RUN, running, conclusion, updatedAt: NOW - 29 * 60_000 }]]) });
const noProgressAt = (ci: Train): number => {
  const memory = checkInPrecheck(undefined, facts, plan, NOW - 2 * 60 * 60_000, { self: ["chat"], train: ci }).memory;
  const precheck = checkInPrecheck(memory, facts, plan, NOW, { self: ["chat"], train: ci });
  return convergenceMisses("chat", precheck.steps, precheck, {}, 15 * 60_000, NOW).metrics.no_progress;
};

test("no progress: a step whose job sleeps on a board.wake for a queued or running run is held, as a waitFor naming the run is (frontend bro 10-15, p145)", () => {
  assert.equal(noProgressAt(train(true, null)), 0, "run 38724412490 is queued, so p145 waits on CI that has not finished");
  assert.equal(noProgressAt(train(false, "success")), 1, "once the run finished, a step still open with no item done is no progress");
});
