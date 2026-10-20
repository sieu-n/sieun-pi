// d7's quiet_agent_gb reads the worst host: on 10-20 at 02:05Z it read 5.61 GB from the Mac's frontend bro worker while us-metal02 read 0.55
// GB, and p717, a us-metal02 goal, took the Mac's number. The precheck's quiet_agent_gb_us_metal02 is a part of that metric: the run keeps it
// next to the counted metrics, the verdict leaves it out, and a goal whose duty names it reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { metricFacts } from "../src/checkin-done.ts";
import { goalNumber } from "../src/checkin-goals.ts";
import { goalReadingOps } from "../src/goal-readings.ts";
import { type DutyMetric, type DutyRunRecord, judge } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const metrics: DutyMetric[] = [
  { key: "quiet_agent_gb", label: "Agent sessions GB once nobody worked", op: "<=", target: 5, unit: " GB", headline: true },
  { key: "clean_min_30", label: "Clean minutes", op: ">=", target: 30, unit: " min" },
];
const output = { metrics: { quiet_agent_gb: 5.61, quiet_agent_gb_us_metal02: 0.55, quiet_agent_gb_mac: 5.61, clean_min_30: 30, usable_min_30_mac: 12 } };
const at = Date.parse("2026-10-20T02:05:54Z");
const p717: PlanItem = { id: "p717", text: "Idle agents free their memory", status: "doing", duty: "d7/quiet_agent_gb_us_metal02", children: [],
  target: { metric: "agent sessions GB on us-metal02 after 15 quiet minutes", target: 5, unit: "GB", current: 5.61, measuredAt: "2026-10-20T02:00:00Z", source: "d7", direction: "down" } };

test("a run keeps each host's part of a metric, and the verdict counts only the metrics", () => {
  const judged = judge(metrics, output);
  assert.equal(judged.verdict, "missed");
  assert.deepEqual(Object.keys(judged.metrics).sort(), ["clean_min_30", "quiet_agent_gb"]);
  assert.deepEqual(judged.parts, { quiet_agent_gb_us_metal02: { value: 0.55, target: 5, op: "<=", met: true }, quiet_agent_gb_mac: { value: 5.61, target: 5, op: "<=", met: false } });
  assert.doesNotMatch(judged.summary, /us_metal02|shape target/);
});

test("a goal that names a host's part reads it, not the worst host", () => {
  const judged = judge(metrics, output);
  const board = { v: 2, rev: 1, updatedAt: "2026-10-20T02:00:00Z", plan: [p717], todos: [] } as unknown as ChatBoard;
  const [op] = goalReadingOps(board, "d7", at, { ...judged.parts, ...judged.metrics });
  assert.equal(op?.op === "plan_update" ? op.target?.current : undefined, 0.55);
  const run = { duty: "d7", at, trigger: "schedule", ms: 1, verdict: judged.verdict, metrics: judged.metrics, parts: judged.parts, summary: judged.summary } as DutyRunRecord;
  const facts = metricFacts([run]);
  assert.equal(facts.get("d7/quiet_agent_gb_us_metal02")?.value, 0.55);
  assert.equal(goalNumber({ ...p717, target: { ...p717.target!, measuredAt: "2026-10-20T01:00:00Z" } }, 30 * 60_000, facts)?.value, 0.55);
});
