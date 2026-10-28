// Clean-room w81 run7 on us-metal02, 10-26, chat "test file counts 4" (01a177e7). "test file count" (sub-3eed36dc) reported 493 files at
// 11:13:26Z. At about 11:13:28Z the job cleanup handed p2 to the chat (job set to the chat, "Handed back: job test file count ..." first in the
// note), and the chat's own plan_update at 11:13:32Z set p2's release wait with a new note that dropped that line, so p2 was the chat's with no
// job named. Every check-in from 11:15Z to 12:13:30Z then read stuck_steps 1 and goal_gaps 1 for p2, until the old cleanup parked the job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { OK_STATES } from "../src/checkin-end-state.ts";
import { goalGap } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { handBackNote } from "../src/chat-checkin.ts";
import { applyBoardOp } from "../src/shared/chat-board.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const CHAT = "01a177e7-cec2-7794-9271-b2d025b779ba";
const REPORTED = Date.parse("2026-10-26T11:13:26Z");
const WAIT = "The release owner's message that the next sieun-pi chat release is on this box.";
const NOTE = "Done when both counts and their difference are recorded here. Initial count is 493 test files, measured on October 26 at 20:13 KST.";

/** The board after the handback at 11:13:28Z: p2 is the chat's, its note starts with the handback line. */
function handedBack(): ChatBoard {
  return { v: 2, rev: 4, updatedAt: "2026-10-26T11:13:28.000Z", todos: [], plan: [
    { id: "p1", text: "Compare test file counts across the next chat release", status: "doing",
      target: { metric: "counts recorded", target: 2, unit: "", current: 1, measuredAt: "2026-10-26T11:13:28.000Z", source: "the board" },
      note: "Done when the board shows both counts and the difference.", children: [
        { id: "p2", text: "Count test files before and after the release", status: "doing", job: CHAT, sessionId: CHAT,
          note: `${handBackNote("test file count", REPORTED)}\nDone when both counts and their difference are recorded here.`, children: [] }] }] } as unknown as ChatBoard;
}
/** The chat's own write at 11:13:32Z: a new note and the release wait, the job left as it is. */
const chatWrite = (board: ChatBoard, extra: Record<string, unknown> = {}) =>
  applyBoardOp(board, { op: "plan_update", id: "p2", note: NOTE, waitFor: WAIT, ...extra } as never, "agent", "2026-10-26T11:13:32.000Z", () => "p9");

test("a chat note rewrite keeps the handback line, so the step still names the reported job; a new job drops it", () => {
  const { board, summary } = chatWrite(handedBack());
  const p2 = board.plan[0]!.children[0]!;
  assert.match(p2.note ?? "", /^Handed back: job test file count reported at /);
  assert.ok(p2.note!.includes(NOTE));
  assert.equal(p2.waitFor, WAIT);
  assert.match(summary, /kept its Handed back line/);
  const moved = chatWrite(handedBack(), { job: "recount job" }).board.plan[0]!.children[0]!;
  assert.equal(moved.note, NOTE, "a step given to another job does not keep the old job named");
});

test("run7 replay: the chat-owned p2 with a fresh wait reads waiting, not stuck_steps or goal_gaps, while it names the reported job", () => {
  const board = chatWrite(handedBack()).board;
  const job: JobFact = { key: "sub-3eed36dc", name: "test file count", state: "ended", activityAt: REPORTED + 2_000, replied: true, sessionId: "01a177e9",
    lastMessage: { at: REPORTED, text: "493 test files", factsAt: REPORTED } };
  const context = { everyMs: 30 * 60_000, self: [CHAT, "test file counts 4"] };
  let memory = undefined as Parameters<typeof checkInPrecheck>[0];
  for (const at of ["2026-10-26T11:13:32Z", "2026-10-26T11:43:28Z", "2026-10-26T12:13:30Z"]) {
    const run = checkInPrecheck(memory, [job], board, Date.parse(at), context);
    memory = run.memory;
    const p2 = run.end.find(entry => entry.view.item.id === "p2")!;
    assert.ok(OK_STATES.has(p2.state), `${at}: ${p2.state}: ${p2.reason}`);
    assert.match(p2.reason, /test file count reported and waits for/);
    assert.equal(run.goals.filter(goalGap).length, 0, `${at}: ${run.goals.map(push => `${push.goal.id} ${push.act}`).join(", ")}`);
    assert.deepEqual(run.jobs.map(push => push.why), [], `${at}: the job is not pushed`);
  }
});

test("a chat-owned wait is stuck as before once it is stale, when it names no job, or when its job never reported", () => {
  const board = chatWrite(handedBack()).board;
  const job: JobFact = { key: "sub-3eed36dc", name: "test file count", state: "ended", activityAt: REPORTED + 2_000, replied: true,
    lastMessage: { at: REPORTED, text: "493 test files", factsAt: REPORTED } };
  const context = { everyMs: 30 * 60_000, self: [CHAT, "test file counts 4"] };
  const stuck = (facts: JobFact[], at: string, plan = board) => {
    const p2 = checkInPrecheck(undefined, facts, plan, Date.parse(at), context).end.find(entry => entry.view.item.id === "p2")!;
    return OK_STATES.has(p2.state);
  };
  assert.equal(stuck([job], "2026-10-26T13:20:00Z"), false, "2 h after its last change the wait is stale");
  const { lastMessage: _said, ...silent } = { ...job, replied: false };
  assert.equal(stuck([silent], "2026-10-26T11:43:28Z"), false, "a job that never reported does not carry the wait");
  const unnamed = applyBoardOp(board, { op: "plan_update", id: "p2", note: NOTE, job: CHAT } as never, "agent", "2026-10-26T11:14:00.000Z", () => "p9").board;
  assert.equal(stuck([job], "2026-10-26T11:43:28Z", unnamed), false, "a step that names no job is the chat's own wait");
});
