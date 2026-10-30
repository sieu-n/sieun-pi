// sep launch!! 10-30 09:08 KST, the 4th check-in in a row: p124 and p125 sat under Flagged again as host_held, which asks the chat for a board op
// or a message every run, though a step held on an offline box needs neither. p125 waited for the release owner's next prod promote, not for
// its box, yet read host_held because its job "prod data move" ran on the sleeping Mac. A held step stays out of Flagged again, and a held step
// whose wait names other work reads by that wait.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses, type CheckInMemory } from "../src/chat-checkin.ts";
import { flagStreaks } from "../src/checkin-repeats.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const start = Date.parse("2026-10-30T00:08:00Z");
const p124: PlanItem = { id: "p124", text: "The real app gets the finished 5180 design, then staging, then prod", status: "doing", job: "5180 port plan",
  sessionId: "01a18007-8644-74cd-9fbc-3260a0855ca4",
  waitFor: "the Mac (offline on Tailscale since about 23:19Z): its pushes through 22:02Z landed as staging 262267c258 at 22:26Z; the rest of the New campaign workers' work is unpushed there",
  note: "Done when every 5180 screen runs the same in the real app on staging.", children: [] };
const p125: PlanItem = { id: "p125", text: "Prod data moves to the one-table model after the next promote", status: "blocked", job: "prod data move",
  sessionId: "01a17f82-e520-76cb-b946-f153b173647b",
  waitFor: "the release owner's next prod promote, walked with the owner (no promote ran at the 10-29 10:00 KST walk; main is still 416fae9 from 10-25); job prod data move runs the 12 steps after",
  note: "Done when the 13 steps (14 runs) of sessions/2026/10/28/0756-dm-prod-move-recheck/prod-move-ready.html ran green on prod with counts matching the page, and the last cleanup that drops the emptied prompt and draft tables is on staging.",
  children: [] };
const p2: PlanItem = { id: "p2", text: "The 5180 app works for real on local and staging", status: "doing", note: "Done when every screen passes on staging", children: [p124, p125] };
const board = { v: 2, rev: 1, updatedAt: "2026-10-29T19:40:00Z", todos: [], plan: [p2] } as unknown as ChatBoard;
const facts: JobFact[] = [
  { key: "child-p124", name: "5180 port plan", state: "working", sessionId: p124.sessionId!, activityAt: Date.parse("2026-10-29T22:30:00Z") },
  { key: "child-p125", name: "prod data move", state: "working", sessionId: p125.sessionId!, activityAt: Date.parse("2026-10-29T16:00:00Z"), wake: "a check by 05:16Z" },
];
const rows = [{ id: SEP, name: "sep launch!!", host: "mac" }] as unknown as SessionRow[];
const held = hostHolds([{ name: "mac", lastSeen: "2026-10-30T00:30:00Z" }]);

/** Four check-ins 30 minutes apart while the Mac sleeps, each carrying the last one's memory and streaks, as chats.ts does. */
function fourRuns() {
  let memory: CheckInMemory | undefined;
  let streaks: Record<string, number> | undefined;
  let text = "";
  let flagged: ReturnType<typeof convergenceMisses>["flagged"] = [];
  let precheck: ReturnType<typeof checkInPrecheck> | undefined;
  for (let run = 0; run < 4; run++) {
    const now = start + run * 30 * MIN;
    precheck = checkInPrecheck(memory, facts, board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held } });
    flagged = convergenceMisses(SEP, precheck.steps, precheck, {}, 30 * MIN, now).flagged;
    streaks = flagStreaks(streaks, flagged);
    text = checkInPrecheckText(precheck, facts, flagged, now, streaks);
    memory = precheck.memory;
  }
  return { text, streaks: streaks!, flagged, precheck: precheck! };
}

test("p124, held on the offline Mac, reads host_held and stays out of Flagged again", () => {
  const { text, streaks, flagged } = fourRuns();
  assert.deepEqual(flagged.filter(slice => slice.item === "p124").map(slice => slice.kind), ["host_held"]);
  assert.equal(streaks["host_held p124"], 4);
  assert.match(text, /### Held on an offline box[^\n]*\n- p124 /);
  const again = text.split("### ").find(part => part.startsWith("Flagged again")) ?? "";
  assert.doesNotMatch(again, /host_held/);
});

test("p125, whose wait is the release owner's prod promote, reads by that wait and not host_held", () => {
  const { flagged, precheck } = fourRuns();
  assert.ok(!flagged.some(slice => slice.item === "p125" && slice.kind === "host_held"), flagged.map(slice => `${slice.kind} ${slice.item}`).join(", "));
  const entry = precheck.end.find(found => found.view.item.id === "p125")!;
  assert.equal(entry.state, "release");
  assert.equal(entry.hold, undefined);
  assert.match(entry.reason, /a land, promote or release.*runs on mac, offline on Tailscale/);
});
