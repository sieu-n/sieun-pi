import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import { type Train, wakeWatches } from "../src/checkin-load.ts";
import { type JobFact, stepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import type { Wake } from "../src/wakes.ts";

/**
 * Crawler VP's check-in at 10-15 19:10Z, after the daemon restart at 18:53Z left its jobs unlisted, counted 117 stuck steps. 77 belonged to
 * crawler ops train (session 01a13a74), asleep on board.wakes for its probe runs; 29 waited on land 37, whose run 38790378691 the release owner
 * (01a10810) slept on. The items below are real steps from its board (and launch main bro's p114), trimmed to the fields the rule reads; p18 and
 * p253 drop their stored session so the wait alone decides.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const TRAIN_JOB = "01a13a74-4d1b-71b8-b9b4-3dc22a80a2e8";
const RELEASE_OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const NOW = Date.parse("2026-10-15T19:10:47Z");
const self = new Set([CHAT, "Crawler VP"]);
const step = (id: string, extra: Partial<PlanItem>): PlanItem => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });

const items = {
  p46: step("p46", { status: "blocked", job: "crawler ops train", sessionId: TRAIN_JOB,
    waitFor: "land 37 attempt 3 (run 38790378691 at 5137239239, which holds 355c4f6eba) reaches staging, then promote 11 reaches prod" }),
  p340: step("p340", { job: "crawler ops train", waitFor: "p7 b8f70ea7ec's verify-dev 38792131776, mdt 38792129315 and mgb 38792134591 green, then CAS" }),
  p253: step("p253", { status: "todo", job: "crawler ops train", waitFor: "9c8dc6f7f9 (in land 37) reaches prod, then the d2 thread reads the dead-CONNECT cost on prod" }),
  p18: step("p18", { status: "blocked", job: "crawler lab window",
    waitFor: "land 37 on staging (its red has fix d3d933398d in a probe slot); then crawler lab window builds the three bundles on that staging sha" }),
  p114: step("p114", { job: "fix engage reads scale safely", waitFor: "the release owner 01a10810 lands the transition-real-pg.sh lib copy fix (d3d9333), then a probe" }),
  p157: step("p157", { waitFor: "the Mac's fleet budget has room; the check-in then starts job crawler duty fixes (brief ready: p526, then p401, then the limits duty)" }),
  p331: step("p331", { job: "alert land follow through", waitFor: "land 36/37 reach prod" }),
  p177: step("p177", { job: "crawler ops train", waitFor: "land run 38724863673 green at the metal step" }),
};
/** The jobs as the check-in listed them after the restart: ended, with no session id, so `withWakes` could not see their wakes. */
const facts: JobFact[] = [
  { key: "c-train", name: "crawler ops train", state: "ended", activityAt: NOW - 50 * 60_000 },
  { key: "c-lab", name: "crawler lab window", state: "ended", activityAt: NOW - 50 * 60_000 },
];
const wake = (session: string, run: number): Wake => ({ session, on: { kind: "run", run }, note: "", since: NOW - 40 * 60_000 });
const wakes: Wake[] = [wake(RELEASE_OWNER, 38790378691), wake(TRAIN_JOB, 38790499999), wake(TRAIN_JOB, 38792131776), wake(TRAIN_JOB, 38792129315)];
const train: Train = { readAt: NOW, runs: [{ id: "38790378691", key: "37", running: true, conclusion: null, createdAt: NOW - 70 * 60_000, updatedAt: NOW - 60_000 },
  { id: "38724863673", key: "37", running: false, conclusion: "failure", createdAt: NOW - 7 * 3_600_000, updatedAt: NOW - 6 * 3_600_000 }] };
const rows = [{ id: RELEASE_OWNER, name: "Fable", archived: false }];
const end = (item: PlanItem, watched = wakeWatches(wakes, train)) =>
  endState(stepView(item, NOW - 30 * 60_000, self, facts, [], rows, NOW), [], rows, self, NOW, facts, watched);

test("end state: a step whose owner session sleeps on a board.wake, or whose wait names a run, land or thread a session sleeps on, is moving", () => {
  assert.deepEqual(Object.values(items).map(item => [item.id, end(item).state]), [
    ["p46", "moving"], ["p340", "moving"], ["p253", "moving"], ["p18", "moving"], ["p114", "moving"], ["p157", "event"], ["p331", "release"], ["p177", "release"]]);
  assert.equal(end(items.p46).reason, "its owner crawler ops train sleeps on board.wakes on run 38790499999, on run 38792131776 and on run 38792129315");
  assert.equal(end(items.p340).reason, `its wait is on run 38792131776, which 01a13a74 sleeps on (board.wakes on run 38790499999, on run 38792131776 and on run 38792129315)`);
  assert.equal(end(items.p18).reason, "its wait is on land 37, which Fable sleeps on (a board.wake on run 38790378691)");
  assert.equal(end(items.p114).reason, "its wait is on Fable, which sleeps on a board.wake on run 38790378691");
});

test("end state: with no pending wakes the same steps stay stuck, as before", () => {
  assert.deepEqual(Object.values(items).map(item => end(item, new Map()).state),
    ["release", "ci", "release", "release", "release", "event", "release", "release"]);
});

test("check-in precheck: the owed wakes and the CI cache's land runs cut Crawler VP's stuck steps to the three nobody moves", () => {
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-15T18:00:00.000Z", plan: [step("p0", { text: "Crawler release", children: Object.values(items) })] };
  const stuck = (context: Parameters<typeof checkInPrecheck>[4]) =>
    checkInPrecheck(undefined, facts, board, NOW, { self: [...self], rows, ...context }).end.filter(entry => entry.state !== "moving").map(entry => entry.view.item.id);
  assert.deepEqual(stuck({ train }), Object.keys(items), "no wakes given");
  assert.deepEqual(stuck({ train, wakes }), ["p157", "p331", "p177"]);
});
