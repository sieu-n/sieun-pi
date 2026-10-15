import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan });
const met = (plan: ChatBoard): string[] => checkInPrecheck(undefined, [], plan, Date.parse("2026-10-13T02:05:00Z"), { self: ["chat"] }).waitsMet.map(({ view }) => view.item.id);

/*
 * Crawler VP 10-13: at 01:49Z p144 got the waitFor below, and the 02:05Z and next check-ins said its wait was over because this board's p8 is
 * done. That p8 is a step on the API portal VP's board, and hold11 still held. Steps from Crawler VP's board, trimmed.
 */
const p144Wait = "hold11 lifts, then the Instagram, Bing, Facebook and YouTube runs rerun green for land 34; the API portal's own p8 " +
  "(parity-crawler-combined-r3) carries LinkedIn and YouTube comments";
const crawler = (waitFor: string, extra: PlanItem[] = []): ChatBoard => board([
  step("p8", "Follow-up: re-apply old-host removal (session_routes accepts only Unlimited hosts)", "done"),
  ...extra,
  step("p144", "Fix: 15 documented /v1 live read routes (Facebook, Instagram, YouTube, LinkedIn, Bing) fail their docs examples on staging with crawler " +
    "errors (bad cursors, stale schemas, null roots, 401/403 blocks, no engage capacity)", "blocked", { job: "live route parity fixes", waitFor,
    waitUntil: "2026-10-13T03:35:00.000Z" }),
]);

test("c45: a step id another board's name or a possessive qualifies is that board's step, not this one's (Crawler VP 10-13: p144 and the API portal's own p8)", () => {
  assert.deepEqual(met(crawler(p144Wait)), [], "the API portal's own p8 is not this board's done p8");
  for (const named of ["Crawler VP's p8", "VP of CI's p8", "its p8", "the API portal board's p8"])
    assert.deepEqual(met(crawler(`${named} is done`)), [], `${named} is another board's step`);
});

test("c45: a wait that also names a hold, a run or a land the board cannot check is not over when its ids are (Crawler VP 10-13: p144 and hold11)", () => {
  assert.deepEqual(met(crawler("p8 is done, hold11 lifts, then the Instagram, Bing, Facebook and YouTube runs rerun green for land 34")), [],
    "p8 is done, but hold11 and the runs for land 34 are not on the board");
  assert.deepEqual(met(crawler("p8 and land 34 on staging")), [], "land 34 is not on the board");
});

test("c45: a wait that names only this board's done steps is still over (Crawler VP 10-13: p144 control)", () => {
  assert.deepEqual(met(crawler("p8 and p140 done", [step("p140", "Fix: Bing live routes", "done")])), ["p144"]);
  assert.deepEqual(met(crawler("this board's p8")), ["p144"], "this board's p8 is this board's");
});
