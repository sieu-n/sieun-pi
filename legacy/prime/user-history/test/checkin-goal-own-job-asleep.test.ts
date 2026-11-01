// ops guy (01a11af8) on 11-01: its goal p544 "Cut us-metal01's CPU waits under 35% of each 30 minutes" has its own job thread "metal01 cpu
// cuts" (01a15eeb) and one open step under it, p677, whose job "obs clickhouse query cost" had reported. The thread slept on a board.wake at
// 19:20Z and waited for a working slot, and goal_gaps read p544 "no live job owns it" in 5 check-ins in a row up to 19:03Z: goalOwner read only
// leaf steps, and a goal with open steps under it is no leaf. It now reads the goal's own job with d9's liveness (`ownerMoves`, `hostHeld`).
// The fixture is p544 as the board held it at 19:20Z.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses, type BoardFindings, type CheckInContext } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import { goalGap } from "../src/checkin-goals.ts";
import { jobFacts, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { row } from "./chats-helpers.ts";

const NOW = Date.parse("2026-11-01T19:03:02.379Z");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const CUTS = "01a15eeb-592f-71db-a938-8fd43588213b";
const QUERY = "01a19692-bc8f-7777-993c-4c9029abfad1";
const board = (): ChatBoard => JSON.parse(readFileSync(new URL("./fixtures/ops-board-p544-1101.json", import.meta.url), "utf8")) as ChatBoard;
const memory = { at: NOW - 2 * 60 * 60_000, steps: {}, goals: { p544: { still: 0, readings: [{ value: 50, at: 1793463120000, basis: "cpu_pressure_worst_30m_pct|%|<=" },
  { value: 56, at: 1793526300000, basis: "cpu_pressure_worst_30m_pct|%|<=" }, { value: 51, at: 1793534400000, basis: "cpu_pressure_worst_30m_pct|%|<=" }] } } };
const POOL = "Failed to resolve API key for provider \"anthropic\" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token pi-pool: this session " +
  "waits for its slot at 2026-11-01T20:10:00.000Z. Try again in 67 minutes.";

/** The two threads as gather reads them, p677's job ended, with the goal's own thread changed by `cuts`. */
function facts(cuts: Partial<JobFact>, host?: string): JobFact[] {
  const rows = [row(CUTS, "2026-11-01T19:02:00Z", { name: "metal01 cpu cuts", ...host ? { host } : {} }), row(QUERY, "2026-11-01T18:08:00Z", { name: "obs clickhouse query cost" })];
  return jobFacts([], board(), rows, CHAT).map(fact => fact.key === `thread:${CUTS}` ? { ...fact, ...cuts } : { ...fact, state: "ended" });
}
function p544(cuts: Partial<JobFact>, context: CheckInContext = {}) {
  const precheck = checkInPrecheck(memory as never, facts(cuts, context.hosts ? "mac" : undefined), board(), NOW, { self: [CHAT, "ops guy"], ...context });
  const findings: BoardFindings = { ...precheck, waitsMet: [], noProgress: null, stale: [], fold: [] } as never;
  const { metrics } = convergenceMisses(CHAT, precheck.steps, findings, {}, 2 * 60 * 60_000, NOW);
  return { push: precheck.goals.find(push => push.goal.id === "p544")!, gaps: metrics.goal_gaps };
}

test("the goal's own job thread asleep on a board.wake owns the goal", () => {
  const { push, gaps } = p544({ state: "working", wake: "a board.wake at 19:20Z" });
  assert.equal(push.owner?.name, "metal01 cpu cuts");
  assert.equal(push.act, "steer");
  assert.equal(goalGap(push), false);
  assert.equal(gaps, 0);
});

test("the goal's own job thread waiting for its pi-pool slot owns the goal and waits for that slot", () => {
  const { push, gaps } = p544({ state: "ended", error: POOL });
  assert.equal(push.owner?.name, "metal01 cpu cuts");
  assert.equal(push.act, "waiting");
  assert.equal(gaps, 0);
});

test("the goal's own job thread on an offline box holds the goal there, as d9 reads a step on that box", () => {
  const hosts = { chatHost: "us-metal02", held: new Map([["mac", { host: "mac", lastSeen: "2026-11-01T18:40:00Z" }]]) };
  const rows = [row(CUTS, "2026-11-01T18:39:00Z", { name: "metal01 cpu cuts", host: "mac" })];
  const { push, gaps } = p544({ state: "ended" }, { rows, hosts });
  assert.equal(push.act, "waiting");
  assert.match(push.waits ?? "", /metal01 cpu cuts.*mac, offline on Tailscale since 18:40Z/);
  assert.equal(gaps, 0);
  const [view] = checkInPrecheck(memory as never, facts({ state: "ended" }, "mac"), board(), NOW, { self: [CHAT, "ops guy"], rows, hosts }).steps;
  assert.equal(endState({ ...view!, owner: facts({ state: "ended" }, "mac").find(fact => fact.key === `thread:${CUTS}`) }, [], rows, new Set([CHAT]), NOW, [], { hosts }).state, "host");
});

test("a goal whose own job and step job both ended is still a gap", () => {
  const { push, gaps } = p544({ state: "ended" });
  assert.equal(push.owner, undefined);
  assert.equal(push.act, "start");
  assert.equal(gaps, 1);
});
