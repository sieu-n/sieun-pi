import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

function catalog(t: TestContext) {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>() };
  const result = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }));
  Object.defineProperty(result.client, "isConnected", { get: () => true });
  t.mock.method(result.client, "reconnect", async () => {});
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.after(() => result.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return result;
}

test("session reads finish while cron_list is stuck, and roster refreshes do not repeat its fanout", async t => {
  const c = catalog(t);
  let finishJobs!: (value: unknown) => void;
  let jobReads = 0;
  t.mock.method(c.client, "request", async (command: { type: string }) => {
    if (command.type === "cron_list") {
      jobReads++;
      return new Promise(resolve => { finishJobs = resolve; });
    }
    return { success: true, data: { sessions: [] } };
  });
  await c.refresh();
  t.mock.timers.tick(0);
  assert.equal(jobReads, 1);
  for (let i = 0; i < 5; i++) await c.refresh();
  assert.equal((await c.event()).daemon, "up");
  assert.equal(jobReads, 1);
  finishJobs({ success: true, data: { jobs: [] } });
  await setImmediate();
  await c.close();
  t.mock.timers.tick(60_000);
  assert.equal(jobReads, 1, "closing the view stops schedule reads");
});

test("a failed list is reported and retried without needing another roster notification", async t => {
  const c = catalog(t);
  let attempts = 0;
  t.mock.method(c.client, "request", async (command: { type: string }) => {
    if (command.type === "list" && ++attempts === 1) throw new Error("list timed out");
    return { success: true, data: { sessions: [], jobs: [] } };
  });
  const states: string[] = [];
  c.subscribe(event => { states.push(event.daemon); });
  await setImmediate();
  assert.equal((await c.event()).daemon, "down");
  assert.match((await c.event()).error ?? "", /list timed out/);
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.equal(attempts, 2);
  assert.equal((await c.event()).daemon, "up");
  assert.equal((await c.event()).error, undefined);
  assert(states.includes("down") && states.includes("up"));
});
