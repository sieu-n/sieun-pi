import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * frontend bro's real board (chat 01a11ba8, 2026-10-12 23:21Z) and p100's and p101's real changes from 20:58Z. At 21:54Z both wait for "Fable's
 * land-33 hold until about 00:15Z, then reruns ... under their same ids", and the 23:03Z and 23:18Z check-ins flagged both as blocked_on_others
 * "on land", though the hold has a live owner and a planned end.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const BOARD = JSON.parse(readFileSync(new URL("./fixtures/frontend-bro-p100-board.json", import.meta.url), "utf8")) as ChatBoard;
type Step = { [K in "waitFor" | "waitUntil" | "note"]?: PlanItem[K] | undefined };
/** The chat_board updates of p100 and p101, verbatim from the chat's session file. */
const EVENTS: [string, "p100" | "p101", Step][] = [
  ["2026-10-12T20:58:43.683Z", "p100", { waitFor: "run 38302193210 (r12), then run 38307619796 (r13), both behind the land-33 set in Fable's reorder", note: "r12 has 16 layers. r13 sits on top with Email, the keep-worlds fix and the Inbox names fix. Scoped svelte-check is 0 errors after 2 real errors in the Email send API were fixed, and vitest passes 37 of 37. Runs: https://github.com/sieu-n/auto-sns-agent/actions/runs/38302193210 and https://github.com/sieu-n/auto-sns-agent/actions/runs/38307619796. The job puts r12's 16 layers on the dev branch, then r13's 3, as each goes green." }],
  ["2026-10-12T21:20:27.747Z", "p101", { waitFor: "run 38300673560 attempt 3 on ci/save-contact-button-r3", note: "The reorder cancelled the run at 20:59Z before its checks ran, and Fable reran it under the same id as attempt 3 at 21:12Z, behind the land-33 set. The job reads it once at about 22:30Z, puts it on the dev branch when it's green, and reports the tip sha. Run: https://github.com/sieu-n/auto-sns-agent/actions/runs/38300673560" }],
  ["2026-10-12T21:35:34.857Z", "p101", { waitFor: "run 38300673560 attempt 4 on ci/save-contact-button-r3", note: "Requeued as attempt 4 at 21:22Z, and still queued at 21:34Z while the VP of CI clears a queue of 146 runs with land 33 first. The job puts it on the dev branch when it's green and reports the tip sha. Run: https://github.com/sieu-n/auto-sns-agent/actions/runs/38300673560" }],
  ["2026-10-12T21:50:45.000Z", "p100", { note: "Both runs are still queued at 06:49 KST. r12 hasn't started, and r13 passed its first two steps with the rest queued. The VP of CI reports every run is waiting on runners and none has failed. The job reads r13 once more at about 07:08 KST and puts the layers on the dev branch as each run goes green. Runs: https://github.com/sieu-n/auto-sns-agent/actions/runs/38302193210 and https://github.com/sieu-n/auto-sns-agent/actions/runs/38307619796" }],
  ["2026-10-12T21:50:45.000Z", "p101", { note: "Attempt 4 is still queued at 06:49 KST, with no step started, behind the runner queue the VP of CI is clearing. The job reads it once at 07:30 KST, puts it on the dev branch if it's green, and reports the tip sha. Run: https://github.com/sieu-n/auto-sns-agent/actions/runs/38300673560" }],
  ["2026-10-12T21:54:08.895Z", "p100", { waitFor: "Fable's land-33 hold until about 00:15Z, then reruns of r12 and r13 under their same ids", waitUntil: "2026-10-13T01:30:00.000Z", note: "Fable holds every run outside land 33 from 21:53Z until about 00:15Z (00:30Z at the latest), then reruns them under their same ids, oldest first. Nothing is lost, and no re-push is needed. The job reads r13 once after 00:45Z and puts the layers on the dev branch as each run goes green. Runs: https://github.com/sieu-n/auto-sns-agent/actions/runs/38302193210 and https://github.com/sieu-n/auto-sns-agent/actions/runs/38307619796" }],
  ["2026-10-12T21:54:08.895Z", "p101", { waitFor: "Fable's land-33 hold until about 00:15Z, then a rerun of 38300673560 under its same id", waitUntil: "2026-10-13T01:30:00.000Z", note: "Held by Fable's land-33 hold from 21:53Z until about 00:15Z, then rerun under the same id. The job reads it once after 00:45Z, puts it on the dev branch if it's green, and reports the tip sha. Run: https://github.com/sieu-n/auto-sns-agent/actions/runs/38300673560" }],
  ["2026-10-12T23:05:47.623Z", "p100", { note: "Held by the VP of CI's land-33 hold. At 23:00Z, 7 of 10 jobs on the land-33 base run were green, and Fable reruns the held runs after it, at about 00:15Z to 00:30Z. r12 is queued and r13 shows cancelled until that rerun. The job's one read of r13 fires at 00:50Z, and it puts the 19 layers on the dev branch when green." }],
  ["2026-10-12T23:05:47.623Z", "p101", { note: "Held by the VP of CI's land-33 hold. Fable reruns run 38300673560 under the same id after the land-33 base run, at about 00:15Z to 00:30Z. The job's one read fires at 00:50Z. It puts the fix on the dev branch if green and reports the sha." }],
];
/** The chat's real check-in slots from 21:48Z to 23:18Z, then 01:00Z, past the hold's 00:15Z end plus the grace. */
const SLOTS = ["2026-10-12T21:48:12Z", "2026-10-12T22:03:20Z", "2026-10-12T22:18:20Z", "2026-10-12T22:33:22Z", "2026-10-12T22:48:22Z", "2026-10-12T23:03:44Z",
  "2026-10-12T23:18:54Z", "2026-10-13T01:00:00Z"];

const withSteps = (items: PlanItem[], steps: Record<string, Step>): PlanItem[] => items.map(item => {
  const children = withSteps(item.children, steps);
  const step = steps[item.id];
  if (!step) return { ...item, children };
  const { waitFor: _f, waitUntil: _u, note: _n, ...rest } = item;
  return Object.fromEntries(Object.entries({ ...rest, ...step, children }).filter(([, value]) => value !== undefined)) as unknown as PlanItem;
});

test("frontend bro p100 and p101: a wait parked until a named end is not blocked_on_others until that end plus the grace passes", () => {
  let memory: CheckInMemory | undefined;
  const lines = SLOTS.map(slot => {
    const now = Date.parse(slot);
    const steps: Record<string, Step> = {};
    for (const [at, id, change] of EVENTS) if (Date.parse(at) <= now) steps[id] = { ...steps[id], ...change };
    const board: ChatBoard = { ...BOARD, updatedAt: new Date(now).toISOString(), plan: withSteps(BOARD.plan, steps) };
    const precheck = checkInPrecheck(memory, [], board, now, { self: [CHAT, "frontend bro"], rows: [] });
    memory = precheck.memory;
    const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * 60_000, now);
    return `${slot.slice(11, 16)} ${flagged.filter(slice => slice.kind === "blocked_on_others" && ["p100", "p101"].includes(slice.item ?? "")).map(slice => slice.item).join(" ")}`.trim();
  });
  assert.deepEqual(lines, ["21:48", "22:03", "22:18", "22:33", "22:48", "23:03", "23:18", "01:00 p100 p101"],
    "the hold ends about 00:15Z, so both are parked on schedule until 00:45Z, and at 01:00Z they flag as before");
});
