// AI harness 10-20: d7/quiet_agent_gb read 10.86 GB at 00:59Z and 5.61 GB at 02:05Z, then 0.59 GB at 02:36Z, and the 03:19Z check-in said to
// close p717 after that one met run. A met metric closes its item only after it held through the item's hold window: the one its Done when
// line names, like p711's 24 h, else 6 h.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_MS, holdWindowMs, looksDone, metricFacts } from "../src/checkin-done.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { PlanItem } from "../src/shared/types.ts";

const start = Date.parse("2026-10-20T00:00:00Z");
const run = (minutes: number, value: number): DutyRunRecord => ({ duty: "d7", at: start + minutes * 60_000, trigger: "schedule", ms: 1000,
  verdict: value <= 5 ? "met" : "missed", summary: "", metrics: { quiet_agent_gb: { value, target: 5, op: "<=", met: value <= 5 } } } as DutyRunRecord);
const runs = (values: number[]) => values.map((value, index) => run(index * 30, value)).reverse();
const p717: Pick<PlanItem, "id" | "status" | "text" | "duty" | "note"> = { id: "p717", status: "doing", text: "Idle agents free their memory", duty: "d7/quiet_agent_gb",
  note: "Per-session reading at 18:08Z: sessions quiet 15 min held 0.07 GB." };
const done = (values: number[], note: string = p717.note ?? "") => looksDone({ ...p717, note }, { metrics: metricFacts(runs(values)), prs: new Map() });

test("the hold window is the one the Done when line names, else 6 h", () => {
  assert.equal(holdWindowMs("Done when the Whole system duty d7 reads queue_holds_30 0 on every run for 24 h, through at least one stretch."), 24 * 60 * 60_000);
  assert.equal(holdWindowMs("Done when d7 reads it on target for 90 minutes. Then close."), 90 * 60_000);
  assert.equal(holdWindowMs("Done when the fix is live with a test and a d7 run reads 5 GB or less through such a stretch."), HOLD_MS);
  assert.equal(holdWindowMs("It held for 3 days last week."), HOLD_MS, "a window outside the Done when line does not count");
  assert.equal(holdWindowMs(undefined), HOLD_MS);
});

test("one met run after a miss is no hold", () => {
  assert.equal(done([10.86, 5.61, 0.59]), null);
  assert.equal(metricFacts(runs([10.86, 5.61, 0.59])).get("d7/quiet_agent_gb")?.metSince, start + 60 * 60_000);
});

test("a metric met on every run for 6 h after a miss looks done", () => {
  const held = [10.86, 5.61, ...Array<number>(13).fill(0.4)];
  assert.match(done(held)?.reason ?? "", /met on every run since 10-20 01:00Z, its 6 h hold window/);
  assert.equal(done(held.slice(0, -1)), null, "5.5 h is short of the window");
});

test("a named window holds the item longer, and a new miss restarts the hold", () => {
  const sixHours = [10.86, ...Array<number>(13).fill(0.4)];
  assert.equal(done(sixHours, "Done when d7 reads it under 5 GB on every run for 24 h."), null);
  assert.ok(done([10.86, ...Array<number>(49).fill(0.4)], "Done when d7 reads it under 5 GB on every run for 24 h."));
  assert.equal(done([10.86, ...Array<number>(12).fill(0.4), 7, 0.4]), null);
});
