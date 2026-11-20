// 11-20: c230 ("NEVER EVER FUCKING RUN WITHOUT PROXY JUST STOP FOR NOW") stopped every crawl until the owner picks a proxy and forbade a
// re-ask, so no For you todo may hold the crawl-dependent fixes. Crawler VP's d7 meta_walk_age_min stayed red, and d9 read it as a stuck duty
// with no live fix job and pushed the chat to start the fix job c230 forbids. A blocked fix step whose note says c230 parks it holds the metric.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import { dutyHold } from "../src/shared/todo-hold.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const at = (clock: string) => Date.parse(`2026-11-20T${clock}Z`);
const age = (value: number): MetricResult => ({ value, target: 90, op: "<=", met: value <= 90 });
const run: DutyRunRecord = { duty: "d7", at: at("10:40:00"), trigger: "schedule", ms: 4_000, verdict: "missed", summary: "", metrics: { meta_walk_age_min: age(2_880) } };
const parked: PlanItem = { id: "p1240", text: "The Meta Ads walk runs again within 90 min", status: "blocked", children: [], duty: "d7/meta_walk_age_min",
  note: "Parked by c230 until the owner picks a proxy. Done when meta_walk_age_min reads <= 90 on a run after the proxy is back." };
const board = (item: PlanItem): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-11-20T10:50:00Z", plan: [item], todos: [] });
const inputs = (item: PlanItem): PlanInputs => ({ now: at("10:54:00"),
  chats: [{ id: CRAWLER, name: "Crawler VP", runs: [run], duties: [{ id: "d7", name: "Meta Ads crawl" }], everyMs: 60 * 60_000 }],
  boards: new Map([[CRAWLER, board(item)]]), ownerActivity: new Map(), waking: new Set(), poolWaiting: new Set(), named: new Map() });

test("a red metric whose blocked fix step c230 parks waits on the owner and is no stuck duty", () => {
  const counts = planCounts(inputs(parked));
  assert.equal(counts.redDuties.length, 0);
  assert.deepEqual(counts.ownerHeld.map(entry => entry.line),
    ["Crawler VP: Meta Ads crawl (d7) meta_walk_age_min waits on the owner (p1240 on the owner's correction c230, which parks it), so it owes no fix job"]);
});

test("a parked step holds only while blocked, parked in its note and under a correction in force", () => {
  assert.equal(planCounts(inputs({ ...parked, status: "todo" })).redDuties.length, 1);
  assert.equal(planCounts(inputs({ ...parked, note: "Waits for a proxy (c230)." })).redDuties.length, 1);
  assert.equal(dutyHold("d7", ["meta_walk_age_min"], board(parked), new Set(["c37"])), undefined);
  assert.equal(dutyHold("d7", ["meta_walk_age_min"], board(parked), new Set(["c230"])), "p1240 on the owner's correction c230, which parks it");
});
