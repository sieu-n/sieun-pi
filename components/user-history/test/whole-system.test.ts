import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FleetBudget, FLEET_STATE_FILE } from "../src/fleet-budget.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { measure, readLimits, readServiceLog, type Inputs } from "../scripts/duties/whole-system.ts";

// Shapes from service.log and pi-pool.log on 10-15 and 10-16: wakes held by the fleet budget each tick, the fix opener's open and send-back lines,
// and the step scan's notices, which carry no time stamp.
const NOW = Date.parse("2026-10-15T21:40:00.000Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const line = (minutesAgo: number, fields: Partial<WatchLine> = {}): WatchLine => ({ at: at(minutesAgo), usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 },
  workers: 10, workerGb: 8, top: [], live: 20, working: 8, idle15: 0, idleOver: 0, idleTrees: [], finished: 0, finishedTrees: [],
  queue: { working: 8, queued: 0, held: 0, pressure: "ok", oldestWaitS: 0, oldestTree: null }, mac: { swapGb: 4, pressureLevel: 1 }, cpuMs: 50, ...fields }) as WatchLine;
const inputs = (fields: Partial<Inputs>): Inputs => ({ now: NOW, watch: [], log: { holds: [], fixes: [], stepScans: [] }, limits: [], okLimit: 15, waiting: [], parked: [], chats: [], ...fields });

test("held wakes join into one hold per wake, and an untimed step scan line takes the time before it", () => {
  const facts = readServiceLog([
    `${at(40)} wakes: wake 01a10db8 for its time: held by the fleet budget: 49 starts wait for the fleet budget; tried again next tick`,
    `${at(20)} wakes: wake 01a10db8 for its time: held by the fleet budget: 50 starts wait for the fleet budget; tried again next tick`,
    ...[16, 12, 8, 4].map(ago => `${at(ago)} wakes: wake 01a10db8 for its time: held by the fleet budget: 50 starts wait for the fleet budget; tried again next tick`),
    `${at(2)} wakes: wake 01a10db8 for its time, its time: held by the fleet budget: the Prime workers hold 17.6 GB (budget 16 GB); tried again next tick`,
    `${at(3)} fleet budget: duty skills and tools AI harness developer environment 04:30 starts after 900 s`,
    "chat 01a1164b: step scan told the chat p494, p495 have no live owner",
  ]);
  // The 20-minute gap after the first line breaks the hold, so the wake counts from 20 minutes ago.
  assert.deepEqual(facts.holds.map(hold => [hold.what, (NOW - hold.from) / 60_000, (NOW - hold.to) / 60_000]),
    [["wake of 01a10db8", 40, 40], ["wake of 01a10db8", 20, 2], ["duty skills and tools AI harness developer environment 04:30", 18, 3]]);
  assert.deepEqual(facts.stepScans, [{ at: NOW - 3 * 60_000, chat: "01a1164b", steps: ["p494", "p495"] }]);
});

test("a fix job sent back or replaced within 5 minutes of its open is churn; one that worked longer is not", () => {
  const facts = readServiceLog([
    `${at(29)} duty 01a1164b/d4: wiki_problems had no fix step with a live job after 3 or more missed runs; opened fix wiki dream AI harness 05:40`,
    `${at(26)} duty 01a1164b/d4: fix job fix wiki dream AI harness 05:40 ended with p494 still missing; sent it back`,
    `${at(20)} duty 01a11b0b/d1: signups had no fix step with a live job after 3 or more missed runs; opened fix visitors slack green guy 05:50`,
    `${at(18)} duty 01a11b0b/d1: signups had no fix step with a live job after 3 or more missed runs; opened fix visitors slack green guy 05:52`,
    `${at(10)} duty 01a1301d/d1: probe had no fix step with a live job after 3 or more missed runs; opened fix portal stays up 06:00`,
    `${at(1)} duty 01a1301d/d1: fix job fix portal stays up 06:00 ended with p88 still missing; sent it back`,
  ]);
  const output = measure(inputs({ log: facts }));
  assert.equal(output.metrics.fix_churn_30, 2);
  assert.equal(output.metrics.fix_opened_30, 4);
  assert.deepEqual((output.flagged ?? []).filter(item => item.kind === "fix_churn").map(item => item.item), ["fix wiki dream AI harness 05:40", "fix visitors slack green guy 05:50"]);
});

test("a minute is clean only with the Mac usable, no hold over 10 minutes and no turn queued with free slots", () => {
  const watch = Array.from({ length: 30 }, (_, index) => line(29 - index));
  // Minute 5 ago: kernel_task over a core. Minute 3 ago: 4 turns waited 3 min with 7 of 15 slots used. Minute 1 ago: no watch line.
  watch[24] = line(5, { usable: { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 140 } });
  watch[26] = line(3, { queue: { working: 7, queued: 4, held: 0, pressure: "ok", oldestWaitS: 180, oldestTree: "slack green guy" } });
  watch.splice(28, 1);
  const quiet = measure(inputs({ watch }));
  assert.equal(quiet.metrics.clean_min_30, 27);
  assert.equal(quiet.metrics.usable_min_30, 28);
  assert.equal(quiet.metrics.queued_free_slot_min_30, 1);
  // Under the critical limit of 7 the same queue is no fault.
  assert.equal(measure(inputs({ watch, limits: readLimits([JSON.stringify({ ts: "2026-10-16T06:00:00", event: "pressure_level", at: (NOW - 60 * 60_000) / 1000, limit_to: 7 })]) })).metrics.queued_free_slot_min_30, 0);
  // A start waiting since 15 minutes ago dirties the minutes from 5 ago on, and a parked job not resumed for 12 minutes is a second hold.
  const held = measure(inputs({ watch, waiting: [{ kind: "fix", label: "fix wiki dream", since: NOW - 15 * 60_000 }], parked: [{ session: "01a14069-563d", at: NOW - 12 * 60_000 }] }));
  assert.equal(held.metrics.queue_holds_30, 2);
  assert.equal(held.metrics.held_min_30, 6);
  // The three faulty minutes all fall in the held ones.
  assert.equal(held.metrics.clean_min_30, 24);
});

test("stuck steps add up each chat's newest measured check-in", () => {
  const run = (duty: string, minutesAgo: number, verdict: "met" | "missed" | "skipped", stuck: number) => ({ duty, at: NOW - minutesAgo * 60_000, slot: 0, trigger: "schedule", ms: 1, verdict,
    metrics: { stuck_steps: { value: stuck, target: 0, op: "<=", met: stuck === 0 } }, summary: "" }) as unknown as Inputs["chats"][number]["runs"][number];
  const output = measure(inputs({ chats: [
    { id: "a", name: "ops guy", duties: [{ id: "checkin", name: "Check-in" }], runs: [run("checkin", 5, "skipped", 0), run("checkin", 60, "missed", 3)] },
    { id: "b", name: "Crawler VP", duties: [{ id: "checkin", name: "Check-in" }], runs: [run("checkin", 10, "met", 0), run("checkin", 70, "missed", 5)] },
  ] }));
  assert.equal(output.metrics.stuck_steps_all, 3);
});

test("the fleet budget publishes when each waiting start asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whole-system-"));
  try {
    let now = Date.parse("2026-10-15T21:00:00.000Z");
    const budget = new FleetBudget({ gb: async () => 17.6, live: async () => false, log: () => {}, readMs: 60_000, stopFile: join(dir, "fleet-stop.json"),
      now: () => now, sleep: () => new Promise(() => {}) });
    void budget.admit({ kind: "fix", label: "fix wiki dream", chat: "01a1164b" });
    now += 1000;
    await (budget as unknown as { publish(file: string): Promise<void> }).publish(join(dir, FLEET_STATE_FILE));
    const state = JSON.parse(await readFile(join(dir, FLEET_STATE_FILE), "utf8")) as { waiting: { label: string; since: number }[] };
    assert.deepEqual(state.waiting.map(ask => [ask.label, ask.since]), [["fix wiki dream", Date.parse("2026-10-15T21:00:00.000Z")]]);
    budget.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("whole-system.duty.json: a duty every 30 minutes on the owner's words, whose metrics the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/whole-system.duty.json"), "utf8")), "d7", 0);
  assert.deepEqual(duty.schedule, { kind: "every", minutes: 30 });
  assert.match(duty.ownerWords, /reorganize duties have a 30 minute trigger that checks all this$/);
  assert.equal(duty.metrics.find(metric => metric.headline)?.key, "clean_min_30");
  const written = Object.keys(measure(inputs({})).metrics);
  for (const metric of duty.metrics) assert.ok(written.includes(metric.key), metric.key);
});
