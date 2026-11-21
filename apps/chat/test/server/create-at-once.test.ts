/**
 * Agents made at once each take a message at once. On 11-22 the Agent memory duty made 8 test agents together and sent each one message, and
 * 6 of the 8 sends answered `404 No thread <id>.` at second 0: a thread list read that began before a create came back without the new
 * thread and replaced the list, so the row `POST /api/agents` had put in it was gone until the next read. Here the list read takes 300 ms, as
 * pi-host's read of 979 threads took 50 to 530 ms on 11-21.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/create-at-once.test.ts
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

const READ_MS = 300;
let s: Running;

before(async () => {
  s = await start();
  const host = s.host as FixtureHost;
  const read = host.threads.bind(host);
  host.threads = async opts => {
    const rows = await read(opts);
    await sleep(READ_MS);
    return rows;
  };
});
after(async () => {
  await s.close();
});

test("8 agents made at once during a list read each take a message after it", async () => {
  const stale = s.app.threads.refresh();
  await sleep(5);
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name: `At once ${i}`, thinkingLevel: "low", test: true })));
  assert.deepEqual(made.map(m => m.status), Array(8).fill(200));
  await stale;
  const sent = await Promise.all(made.map((m, i) => s.send("POST", `/api/c/${m.body.thread}/send`, { requestId: `at-once-${i}`, text: "What is your name?" })));
  assert.deepEqual(sent.map(r => r.status === 200 ? "200" : `${r.status} ${JSON.stringify(r.body)}`), Array(8).fill("200"));
});

test("an agent made while a list read runs stays listed after the read", async () => {
  const stale = s.app.threads.refresh();
  await sleep(5);
  const made = await s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name: "During a read", test: true });
  assert.equal(made.status, 200);
  await stale;
  assert.ok(s.app.threads.thread(made.body.thread), "the read from before the create keeps the new thread");
  assert.equal(s.app.threads.agent(made.body.id)?.name, "During a read");
});
