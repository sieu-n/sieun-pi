import assert from "node:assert/strict";
import { test } from "node:test";
import { endState } from "../src/checkin-end-state.ts";
import { type JobFact, stepView } from "../src/checkin-steps.ts";
import { FleetBudget, startsOf } from "../src/fleet-budget.ts";
import type { PlanItem } from "../src/shared/types.ts";

/**
 * 10-15 18:55Z to 20:58Z (service.log): the fleet budget opened for one start at a time while check-ins, fix jobs and send-backs kept asking,
 * so a start always waited, and every job's due wake asked `tryAdmit`, which refuses while any start waits. It held the wakes of 38 jobs
 * 3,374 times and delivered none. census canary run (01a12faa) set wakes for 19:20Z, 19:24Z and 19:44Z and slept through all of them, and the
 * Crawler VP check-in read its steps p252 and p528 as job_ended.
 */
const CENSUS = "01a12faa-591f-751e-b070-756c5697072e";
const clock = () => {
  let now = Date.UTC(2026, 9, 15, 19, 20, 10);
  return { now: () => now, sleep: async (ms: number) => { now += ms; await new Promise(resolve => setImmediate(resolve)); } };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

/** One read lets one start through at 15.5 GB (the next projects 16.22 GB); two new starts ask every 30 s tick, as the check-ins did. */
async function replay(ask: (budget: FleetBudget) => Promise<(() => void) | null>): Promise<number | null> {
  const time = clock();
  const budget = new FleetBudget({ gb: async () => 15.5, live: async () => false, log: () => {}, readMs: 15_000, ...time });
  let fix = 0;
  const more = () => { for (let i = 0; i < 2; i++) { fix++; void budget.admit({ kind: "fix", chat: `chat ${fix}`, label: `fix ${fix}` }).then(done => done(`s${fix}`)); } };
  more();
  await settle();
  for (let tick = 1; tick <= 40; tick++) {
    more();
    const done = await ask(budget);
    if (done) { done(); budget.stop(); return tick; }
    await time.sleep(30_000);
    await settle();
  }
  budget.stop();
  return null;
}

test("a due wake that only asks tryAdmit never goes while starts keep asking", async () => {
  assert.equal(await replay(budget => budget.tryAdmit({ kind: "wake", label: CENSUS })), null);
});

test("a due wake with a place in line goes once the starts that asked before it went", async () => {
  const tick = await replay(budget => budget.place({ kind: "wake", label: CENSUS }));
  assert.notEqual(tick, null, "the wake went within 40 ticks");
  assert.ok(tick! <= 10, `went at tick ${tick}`);
});

test("a wake's place shows in the waiting list for every chat, and it is granted once", async () => {
  const time = clock();
  let gb = 17.0;
  const budget = new FleetBudget({ gb: async () => gb, live: async () => false, log: () => {}, readMs: 15_000, ...time });
  assert.equal(await budget.place({ kind: "wake", label: CENSUS }), null);
  assert.deepEqual(startsOf(budget.queued(), "01a115e2-9544-7204-b8db-8ce4d5319048"), [CENSUS]);
  assert.equal(await budget.place({ kind: "wake", label: CENSUS }), null, "still in line");
  assert.equal(budget.queued().length, 1, "a second ask keeps the one place");
  gb = 8.0;
  await time.sleep(15_000);
  await settle();
  const done = await budget.place({ kind: "wake", label: CENSUS });
  assert.notEqual(done, null);
  assert.equal(budget.queued().length, 0);
  budget.stop();
});

const NOW = Date.parse("2026-10-15T20:55:00Z");
const self = new Set(["01a115e2-9544-7204-b8db-8ce4d5319048", "Crawler VP"]);
const p252: PlanItem = { id: "p252", text: "Raise census crawl slots past 768", status: "doing", children: [], job: "census canary run", sessionId: CENSUS };
const facts: JobFact[] = [{ key: "sub-census", name: "census canary run", state: "ended", activityAt: NOW - 79 * 60_000 }];

test("end state: a step whose owner's due wake has its place in the fleet budget is moving", () => {
  const view = stepView(p252, NOW - 90 * 60_000, self, facts, [], [], NOW);
  assert.equal(endState(view, [], [], self, NOW, facts).state, "job_ended");
  const moving = endState(view, [], [], self, NOW, facts, { starting: new Set([CENSUS]) });
  assert.equal(moving.state, "moving");
  assert.equal(moving.reason, "its owner census canary run has a due wake in the fleet budget's line");
});
