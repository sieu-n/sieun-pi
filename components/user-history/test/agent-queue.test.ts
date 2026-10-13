import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentQueueReading, IdleEvictionMinutes } from "../src/shared/types.ts";

/** A fake pi-pool: `queue --json` prints the contract fixture, `set` appends its arguments to a log. Set before chat-pool.ts reads PI_POOL_BIN. */
const dir = mkdtempSync(join(tmpdir(), "agent-queue-"));
const fake = join(dir, "pi-pool");
const calls = join(dir, "calls.log");
const fixture = new URL("./fixtures/pi-pool-queue.json", import.meta.url).pathname;
writeFileSync(fake, `#!/bin/sh
case "$1" in
  queue) cat "${fixture}" ;;
  config) echo '{"agent_queue_on": 1, "queue_aging_s": 18, "lease_s": 1800, "switch_models": ["fable"]}' ;;
  set) echo "$@" >> "${calls}" ;;
esac
`);
chmodSync(fake, 0o755);
process.env.PI_POOL_BIN = fake;
const { parseAgentQueue, readAgentQueue, readQueueTimers, setPoolKey } = await import("../src/chat-pool.ts");
const { agentQueue, parseAgentQueueInput } = await import("../src/chat-agent-queue.ts");
const { chatDefaultsStore } = await import("../src/chat-backend.ts");
const { queueLine, POOL_SILENT } = await import("../src/client/agent-queue.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));
const raw = () => JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;

test("the queue fixture parses into epoch ms, queued in position order", async () => {
  const reading = await readAgentQueue();
  assert.equal(reading.enabled, true);
  assert.equal(reading.macWorkingMax, 16);
  assert.equal(reading.treeWorkingMax, 8);
  assert.deepEqual(reading.working.map(entry => [entry.session, entry.priority, entry.since]), [["s-work-1", "high", 1792000000000], ["s-work-2", "normal", 1792000030000]]);
  assert.deepEqual(reading.queued.map(entry => [entry.session, entry.position, entry.basePriority, entry.priority, entry.waitMs]), [["s-q-1", 1, "low", "normal", 245000], ["s-q-2", 2, "normal", "normal", 60000]]);
});

test("the two timers come from pi-pool config", async () => {
  assert.deepEqual(await readQueueTimers(), { queueAgingS: 18, leaseS: 1800 });
});

test("both limits must be whole numbers, and a bad shape throws", () => {
  assert.equal(parseAgentQueue({ ...raw(), enabled: false, working: [], queued: [] }).macWorkingMax, 16);
  assert.throws(() => parseAgentQueue({ ...raw(), mac_working_max: "off" }));
  assert.throws(() => parseAgentQueue({ ...raw(), tree_working_max: 0 }));
  assert.throws(() => parseAgentQueue({ ...raw(), queued: [{ session: "x", tree: "t", class: "normal", since: 1 }] }));
  assert.throws(() => parseAgentQueue(null));
});

test("pool writes go through pi-pool set with the value as text", async () => {
  writeFileSync(calls, "");
  await setPoolKey("agent_queue_on", 0);
  await setPoolKey("tree_working_max", 8);
  assert.equal(readFileSync(calls, "utf8"), "set agent_queue_on 0\nset tree_working_max 8\n");
});

function harness(initial: AgentQueueReading) {
  let reading: AgentQueueReading | null = initial;
  let idle: IdleEvictionMinutes = 90;
  const writes: Array<[string, number | string]> = [];
  const queue = agentQueue(id => id === "s-q-1" ? "Crawler VP" : null,
    { idleEviction: () => idle, setIdleEviction: async value => { writes.push(["idleEvictionMinutes", value]); idle = value; } },
    async () => { if (!reading) throw new Error("pi-pool failed: no answer"); return reading; },
    async () => ({ queueAgingS: 18, leaseS: 1800 }),
    async (key, value) => {
      writes.push([key, value]);
      if (!reading) return;
      if (key === "agent_queue_on") reading = { ...reading, enabled: value === 1 };
      if (key === "mac_working_max") reading = { ...reading, macWorkingMax: value };
      if (key === "tree_working_max") reading = { ...reading, treeWorkingMax: value };
    });
  return { queue, writes, fail: () => { reading = null; } };
}

test("the switch is one agent_queue_on write each way and the Mac limit keeps its number", async () => {
  const { queue, writes } = harness(parseAgentQueue(raw()));
  await queue.apply({ action: "mac", value: 12 });
  const off = await queue.apply({ action: "queue", on: false });
  assert.equal(off.pool.state === "read" && off.pool.enabled, false);
  assert.equal(off.pool.state === "read" && off.pool.macWorkingMax, 12);
  const on = await queue.apply({ action: "queue", on: true });
  assert.equal(on.pool.state === "read" && on.pool.enabled, true);
  assert.deepEqual(writes, [["mac_working_max", 12], ["agent_queue_on", 0], ["agent_queue_on", 1]]);
});

test("the per-chat limit, the two timers and the idle unload time are their own writes, and the idle time reads while the pool is silent", async () => {
  const { queue, writes, fail } = harness(parseAgentQueue(raw()));
  await queue.apply({ action: "tree", value: 6 });
  await queue.apply({ action: "aging", value: 30 });
  await queue.apply({ action: "lease", value: 900 });
  await queue.apply({ action: "idle", value: 45 });
  fail();
  const view = await queue.view();
  assert.equal(view.pool.state, "unread");
  assert.equal(view.idleEvictionMinutes, 45);
  assert.deepEqual(writes, [["tree_working_max", 6], ["queue_aging_s", 30], ["lease_s", 900], ["idleEvictionMinutes", 45]]);
});

test("the live line counts working and queued turns and names the next one", async () => {
  const { queue, fail } = harness(parseAgentQueue(raw()));
  const { pool } = await queue.view();
  assert.equal(queueLine(pool), "2 working, 2 queued. Next: Crawler VP, a low turn moved up to normal, queued for 4m 5s.");
  assert.equal(pool.state, "read");
  if (pool.state !== "read") return;
  assert.equal(queueLine({ ...pool, queued: [], nextTitle: null }), "2 working, 0 queued.");
  assert.equal(queueLine({ ...pool, enabled: false }), "The queue is off, so every turn starts at once.");
  fail();
  assert.equal(queueLine((await queue.view()).pool), POOL_SILENT);
  assert.equal(POOL_SILENT, "The pool did not answer. The queue is off until it does.");
});

test("an Agent queue write takes the switch, a whole limit from 1 to 999, a timer from 1 to 86,400 s, or 1 to 1440 idle minutes or off", () => {
  assert.deepEqual(parseAgentQueueInput({ action: "queue", on: false }), { action: "queue", on: false });
  assert.deepEqual(parseAgentQueueInput({ action: "mac", value: 16 }), { action: "mac", value: 16 });
  assert.deepEqual(parseAgentQueueInput({ action: "idle", value: "off" }), { action: "idle", value: "off" });
  assert.deepEqual(parseAgentQueueInput({ action: "lease", value: 1800 }), { action: "lease", value: 1800 });
  for (const bad of [{ action: "mac", value: 0 }, { action: "tree", value: 2.5 }, { action: "mac", value: "16" }, { action: "queue", on: "yes" }, { action: "idle", value: 0 }, { action: "aging", value: 86_401 }, { action: "off" }, null]) {
    assert.throws(() => parseAgentQueueInput(bad));
  }
});

test("the idle unload time goes to ~/.prime/agent/settings.json through the defaults store", async () => {
  const dir2 = mkdtempSync(join(dir, "agent-"));
  const store = chatDefaultsStore(dir2);
  assert.equal(store.idleEviction(), 90);
  await store.setIdleEviction(30);
  assert.equal(JSON.parse(readFileSync(join(dir2, "settings.json"), "utf8")).idleEvictionMinutes, 30);
  assert.equal(chatDefaultsStore(dir2).idleEviction(), 30);
});
