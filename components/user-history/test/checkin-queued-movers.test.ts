import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import { stalledSteps } from "../src/checkin-findings.ts";
import { type JobFact, type StepMemo, stepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * launch main bro's steps at 10-15 20:03Z, trimmed to the fields the rules read. pi-pool's queue (fixtures/pi-pool-queue-1015-2003.json) held
 * the turns of watchlist last fixes (01a140fc-ba32, 16th, 418 s) and g2g accounts setup (01a140fc-af16), whose facts read ended with no session
 * id. Each such step goes on by itself once a slot comes, so none of them is stuck or stalled.
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const WATCHLIST = "01a140fc-ba32-7228-99c6-b12621a32ffc";
const G2G = "01a140fc-af16-70db-8932-20ae370a989b";
const NOW = Date.parse("2026-10-15T20:03:00Z");
const self = new Set([CHAT, "launch main bro"]);
const step = (id: string, extra: Partial<PlanItem>): PlanItem => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });
const items = {
  p97: step("p97", { job: "watchlist last fixes", sessionId: WATCHLIST,
    waitFor: "p125's null-root resolve fix 6003fcb691 lands and reaches prod; then the 64 first passes settle and the window read repeats" }),
  p103: step("p103", { job: "g2g accounts setup", sessionId: G2G, waitFor: "land 37 and promote 11 carry the no-code fix 9647a17b84, then a prod read-back" }),
  p130: step("p130", { waitFor: "the fleet memory budget admits a start; the check-in retries" }),
};
const facts: JobFact[] = [
  { key: "c-wl", name: "watchlist last fixes", state: "ended", activityAt: NOW - 3 * 3_600_000 },
  { key: "c-g2g", name: "g2g accounts setup", state: "ended", activityAt: NOW - 3 * 3_600_000 },
];
const queued = new Map([[WATCHLIST, { position: 16, total: 47 }], [G2G, { position: 20, total: 47 }]]);
const movers = { queued };
const view = (item: PlanItem) => stepView(item, NOW - 3 * 3_600_000, self, facts, [], [], NOW);

test("end state: a step whose job's turn waits in pi-pool's queue is moving", () => {
  assert.deepEqual(Object.values(items).map(item => [item.id, endState(view(item), [], [], self, NOW, facts, movers).state]),
    [["p97", "moving"], ["p103", "moving"], ["p130", "event"]]);
  assert.equal(endState(view(items.p97), [], [], self, NOW, facts, movers).reason, "its owner watchlist last fixes waits for a working slot in pi-pool's queue");
  assert.deepEqual(Object.values(items).map(item => endState(view(item), [], [], self, NOW, facts).state), ["release", "release", "event"], "no queue given");
});

test("stalled steps: a 3 h wait whose job's turn is queued is not stalled", () => {
  const memos: Record<string, StepMemo> = Object.fromEntries(Object.keys(items).map(id => [id, { sig: id, at: NOW - 3 * 3_600_000, waitAt: NOW - 3 * 3_600_000 }]));
  const stalled = (given = {}) => stalledSteps(Object.values(items).map(view), memos, [], self, NOW, undefined, given).map(entry => entry.view.item.id);
  assert.deepEqual(stalled(), ["p97", "p103", "p130"]);
  assert.deepEqual(stalled(movers), ["p130"]);
});

test("check-in precheck: the queue places reach both counts", () => {
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-10-15T17:00:00.000Z", plan: [step("p0", { text: "Launch", children: Object.values(items) })] };
  const run = checkInPrecheck(undefined, facts, board, NOW, { self: [...self], rows: [], queued });
  assert.deepEqual(run.end.filter(entry => entry.state !== "moving").map(entry => entry.view.item.id), ["p130"]);
});
