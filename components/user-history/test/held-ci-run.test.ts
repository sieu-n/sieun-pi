import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * api portal vp's real board (chat 01a1301d, 2026-10-12 22:57Z) and p4's real wait and note changes. Before 21:00Z p4 pushed its own
 * waitUntil once (14:00Z to 14:30Z) and then cleared it; from 21:56Z it waits on verify-dev 38300993175, which Fable's land-33 hold cancelled
 * and Fable's land-34 order reruns. The 22:23Z, 22:38Z and 22:53Z check-ins flagged p4 as stalled_steps for "pushed later 2 times".
 */
const CHAT = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const BOARD = JSON.parse(readFileSync(new URL("./fixtures/api-portal-p4-board.json", import.meta.url), "utf8")) as ChatBoard;
type P4 = { [K in "status" | "waitFor" | "waitUntil" | "note"]?: PlanItem[K] | undefined };
const SEED: [string, P4][] = [
  ["2026-10-12T13:04:32.760Z", { status: "doing", waitFor: "Fable (session 01a0cc5e) announces land 32b on staging; the job then pushes be41666e0 after the p5 guard object",
    waitUntil: "2026-10-12T14:00:00.000Z" }],
  ["2026-10-12T13:19:27.071Z", { waitUntil: "2026-10-12T14:30:00.000Z" }],
  ["2026-10-12T14:25:53.160Z", { waitFor: undefined, waitUntil: undefined, note: "Pushed, CI runs 38262242579 and 38262267914; lands after the sign-in change lands, then proven on staging." }],
  ["2026-10-12T19:57:41.141Z", { waitFor: "runs 38300993175 (verify-dev, ci/staging-ingress-dm-r4) and 38289723712 (metal-deploy-tests, kept), then p5's land" }],
  ["2026-10-12T20:30:59.491Z", { status: "blocked" }],
  ["2026-10-12T20:45:40.517Z", { note: "metal-deploy-tests 38289723712 GREEN: through staging Caddy, all 7 DM routes pass, revoke, DELETE, session-addressed reads and POST on scope paths get 403, /ops/engage/health 404. Still waits on verify-dev 38300993175 and the DM sign-in change's land." }],
];
/** p4's chat_board updates from 21:00Z to 22:57Z, verbatim from the chat's session file. */
const LATE: [string, P4][] = [
  ["2026-10-12T21:36:40.640Z", { note: "Fable retracted the metal-deploy-tests green (38289723712 ran on a runner with a stale bind mount, per the VP of CI's audit). After fix ca9a2d8e48 lands, the job dispatches one fresh metal-deploy-tests run on r4; lands on that green plus verify-dev 38300993175, after the DM sign-in change lands." }],
  ["2026-10-12T21:39:16.040Z", { note: "Fable reinstated the metal-deploy-tests green 38289723712 for this change: the stale files on that runner were other base files, the test mounts the two changed files from a fresh temp path, and all 7 new routes passed. No rebuild. Lands after the DM sign-in change (38300985653), once verify-dev 38300993175 is fully green." }],
  ["2026-10-12T21:44:44.285Z", { waitFor: "verify-dev 38300993175 fully green, then p5's land", note: "Fable accepted the job's evidence at 21:39Z: metal-deploy-tests 38289723712 stands, because the test loads our two files from a fresh temp copy and all 7 new DM routes passed; no r5 rebuild. Lands after p5's DM sign-in change lands and verify-dev 38300993175 (attempt 4, place 64 of 151 queued) is fully green." }],
  ["2026-10-12T21:56:34.475Z", { waitUntil: "2026-10-13T00:50:00.000Z", note: "Evidence stands (metal-deploy-tests 38289723712). verify-dev 38300993175 attempt 4 queued at 21:54Z. Fable's land-33 hold (VP of CI 21:52Z) keeps runs outside land 33 off CI until about 00:15Z, 00:30Z at the latest, then reruns them under the same ids; no re-push. Job reads the run once at 00:45Z; lands after it is fully green and p5's guard is on the tip." }],
  ["2026-10-12T22:29:44.052Z", { note: "verify-dev 38300993175 attempt 4 was cancelled at 21:56Z by Fable's land-33 hold and comes back under the same id with land 34. The check-in asked the VP of CI to rerun the DM guard 38300985653 first and this run right after it. The job's read at 00:45Z is alive." }],
  ["2026-10-12T22:41:17.438Z", { note: "verify-dev 38300993175 attempt 4 cancelled by the land-33 hold; Fable's land-34 order reruns the DM guard 38300985653 first and this run second, when land 33's base runs clear (estimate 23:15-23:30Z, fallback 00:30Z). The job's watchers are alive." }],
  ["2026-10-12T22:56:57.975Z", { note: "Checked 22:55Z: verify-dev 38300993175 attempt 4 still cancelled, not rerun. Fable's land-34 order reruns it second, after the DM guard 38300985653, once land-33 base r8 38309494101 has started every job (r8's lint queued since 21:15:54Z; 29 jobs wait on 4 busy runners). The VP of CI thread owns the queue. The job's 00:45Z watcher is alive." }],
];
/** The chat's real check-in slots: three before 21:00Z, then every check-in from 21:00Z to 22:57Z, then one at 23:23Z with no new change. */
const SLOTS = ["2026-10-12T13:08:42Z", "2026-10-12T13:23:42Z", "2026-10-12T14:38:42Z", "2026-10-12T20:53:42Z", "2026-10-12T21:08:42Z", "2026-10-12T21:23:42Z",
  "2026-10-12T21:38:42Z", "2026-10-12T21:53:42Z", "2026-10-12T22:08:50Z", "2026-10-12T22:23:50Z", "2026-10-12T22:38:52Z", "2026-10-12T22:53:52Z", "2026-10-12T22:57:30Z",
  "2026-10-12T23:23:52Z"];

const withP4 = (items: PlanItem[], p4: P4): PlanItem[] => items.map(item => {
  const children = withP4(item.children, p4);
  if (item.id !== "p4") return { ...item, children };
  const { waitFor: _f, waitUntil: _u, note: _n, ...rest } = item;
  return Object.fromEntries(Object.entries({ ...rest, ...p4, children }).filter(([, value]) => value !== undefined)) as unknown as PlanItem;
});
/** Runs the check-in at every slot on p4's state then, and returns each slot's stalled_steps and blocked_on_others lines for p4. */
const replay = (late: [string, P4][]) => {
  const events = [...SEED, ...late].map(([at, change]) => [Date.parse(at), change] as const);
  let memory: CheckInMemory | undefined;
  return SLOTS.map(slot => {
    const now = Date.parse(slot);
    const p4 = events.filter(([at]) => at <= now).reduce<P4>((state, [, change]) => ({ ...state, ...change }), {});
    const board: ChatBoard = { ...BOARD, updatedAt: new Date(now).toISOString(), plan: withP4(BOARD.plan, p4) };
    const precheck = checkInPrecheck(memory, [], board, now, { self: [CHAT, "api portal vp"], rows: [] });
    memory = precheck.memory;
    const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * 60_000, now);
    return `${slot.slice(11, 16)} ${flagged.filter(slice => slice.item === "p4" && ["stalled_steps", "blocked_on_others"].includes(slice.kind)).map(slice => slice.kind).join(" ")}`.trim();
  });
};

test("api portal vp p4: a CI run another thread holds is blocked_on_others, not stalled_steps; a step that pushes its own waitUntil still stalls", () => {
  assert.deepEqual(replay(LATE), ["13:08", "13:23", "14:38", "20:53", "21:08", "21:23", "21:38", "21:53", "22:08", "22:23", "22:38", "22:53", "22:57",
    "23:23 blocked_on_others"], "Fable's land-33 hold and land-34 order own the delay");
  const pushes: Record<string, string> = { "2026-10-12T22:29:44.052Z": "2026-10-13T01:20:00.000Z", "2026-10-12T22:41:17.438Z": "2026-10-13T01:50:00.000Z" };
  const own = LATE.map(([at, change]): [string, P4] => [at, change.note === undefined ? change :
    { ...change, note: "verify-dev 38300993175 is not green yet; the job reads it again at 00:45Z and moves the wait if it is still red.",
      ...(pushes[at] ? { waitUntil: pushes[at] } : {}) }]);
  assert.deepEqual(replay(own).slice(8), ["22:08", "22:23", "22:38", "22:53 stalled_steps", "22:57 stalled_steps", "23:23 stalled_steps"],
    "with no outside hold named, pushing 00:50Z to 01:20Z to 01:50Z is the chat's own and still stalls");
});
