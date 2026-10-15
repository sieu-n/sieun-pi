import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * slack green guy, check-in 04:55 KST on 10-16 (19:55Z on 10-15): p150 waited for "The owner lifts the stop on background work". The owner's
 * stop ("FIRST KILL EVERYTHING FOR NOW UNTIL EVERYTHING IS FIXED") went off at 19:13:56Z, when fleet-stop.json became
 * fleet-stop.off-20261015T191356Z.json, yet the precheck counted p150 stuck on an event for the second run in a row and never said the wait
 * was over.
 */
const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const NOW = Date.parse("2026-10-15T19:55:00Z");
const LIFTED = Date.parse("2026-10-15T19:13:56Z");
const EVERY = 60 * 60_000;
const p150: PlanItem = { id: "p150", text: "On-topic real visitors who sign up, 28 days in the Visitors become paying users duty reaches at least 2%, from 1.33% on the last run",
  status: "blocked", job: "fix visitors become paying users slack green guy 04:39", duty: "d1/on_topic_visit_to_signup_pct", waitFor: "The owner lifts the stop on background work",
  children: [] };
const board = (waitFor = p150.waitFor): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-15T18:00:00.000Z", todos: [],
  plan: [{ id: "p145", text: "More visitors sign up and finish signing in", status: "doing", children: [{ ...p150, ...(waitFor ? { waitFor } : {}) }] }] });
type Stop = { on: true; why: string } | { on: false; liftedAt?: number };
const run = (stop: Stop | undefined, plan = board()) => {
  const precheck = checkInPrecheck(undefined, [], plan, NOW, { self: [CHAT, "slack green guy"], everyMs: EVERY, ...(stop ? { stop } : {}) });
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, NOW);
  return { precheck, output, text: checkInPrecheckText(precheck, [], output.flagged, NOW) };
};

test("slack green guy p150: a wait for the owner to lift the stop is over once the stop is off, with the time it lifted", () => {
  const { output, text } = run({ on: false, liftedAt: LIFTED });
  const met = output.flagged.filter(slice => slice.kind === "wait_met").map(slice => slice.item);
  assert.deepEqual(met, ["p150"], "the precheck says p150's wait is over");
  const section = text.split("\n\n").find(part => part.startsWith("### Waits that are over")) ?? "";
  assert.match(section, /p150 .* waits for "The owner lifts the stop on background work", and the fleet stop lifted at 2026-10-1\d \d\d:13: the wait is over, act on it now/);
});

test("slack green guy p150: while the stop is on, or when the wait also names other work, the wait is not over", () => {
  assert.equal(run({ on: true, why: "owner 10-16: FIRST KILL EVERYTHING" }).output.metrics.wait_met, 0);
  assert.equal(run({ on: false, liftedAt: LIFTED }, board("The owner lifts the stop on background work, then land 37 is green")).output.metrics.wait_met, 0);
  assert.equal(run(undefined).output.metrics.wait_met, 0, "a check-in that did not read the stop says nothing about it");
  assert.equal(run({ on: false }, board("Fix the daemon stop on restart")).output.metrics.wait_met, 0, "a step about another stop is no wait on the fleet stop");
});

test("readFleetStop: the stop file means on with its why; a moved-aside off file gives the lift time from its stamp", async () => {
  const { readFleetStop } = await import("../src/fleet-budget.ts") as { readFleetStop?: (dir: string) => Promise<unknown> };
  assert.equal(typeof readFleetStop, "function");
  const dir = await mkdtemp(join(tmpdir(), "fleet-stop-read-"));
  assert.deepEqual(await readFleetStop!(dir), { on: false });
  await writeFile(join(dir, "fleet-stop.off-20261015T191356Z.json"), "{}");
  assert.deepEqual(await readFleetStop!(dir), { on: false, liftedAt: LIFTED });
  await writeFile(join(dir, "fleet-stop.json"), JSON.stringify({ why: "owner 10-16 ~04:00 KST: FIRST KILL EVERYTHING FOR NOW UNTIL EVERYTHING IS FIXED" }));
  assert.deepEqual(await readFleetStop!(dir), { on: true, why: "owner 10-16 ~04:00 KST: FIRST KILL EVERYTHING FOR NOW UNTIL EVERYTHING IS FIXED" });
});
