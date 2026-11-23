/**
 * An agent made with `POST /api/agents` and no check-in setting gets the default check-in the view shows: its first one at its createdAt plus
 * 2 hours, and the next 2 hours after that, each one a check-in job of its own (server/check-in-job.ts). The work thread's own turn holds no
 * check-in back, since the check-in no longer runs there. A walk's test agent gets none.
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
/** Each check-in job's brief, by the agent it names in its request id `checkin:<agent>:<at>`. */
const checkIns: { agent: string; at: number }[] = [];

before(async () => {
  s = await start({ wordMs: 0 });
  fresh = (await s.send("POST", "/api/agents", { name: "fresh agent" })).body;
  throwaway = (await s.send("POST", "/api/agents", { name: "walk throwaway", test: true })).body;
  assert.ok(s.host instanceof FixtureHost);
  s.host.beforeSubmit = (_thread, input) => {
    const match = /^checkin:(.+):(\d+)$/.exec(input.requestId ?? "");
    if (match) checkIns.push({ agent: match[1]!, at: Number(match[2]) });
  };
  for (const agent of [fresh, throwaway]) {
    await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
    await s.app.boards.apply(agent.id, [{ op: "plan_add", text: "Ship the relay" }], "agent");
  }
});
after(async () => {
  await s.close();
});

const of = (agent: AgentSummary) => checkIns.filter(c => c.agent === agent.id).map(c => c.at);
/** Waits until the last check-in job reported, so the next check-in does not skip behind it. */
const reported = (agent: AgentSummary) => until(async () => s.app.boards.dutyFile(agent.id).checkIn?.job?.reported, done => done === true);

test("a fresh agent's first check-in job comes at its createdAt plus the interval, as its check-in view says", async () => {
  const createdAt = s.app.agents.record(fresh.id)!.createdAt;
  const view = await s.get<CheckInView>(`/api/agents/${fresh.id}/check-in`);
  assert.equal(view.nextAt, createdAt + EVERY);
  await s.app.boards.tick(createdAt + EVERY - 1);
  assert.deepEqual(of(fresh), []);
  await s.app.boards.tick(createdAt + EVERY);
  await until(async () => of(fresh), list => list.length === 1);
  assert.deepEqual(of(fresh), [createdAt + EVERY]);
  assert.equal((await s.get<CheckInView>(`/api/agents/${fresh.id}/check-in`)).nextAt, createdAt + 2 * EVERY);
  await reported(fresh);
  await s.app.boards.tick(createdAt + 2 * EVERY - 1);
  await s.app.boards.tick(createdAt + 2 * EVERY);
  await until(async () => of(fresh), list => list.length === 2);
  assert.deepEqual(of(fresh), [createdAt + EVERY, createdAt + 2 * EVERY]);
});

test("a turn of the agent's own work thread does not hold back its check-in job", async () => {
  const createdAt = s.app.agents.record(fresh.id)!.createdAt;
  await reported(fresh);
  const host = s.host as FixtureHost;
  const thread = host.threadsById.get(fresh.thread)!;
  thread.nodes[0]!.status = "running";
  thread.row.status = "running";
  thread.row.updatedAt = Date.now() + 1;
  await s.app.threads.refresh();
  await s.app.boards.tick(createdAt + 3 * EVERY);
  await until(async () => of(fresh), list => list.length === 3);
  assert.equal(of(fresh).at(-1), createdAt + 3 * EVERY);
});

test("a walk's test agent gets no check-in and its view shows none scheduled", async () => {
  const createdAt = s.app.agents.record(throwaway.id)!.createdAt;
  await s.app.boards.tick(createdAt + 10 * EVERY);
  assert.deepEqual(of(throwaway), []);
  assert.equal((await s.get<CheckInView>(`/api/agents/${throwaway.id}/check-in`)).nextAt, null);
});
