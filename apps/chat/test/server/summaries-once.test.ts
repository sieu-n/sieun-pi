/**
 * The agents list, the boards, the duties and For you read each thread's summaries once per thread list read, and the agent records'
 * lookups read maps, not scans. On 11-03 on us-metal02 the 2 s thread list read, /api/boards, each duty read and the step owners' tick built
 * every thread's summaries again, up to once per chat, and held the event loop for 250 to 310 ms at a time, so the agent page's calls waited
 * up to 4.3 s in the browser while their handlers took 6 to 44 ms.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/summaries-once.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import { Threads } from "../../server/threads.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let builds = 0;
before(async () => {
  s = await start();
  const proto = Threads.prototype as unknown as { buildAgentsOf: (...args: unknown[]) => unknown };
  const build = proto.buildAgentsOf;
  proto.buildAgentsOf = function (this: unknown, ...args: unknown[]) {
    builds += 1;
    return build.apply(this, args);
  };
});
after(async () => {
  await s.close();
});

test("the boards, duties, For you and the agents list build each thread's summaries at most once until something changes", async () => {
  await s.app.threads.refresh();
  const threads = s.app.threads.threadsList().length;
  assert.ok(threads > 3, "the fixture holds threads");
  builds = 0;
  for (let i = 0; i < 5; i++) {
    await s.app.boards.index();
    await s.app.boards.forYou();
    for (const chat of s.app.boards.chats()) s.app.boards.duties(chat);
    await s.get<AgentSummary[]>("/api/agents");
  }
  assert.ok(builds <= threads, `${builds} builds for ${threads} threads`);
});

test("a new agent, a thread kind and a thread list read each show at once", async () => {
  const before = await s.get<AgentSummary[]>("/api/agents?test=1");
  const made = await s.send<AgentSummary>("POST", "/api/agents", { name: "summaries once walk", test: true });
  assert.equal(made.status, 200);
  const listed = await s.get<AgentSummary[]>("/api/agents?test=1");
  assert.equal(listed.length, before.length + 1);
  assert.ok(listed.some(a => a.id === made.body.id));

  const record = s.app.agents.record(made.body.id)!;
  s.app.agents.store.agents.agents = s.app.agents.store.agents.agents.filter(r => r.id !== record.id);
  assert.equal(s.app.agents.record(made.body.id), undefined, "a records list replaced without a save reads at once");
  s.app.agents.store.agents.agents.push(record);
  assert.equal(s.app.agents.record(made.body.id), record, "a record pushed without a save reads at once");

  const work = record.workThread;
  s.app.agents.store.agents.agents = s.app.agents.store.agents.agents.filter(r => r.id !== record.id);
  s.app.agents.store.saveAgents();
  s.app.store.state.threads[work] = { kind: "job" };
  s.app.store.saveState();
  assert.equal(s.app.threads.agent(work)?.kind, "job", "a thread kind saved reads at once");
});
