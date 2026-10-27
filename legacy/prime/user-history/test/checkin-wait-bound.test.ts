// Clean-room w81 run6 on us-metal02, 10-26: the job "test file count" reported 492 files at 09:13:47Z, and the chat set p3 to wait for the release
// owner's message under it. At 10:11Z, 58 min later, the check-in nudged the job ("nothing moved for 58 min, since 10-26 09:14Z"), read
// stuck_steps 1 and goal_gaps 1, and its check-in job steered the job. A reported job under a fresh waitFor waits as the same session for that
// message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { goalGap } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { OK_STATES } from "../src/checkin-end-state.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const reportedAt = Date.parse("2026-10-26T09:13:47Z");
const changedAt = "2026-10-26T09:14:03Z";
const board = (waitFor?: string): ChatBoard => ({ v: 2, rev: 6, updatedAt: changedAt, todos: [], plan: [
  { id: "p1", text: "Compare test file counts across the next chat release", status: "doing",
    target: { metric: "board values recorded", target: 3, unit: "", current: 1, measuredAt: changedAt, source: "the board" }, children: [
    { id: "p2", text: "Recorded 492 test files before the release", status: "done", job: "test file count", sessionId: "01a1777b", children: [] },
    { id: "p3", text: "Record the count and difference after the next chat release", status: "todo", job: "test file count", sessionId: "01a1777b",
      ...waitFor ? { waitFor } : {}, children: [] }] }] } as unknown as ChatBoard);
const job = (replied: boolean): JobFact => ({ key: "sub-9054b77d", name: "test file count", state: "ended", activityAt: reportedAt + 60_000, replied,
  sessionId: "01a1777b", lastMessage: { at: reportedAt, text: "492 test files verified", factsAt: reportedAt } });
const wait = "The release owner's message that the next sieun-pi chat release reached this box.";

/** The check-ins at 09:41Z and 10:11Z, every 30 min, each with the memory of the one before. */
function checkIns(waitFor: string | undefined, fact: JobFact) {
  const context = { everyMs: 30 * 60_000, self: ["test file counts 3"] };
  const first = checkInPrecheck(undefined, [fact], board(waitFor), Date.parse("2026-10-26T09:41:48Z"), context);
  return checkInPrecheck(first.memory, [fact], board(waitFor), Date.parse("2026-10-26T10:11:54Z"), context);
}

test("a reported job whose step waits on a fresh waitFor is not pushed, its step is not stuck and its goal is no gap", () => {
  const run = checkIns(wait, job(true));
  assert.deepEqual(run.jobs.map(push => push.why), [], "no nudge at 58 min");
  const p3 = run.end.find(entry => entry.view.item.id === "p3")!;
  assert.ok(OK_STATES.has(p3.state), `${p3.state}: ${p3.reason}`);
  assert.match(p3.reason, /that message reaches the same job/);
  assert.equal(run.goals.filter(goalGap).length, 0, run.goals.map(push => `${push.goal.id} ${push.act}`).join(", "));
});

test("the same job is still pushed when its step has no wait, or when it never reported", () => {
  assert.equal(checkIns(undefined, job(true)).jobs.length, 1, "no wait: the step is the job's work");
  const { lastMessage: _said, ...silent } = job(false);
  assert.equal(checkIns(wait, silent).jobs.length, 1, "no report: the job does not wait on the step, so the check-in pushes it");
});
