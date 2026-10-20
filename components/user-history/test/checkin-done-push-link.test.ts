// mac-management 10-20 10:49Z: the check-in flagged p24 as finished_open because checkin/goal_gaps had met on every run since 01:00Z, while
// p24's own number, hours in band on us-metal02, read 0 of 2. A checkin/* link tags a push step and is no metric the step fixes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { looksDone, metricFacts } from "../src/checkin-done.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { PlanItem } from "../src/shared/types.ts";

const start = Date.parse("2026-10-20T00:00:00Z");
const run = (duty: string, key: string, minutes: number, value: number): DutyRunRecord => ({ duty, at: start + minutes * 60_000, trigger: "schedule",
  ms: 1000, verdict: value <= 0 ? "met" : "missed", summary: "", metrics: { [key]: { value, target: 0, op: "<=", met: value <= 0 } } } as DutyRunRecord);
const series = (duty: string, key: string) => [2, ...Array<number>(40).fill(0)].map((value, index) => run(duty, key, index * 15, value));
const runs = [...series("checkin", "goal_gaps"), ...series("checkin", "stuck_steps"), ...series("d7", "queue_holds_30")].sort((a, b) => b.at - a.at);
const facts = { metrics: metricFacts(runs), prs: new Map() };
const p24: Pick<PlanItem, "id" | "status" | "text" | "duty" | "note"> = { id: "p24", status: "doing", duty: "checkin/goal_gaps",
  text: "Tune the 60-slot metal queue by hand to 70 to 80% CPU and cut the queue features nobody uses",
  note: "Done when metal holds 70 to 80% CPU for 2 hours with no memory stall at a slot count set by hand. Slots are 22 since about 08:00Z." };

test("a push step's checkin/goal_gaps link does not make it look done", () => {
  assert.equal(facts.metrics.get("checkin/goal_gaps")?.met, true, "goal_gaps held for 10 h after a miss");
  assert.equal(looksDone(p24, facts), null);
});

test("no other checkin/* link makes a step look done", () => {
  assert.equal(looksDone({ ...p24, duty: "checkin/stuck_steps" }, facts), null);
});

test("a real duty metric the step links still closes it once held", () => {
  assert.match(looksDone({ ...p24, duty: "d7/queue_holds_30" }, facts)?.reason ?? "", /its metric d7\/queue_holds_30 has met on every run since 10-20 00:15Z, its 2 h hold window/);
});
