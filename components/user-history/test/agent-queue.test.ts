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
const { setLine, statusLine, whyLines, POOL_SILENT } = await import("../src/client/agent-queue.ts");
const { queueRows, rowNames } = await import("../src/chat-agent-queue.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));
const raw = () => JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;

test("the queue fixture parses into epoch ms, queued in position order", async () => {
  const reading = await readAgentQueue();
  assert.equal(reading.enabled, true);
  assert.equal(reading.macWorkingMax, 16);
  assert.equal(reading.treeWorkingMax, 8);
  assert.deepEqual(reading.working.map(entry => [entry.session, entry.priority, entry.kind, entry.since]), [["s-work-1", "high", "owner", 1792000000000], ["s-work-2", "normal", "slot", 1792000030000]]);
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
  assert.throws(() => parseAgentQueue({ ...raw(), working: [{ session: "x", tree: "t", parent: null, class: "normal", kind: "lent", since: 1 }] }), /kind/);
});

test("the Mac limit carries who last set it and when, and the Settings row says so next to the measured default", () => {
  assert.equal(parseAgentQueue(raw()).macWorkingMaxSet, null);
  assert.deepEqual(parseAgentQueue({ ...raw(), mac_working_max_set: { by: "the Settings pane", at: 1791942343 } }).macWorkingMaxSet,
    { by: "the Settings pane", at: 1791942343000 });
  assert.throws(() => parseAgentQueue({ ...raw(), mac_working_max_set: { by: "", at: 1791942343 } }));
  assert.throws(() => parseAgentQueue({ ...raw(), mac_working_max_set: { by: null } }));
  assert.equal(setLine(16, null, 16), "The Mac limit holds the default 16, and nobody has set it.");
  assert.equal(setLine(30, { by: "the Settings pane", at: 1791942343000 }, 16), "The Mac limit was set to 30 by the Settings pane at 10-14 10:45 KST.");
  assert.equal(setLine(30, { by: null, at: 1791942343000 }, 16),
    "The Mac limit was set to 30 at 10-14 10:45 KST, the file time of config.json, by a writer pi-pool did not record then.");
});

test("pool writes go through pi-pool set with the value as text", async () => {
  writeFileSync(calls, "");
  await setPoolKey("agent_queue_on", 0);
  await setPoolKey("tree_working_max", 8);
  assert.equal(readFileSync(calls, "utf8"), "set agent_queue_on 0 --by the Settings pane\nset tree_working_max 8 --by the Settings pane\n");
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
    },
    async () => [{ at: 1792000000000, finished: 40, medianWaitS: 12 }]);
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

test("the status line counts working and waiting agents", async () => {
  const { queue, fail } = harness(parseAgentQueue(raw()));
  const view = await queue.view();
  const { pool } = view;
  assert.equal(pool.state, "read");
  if (pool.state !== "read") return;
  assert.equal(statusLine(pool), "2 agents working, 2 waiting.");
  assert.equal(statusLine({ ...pool, working: pool.working.slice(0, 1), queued: [] }), "1 agent working, 0 waiting.");
  assert.equal(statusLine({ ...pool, enabled: false }), "The queue is off, so every agent starts at once.");
  assert.deepEqual(view.history, [{ at: 1792000000000, finished: 40, medianWaitS: 12 }]);
  fail();
  assert.equal(statusLine((await queue.view()).pool), POOL_SILENT);
  assert.equal(POOL_SILENT, "The pool did not answer. The queue is off until it does.");
});

test("the queue rows name each turn's chat and job, working longest first, then waiting in admission order", async () => {
  const titles: Record<string, string> = { "t-root-1": "VP of CI", "s-work-2": "ci watcher", "t-root-3": "Crawler VP", "01a1": "ops guy" };
  const title = (id: string): string | null => titles[id] ?? null;
  const rows = queueRows(parseAgentQueue(raw()), title);
  assert.deepEqual(rows.map(row => [row.state, row.chat, row.job, row.owner, row.since]), [
    ["working", "VP of CI", "s-work-1", true, 1792000000000],
    ["working", "VP of CI", "ci watcher", false, 1792000030000],
    ["waiting", "Crawler VP", "s-q-1", false, 1792000000000],
    ["waiting", "t-root-2", "s-q-2", false, 1792000100000],
  ]);
  assert.deepEqual(rowNames("duty:01a1:checkin", "duty:01a1:checkin", title), { chat: "ops guy", job: "check-in" });
  assert.deepEqual(rowNames("duty:01a1:d3", "duty:01a1:d3", title), { chat: "ops guy", job: "duty d3" });
});

test("why these numbers carries the live reading, who set the limit and every measured default", async () => {
  const { queue } = harness(parseAgentQueue(raw()));
  const lines = whyLines(await queue.view());
  assert.equal(lines[0], "The Mac limit holds the default 16, and nobody has set it.");
  assert.ok(!lines.some(line => /memory pressure/i.test(line)), "the queue holds nothing back for memory (c88)");
  for (const line of lines) assert.ok(!line.includes("\u2014"), line);
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
