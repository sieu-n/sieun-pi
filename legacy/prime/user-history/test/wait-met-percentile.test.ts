// Crawler VP 10-28: p1057 waited for "8236b27bc7 (exact rows) and 2bdb47f274 (cold p95 2.5 s, from 11 s) ride crawler cut 1024; then read
// facemask on prod", and two check-ins flagged it as wait_met, because waitsMet read the latency word p95 as the board's done step p95 while cut
// 1024 was not live. A percentile next to a number and an id after any name word ("cold p95", "cut p1022") are not step ids.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsMet } from "../src/checkin-findings.ts";
import { stepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const now = Date.parse("2026-10-28T06:10:00Z");
const self = new Set([CRAWLER, "Crawler VP"]);
const p95: PlanItem = { id: "p95", text: "Census reads its queue from Postgres", status: "done", children: [] };
const p1022: PlanItem = { id: "p1022", text: "Find the census pg writer root cause", status: "done", children: [] };
const step = (waitFor: string): PlanItem => ({ id: "p1057", text: "Make the ranked widget sums exact", status: "doing", children: [], job: "crawler ops train", waitFor });
const met = (waitFor: string) => {
  const item = step(waitFor);
  const board = { v: 2, rev: 1, updatedAt: "2026-10-28T06:00:00Z", plan: [p95, p1022, item], todos: [] } as unknown as ChatBoard;
  return waitsMet([stepView(item, now - 3_600_000, self, [], [], [], now)], board, [], self).map(({ view, over }) => [view.item.id, over]);
};

test("p1057's wait on cut 1024 is not over because its waitFor names a cold p95 latency", () => {
  assert.deepEqual(met("8236b27bc7 (exact rows) and 2bdb47f274 (cold p95 2.5 s, from 11 s) ride crawler cut 1024; then read facemask on prod (1,255 expected)"), []);
});

test("a percentile next to a number or after a name word is no step id", () => {
  for (const waitFor of ["p95 2.5 s on prod after the deploy", "then p99 under 1 s on staging", "widget p95 at 900ms", "the release (cut p1022) deploys",
    "release p1022 deploys"]) assert.deepEqual(met(waitFor), [], waitFor);
});

test("a real step id in a waitFor still counts, p95 included", () => {
  assert.deepEqual(met("p95 lands, then start"), [["p1057", ["p95 is done"]]]);
  assert.deepEqual(met("p1022 and p95"), [["p1057", ["p1022 is done", "p95 is done"]]]);
  assert.deepEqual(met("the queue move (p95)"), [["p1057", ["p95 is done"]]]);
  assert.deepEqual(met("p95 8236b27bc7 is done"), [["p1057", ["p95 is done"]]]);
});
