// root disk readings 10-25 00:13 KST: the owner gave p3 ("check the last sample against a fresh df and write the trend page") to the chat itself,
// and the chat held a board.wake at 16:50Z with the note "p3: read 12 samples, fresh df, start page writer". Two check-ins in a row flagged p3
// stuck, and the 23:43 run handed it to a job against the owner's assignment. A chat's own pending time wake that names a step with no job, or
// matches its waitUntil, owns the step until the wake is more than WAKE_LATE_MS late.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";
import type { Wake } from "../src/wakes.ts";

const MIN = 60_000;
const CHAT = "01a16e1d-6592-73c6-9a96-81184bf35e5a";
const SAMPLER = "01a16e85-5aef-71bb-9066-5ef54aae83af";
const AT = 1792860600000;
const wake = (note: string, at = AT): Wake => ({ session: CHAT, on: { kind: "time", at }, note, since: Date.parse("2026-10-24T13:43:38Z") });
const p3 = (extra: Partial<PlanItem> = {}): PlanItem => ({ id: "p3", text: "Check the last sample against a fresh df and write the trend page", status: "todo",
  children: [], waitFor: "p2, then this chat's 01:50 KST wake", ...extra });
const board = (step: PlanItem): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-24T15:00:00Z", todos: [], plan: [
  { id: "p1", text: "Show how free space on us-metal02's main disk moves over 3 hours", status: "doing", children: [
    { id: "p2", text: "Sample free space on / every 15 minutes for 3 hours", status: "doing", children: [], job: "disk free sampling", sessionId: SAMPLER,
      waitUntil: "2026-10-24T16:49:30.000Z" },
    step] }] } as unknown as ChatBoard);
const rows = [{ id: CHAT, name: "root disk readings" }, { id: SAMPLER, name: "disk free sampling" }] as unknown as SessionRow[];
const facts: JobFact[] = [{ key: `thread:${SAMPLER}`, name: "disk free sampling", state: "ended", sessionId: SAMPLER, activityAt: Date.parse("2026-10-24T14:02:00Z") }];
const p3State = (step: PlanItem, wakes: readonly Wake[], now: number) => {
  const precheck = checkInPrecheck(undefined, facts, board(step), now, { self: [CHAT, "root disk readings"], rows, wakes });
  const stuck = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * MIN, now).flagged.filter(slice => slice.kind === "stuck_steps").map(slice => slice.item);
  const end = precheck.end.find(entry => entry.view.item.id === "p3")!;
  return { state: end.state, reason: end.reason, stuck: stuck.includes("p3") };
};

test("a chat's own pending time wake whose note names a step with no job owns it, and the step is stuck again once the wake is overdue", () => {
  const now = Date.parse("2026-10-24T15:13:00Z");
  const held = p3State(p3(), [wake("p3: read 12 samples, fresh df, start page writer")], now);
  assert.deepEqual(held, { state: "moving", reason: "the chat holds it with its own board.wake at 16:50Z", stuck: false });
  assert.equal(p3State(p3(), [wake("p3: read 12 samples, fresh df, start page writer")], AT + 2 * MIN).state, "moving");
  const late = p3State(p3(), [wake("p3: read 12 samples, fresh df, start page writer")], AT + 3 * MIN);
  assert.equal(late.state, "event");
  assert.equal(late.stuck, true);
  assert.equal(p3State(p3(), [], now).stuck, true);
  assert.equal(p3State(p3(), [wake("p30: another step")], now).stuck, true);
  assert.equal(p3State(p3(), [{ ...wake("p3: fresh df"), session: "01a16e00-0000-7000-8000-000000000000" }], now).stuck, true);
});

test("a chat's own pending time wake at a step's waitUntil owns it, and a step whose job ended is not held by the chat's wake", () => {
  const now = Date.parse("2026-10-24T15:13:00Z");
  assert.equal(p3State(p3({ waitUntil: "2026-10-24T16:50:00.000Z" }), [wake("read the samples")], now).state, "moving");
  assert.equal(p3State(p3({ waitUntil: "2026-10-24T18:00:00.000Z" }), [wake("read the samples")], now).stuck, true);
  assert.equal(p3State(p3({ job: "disk free sampling", sessionId: SAMPLER }), [wake("p3: fresh df")], now).stuck, true);
});
