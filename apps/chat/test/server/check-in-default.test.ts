/**
 * An agent made with `POST /api/agents` and no check-in setting gets the default check-in the view shows: its first one at its createdAt plus
 * 2 hours, and the next 2 hours after that. A walk's test agent gets none.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/check-in-default.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, CheckInView } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const EVERY = 120 * 60_000;
let s: Running;
let fresh: AgentSummary;
let throwaway: AgentSummary;
const checkIns: { thread: string; at: number }[] = [];
let clock = 0;

before(async () => {
  s = await start({ wordMs: 0 });
  fresh = (await s.send("POST", "/api/agents", { name: "fresh agent" })).body;
  throwaway = (await s.send("POST", "/api/agents", { name: "walk throwaway", test: true })).body;
  assert.ok(s.host instanceof FixtureHost);
  s.host.beforeSubmit = (thread, input) => {
    if (input.requestId?.startsWith("checkin:")) checkIns.push({ thread, at: clock });
  };
  for (const agent of [fresh, throwaway]) await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
});
after(async () => {
  await s.close();
});

const tick = async (at: number) => {
  clock = at;
  await s.app.boards.tick(at);
};
const of = (agent: AgentSummary) => checkIns.filter(c => c.thread === agent.thread).map(c => c.at);

test("a fresh agent's first check-in comes at its createdAt plus the interval, as its check-in view says", async () => {
  const createdAt = s.app.agents.record(fresh.id)!.createdAt;
  const view = await s.get<CheckInView>(`/api/agents/${fresh.id}/check-in`);
  assert.equal(view.nextAt, createdAt + EVERY);
  await tick(createdAt + EVERY - 1);
  assert.deepEqual(of(fresh), []);
  await tick(createdAt + EVERY);
  assert.deepEqual(of(fresh), [createdAt + EVERY]);
  assert.equal((await s.get<CheckInView>(`/api/agents/${fresh.id}/check-in`)).nextAt, createdAt + 2 * EVERY);
  await until(async () => s.app.threads.thread(fresh.thread)?.status, status => status !== "running");
  await tick(createdAt + 2 * EVERY - 1);
  await tick(createdAt + 2 * EVERY);
  assert.deepEqual(of(fresh), [createdAt + EVERY, createdAt + 2 * EVERY]);
});

test("a job that runs in the agent's work thread does not hold back its check-in, and a turn of its own does", async () => {
  const createdAt = s.app.agents.record(fresh.id)!.createdAt;
  const host = s.host as FixtureHost;
  const thread = host.threadsById.get(fresh.thread)!;
  host.addChild(thread, 1, "a long job", createdAt, "running");
  thread.row.status = "running";
  await s.app.threads.refresh();
  await tick(createdAt + 3 * EVERY);
  assert.deepEqual(of(fresh).at(-1), createdAt + 3 * EVERY);
  thread.nodes[0]!.status = "running";
  await s.app.threads.refresh();
  await tick(createdAt + 5 * EVERY);
  assert.deepEqual(of(fresh).at(-1), createdAt + 3 * EVERY);
});

test("a walk's test agent gets no check-in and its view shows none scheduled", async () => {
  const createdAt = s.app.agents.record(throwaway.id)!.createdAt;
  await tick(createdAt + 10 * EVERY);
  assert.deepEqual(of(throwaway), []);
  assert.equal((await s.get<CheckInView>(`/api/agents/${throwaway.id}/check-in`)).nextAt, null);
});
