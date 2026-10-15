import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InterruptedRuns } from "../src/chat-resume.ts";
import { FleetBudget, type FleetAsk, type FleetDone, type FleetKind } from "../src/fleet-budget.ts";
import { parkTick, type Parked } from "../src/queue-park.ts";
import type { InterruptedRun } from "../src/shared/interrupted.ts";

/**
 * 10-15 18:55Z to 20:58Z (service.log): the budget's closed reads (the GB it read, or why it was shut), the times it let a start through, the
 * 43 starts it let through at the time each asked, and the 14 jobs the parker parked. A parked job's continue and a cut run's continue asked
 * `tryAdmit`, which refuses while any start waits, and a start always waited: the parker resumed none of the 14.
 */
interface Timeline { from: string; closed: [number, number | string][]; opened: number[]; asks: [number, FleetKind, string][]; parked: number[] }
const log = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/fleet-budget-1015-1855-2058.json"), "utf8")) as Timeline;
const FROM = Date.parse(log.from);
const END_S = 2 * 3600 + 4 * 60;
const STEP_S = 5;

/**
 * The GB the budget reads at second `t`: room for one start (15.5 GB) from 5 s before to 10 s after each logged let-through, else the last
 * GB it logged as shut (a shut for pressure or the stop switch reads as full), and room before its first shut.
 */
function gbAt(t: number): number {
  if (log.opened.some(time => t >= time - 5 && t <= time + 10)) return 15.5;
  let gb = 15.5;
  for (const [time, value] of log.closed) if (time <= t) gb = typeof value === "number" ? value : 99;
  return gb;
}

/** Runs the logged two hours on a clock the replay moves, and calls `tick` once a minute. */
async function replay(tick: (budget: FleetBudget, now: number) => Promise<void>): Promise<void> {
  let now = FROM;
  const timers: { at: number; resolve: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>(resolve => { timers.push({ at: now + ms, resolve }); });
  const budget = new FleetBudget({ gb: async () => gbAt((now - FROM) / 1000), live: async () => false, log: () => {}, now: () => now, sleep });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  let asked = 0;
  for (let t = 0; t <= END_S; t += STEP_S) {
    now = FROM + t * 1000;
    for (const timer of timers.splice(0).filter(timer => timer.at <= now || (timers.push(timer), false))) timer.resolve();
    while (asked < log.asks.length && log.asks[asked]![0] <= t) {
      const [, kind, label] = log.asks[asked++]!;
      void budget.admit({ kind, label }).then(done => done());
    }
    await settle();
    if (t % 60 === 0) { await tick(budget, now); await settle(); }
  }
  budget.stop();
}

const session = (i: number) => `01a14100-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`;
const asTryAdmit = (budget: FleetBudget) => ({ place: (ask: FleetAsk): Promise<FleetDone | null> => budget.tryAdmit(ask) });

async function parkReplay(fleet: (budget: FleetBudget) => { place(ask: FleetAsk): Promise<FleetDone | null> }): Promise<Map<string, number>> {
  const file = join(await mkdtemp(join(tmpdir(), "park-place-")), "queue-parked.json");
  const resumed = new Map<string, number>();
  let added = 0;
  await replay(async (budget, now) => {
    const list = JSON.parse(await readFile(file, "utf8").catch(() => "[]")) as Parked[];
    while (added < log.parked.length && FROM + log.parked[added]! * 1000 <= now) { list.push({ session: session(added), at: FROM + log.parked[added]! * 1000, position: 20 }); added++; }
    await writeFile(file, JSON.stringify(list));
    await parkTick({ file, queue: async () => ({ working: [], queued: [], limit: 12 }), chats: async () => new Set(), abort: async () => {}, unload: async () => {},
      resume: async id => { resumed.set(id, now); }, fleet: fleet(budget), log: () => {}, now: () => now });
  });
  return resumed;
}

test("the 14 jobs parked from 20:08Z to 20:57Z on 10-15 never go back while the continue asks tryAdmit", async () => {
  assert.equal((await parkReplay(asTryAdmit)).size, 0);
});

test("with a place in the fleet budget's line, the parked jobs go back oldest first once the budget opens at 20:46:42Z", async () => {
  const resumed = await parkReplay(budget => budget);
  assert.ok(resumed.size >= 10, `${resumed.size} of 14 went back`);
  assert.deepEqual([...resumed.keys()], Array.from({ length: resumed.size }, (_, i) => session(i)));
  for (const at of resumed.values()) assert.ok(at >= Date.parse("2026-10-15T20:46:42Z"), "nothing goes while the workers hold over 16 GB");
});

/** census canary run's first due wake; the budget had been shut since 19:15:41Z and 6 starts waited. */
const CUT_AT = Date.parse("2026-10-15T19:20:00Z");
const cut = (i: number): InterruptedRun => ({ id: `r${i}`, session_id: session(50 + i), head_session_id: "chat", name: `job ${i}`, reason: "error" } as InterruptedRun);

async function resumeReplay(fleet: (budget: FleetBudget) => Pick<FleetBudget, "place">): Promise<Set<string>> {
  const continued = new Set<string>();
  const pending: InterruptedRun[] = [];
  let now = 0;
  const runs = new InterruptedRuns(async args => {
    if (now >= CUT_AT && !pending.length && !continued.size) pending.push(cut(1), cut(2), cut(3));
    const only = args[args.indexOf("--only") + 1];
    if (args.includes("--only") && only) for (const id of only.split(",")) { continued.add(id); pending.splice(pending.findIndex(run => run.session_id === id), 1); }
    return { paused: [...pending], heads: [], checked_at: "now" } as never;
  });
  await replay(async (budget, at) => { now = at; await runs.resumeJobs(() => true, async () => {}, fleet(budget)); });
  return continued;
}

test("three jobs cut mid-run during the logged two hours get no continue while it asks tryAdmit", async () => {
  assert.equal((await resumeReplay(asTryAdmit)).size, 0);
});

test("with a place in the fleet budget's line, each cut job gets its continue", async () => {
  assert.deepEqual([...await resumeReplay(budget => budget)].sort(), [cut(1), cut(2), cut(3)].map(run => run.session_id).sort());
});
