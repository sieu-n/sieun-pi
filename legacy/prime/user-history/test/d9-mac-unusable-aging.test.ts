// Guards d9's read of ops guy d1 at 07:14Z on 10-28. mac_unusable_min held 14 red Mac minutes, the newest at 03:13Z, after ops guy's fixes
// (p568, cbef1e9c) left every later minute usable, and d9 counted d1 as a stuck duty with no live fix, because the d1 precheck gave no
// lastEventAt or windowMs for that count. The runs here are d1's own: the 06:23Z push run as it was recorded, and a run with today's precheck.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { measureMac } from "../scripts/duties/local-dev-uptime.ts";
import { agingSince, agingUntil } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const at = (time: string) => Date.parse(`2026-10-28T${time}Z`);
const now = at("07:30:00");
const line = (time: number, kernelTaskPct: number): WatchLine => ({ host: "us-metal02", at: new Date(time).toISOString(), usable: null, workers: 0, workerGb: 0, top: [],
  hosts: [{ name: "mac", usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct }, workers: 0, workerGb: 0, top: [] }] } as unknown as WatchLine);
const red = Array.from({ length: 14 }, (_, i) => line(at("03:00:30") + i * 60_000, 120));
const usable = Array.from({ length: 250 }, (_, i) => line(at("03:14:30") + i * 60_000, 30));
const metrics = (JSON.parse(readFileSync(new URL("../scripts/duties/local-dev-uptime.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] }).metrics;
const port = (n: number) => `port ${n} 200\n`;
const macReading = `{ 3.10 3.00 3.00 }\nSystem-wide memory free percentage: 40%\n${[5174, 5180, 8791, 8787].map(port).join("")}`;

const earlier: DutyRunRecord = { duty: "d1", at: at("06:23:17"), trigger: "push", ms: 1, verdict: "missed", summary: "",
  metrics: { servers_not_answering: { value: 0, target: 0, op: "<=", met: true }, mac_unusable_min: { value: 14, target: 0, op: "<=", met: false } } } as DutyRunRecord;

async function newestRun(): Promise<DutyRunRecord> {
  const mac = await measureMac({ platform: "linux", exec: async () => macReading, wait: async () => {}, watch: async () => [...red, ...usable] }, now);
  const { metrics: macMetrics, flagged: _flagged, ...windows } = mac;
  const judged = judge(metrics, { metrics: { servers_not_answering: 0, store_box_swap_used_mb: 1000, ...macMetrics }, ...windows });
  return { duty: "d1", at: now, trigger: "push", ms: 1, ...judged } as DutyRunRecord;
}

test("d1 red only on 14 old Mac minutes reads as aging until the newest one leaves the 24 h window, and is no stuck duty", async () => {
  const runs = [await newestRun(), earlier];
  assert.equal(runs[0]!.verdict, "missed");
  assert.equal(runs[0]!.metrics.mac_unusable_min!.value, 14);
  assert.equal(agingSince(runs), at("03:13:30"));
  assert.equal(agingUntil(runs), at("03:13:30") + 86_400_000);
  const board = { v: 2, rev: 1, updatedAt: "2026-10-28T07:00:00Z", todos: [], plan: [] } as unknown as ChatBoard;
  const input = { now, chats: [{ id: CHAT, name: "ops guy (+observability)", runs, everyMs: 900_000, paused: false, duties: [{ id: "d1", name: "Local dev servers" }] }],
    boards: new Map([[CHAT, board]]), ownerActivity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(),
    named: new Map<string, Map<string, string[]>>() } as unknown as PlanInputs;
  assert.deepEqual(planCounts(input).redDuties, []);
});
