// Guards d7's stuck_duty line of 10-18 16:33Z: it flagged Vent's check-in as "Check-in missed 16 runs in a row" while p8 (duty checkin/goal_gaps)
// had the job vent cutover train, whose last turn had ended on "pi-pool: this session waits for its slot at 2026-10-18T16:45:52.000Z", and
// Vent read "missed N runs" as "did not run".
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { fileSlotPark } from "../src/slot-park.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const TRAIN = "01a14e9a-341f-742c-931a-1864dd380429";
const assistant = (stopReason: string, errorMessage?: string) => JSON.stringify({ type: "message", timestamp: "2026-10-18T16:10:39.071Z",
  message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason, ...errorMessage ? { errorMessage } : {} } });
const SLOT = "Failed to resolve API key for provider \"anthropic\" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token pi-pool: this session " +
  "waits for its slot at 2026-10-18T16:45:52.000Z. Try again in 35 minutes.";

test("a transcript whose last assistant turn ended on a pi-pool slot wait reads as waiting for its slot", () => {
  const user = JSON.stringify({ type: "message", message: { role: "user", content: "[wake]" } });
  assert.equal(fileSlotPark([assistant("stop"), user, assistant("error", SLOT), ""]).park !== undefined, true);
  assert.equal(fileSlotPark([assistant("error", SLOT), user, assistant("stop")]).park !== undefined, false, "a later turn that ran ends the wait");
  assert.equal(fileSlotPark([assistant("error", "Provider overloaded (529)")]).park !== undefined, false, "another error is no slot wait");
});

test("a red duty whose fix step's owner waits for its pi-pool slot or sleeps on a board.wake is not stuck, and the line names the duty link", () => {
  const runs: DutyRunRecord[] = [0, 1, 2].map(back => ({ duty: "checkin", at: Date.parse("2026-10-18T16:25:00Z") - back * 900_000, trigger: "schedule" as const,
    ms: 1, verdict: "missed" as const, summary: "", metrics: { goal_gaps: { value: 1, target: 0, op: "<=" as const, met: false },
      stuck_steps: { value: 0, target: 0, op: "<=" as const, met: true } } }));
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-18T16:20:00Z", plan: [{ id: "p8", text: "p8", status: "doing", children: [],
    duty: "checkin/goal_gaps", job: "vent cutover train", sessionId: TRAIN, waitFor: "land 40 run 39144738917 reaches staging, then promote 13" }] };
  const read = (sets: { poolWaiting?: string[]; waking?: string[] }) => measure({ now: Date.parse("2026-10-18T16:33:15Z"), watch: [], log: { holds: [] },
    chats: [{ id: VENT, name: "Vent", duties: [{ id: "checkin", name: "Check-in" }], runs }], boards: new Map([[VENT, board]]),
    ownerActivity: new Map([[TRAIN, Date.parse("2026-10-18T16:10:39Z")]]), waking: new Set(sets.waking ?? []), poolWaiting: new Set(sets.poolWaiting ?? []) });
  assert.equal(read({ poolWaiting: [TRAIN] }).metrics.stuck_duties, 0);
  assert.equal(read({ waking: [TRAIN] }).metrics.stuck_duties, 0);
  const stuck = read({});
  assert.equal(stuck.metrics.stuck_duties, 1);
  assert.deepEqual((stuck.flagged ?? []).filter(slice => slice.kind === "stuck_duty").map(slice => slice.excerpt),
    ["Vent: Check-in read off target in its last 3 runs, and no open step linked to it (duty field checkin/goal_gaps) has a live owner now"]);
});
