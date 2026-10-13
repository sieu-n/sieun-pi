import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** A fake pi-pool: `queue --json` prints the contract fixture, `set` appends its arguments to a log. Set before chat-pool.ts reads PI_POOL_BIN. */
const dir = mkdtempSync(join(tmpdir(), "agent-queue-"));
const fake = join(dir, "pi-pool");
const calls = join(dir, "calls.log");
const fixture = new URL("./fixtures/pi-pool-queue.json", import.meta.url).pathname;
writeFileSync(fake, `#!/bin/sh
case "$1" in
  queue) cat "${fixture}" ;;
  set) echo "$@" >> "${calls}" ;;
esac
`);
chmodSync(fake, 0o755);
process.env.PI_POOL_BIN = fake;
const { parseAgentQueue, readAgentQueue, setPoolKey } = await import("../src/chat-pool.ts");
const { agentQueue, parseAgentQueueInput, DEFAULT_MAC_WORKING_MAX } = await import("../src/chat-agent-queue.ts");
const { queueLine, POOL_SILENT } = await import("../src/client/agent-queue.ts");
type Reading = Awaited<ReturnType<typeof readAgentQueue>>;

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

test("mac_working_max off parses as a null limit, and a bad shape throws", () => {
  assert.equal(parseAgentQueue({ ...raw(), enabled: false, mac_working_max: "off", working: [], queued: [] }).macWorkingMax, null);
  assert.throws(() => parseAgentQueue({ ...raw(), mac_working_max: "on" }));
  assert.throws(() => parseAgentQueue({ ...raw(), tree_working_max: 0 }));
  assert.throws(() => parseAgentQueue({ ...raw(), queued: [{ session: "x", tree: "t", class: "normal", since: 1 }] }));
  assert.throws(() => parseAgentQueue(null));
});

test("pool writes go through pi-pool set with the value as text", async () => {
  writeFileSync(calls, "");
  await setPoolKey("mac_working_max", "off");
  await setPoolKey("tree_working_max", 8);
  assert.equal(readFileSync(calls, "utf8"), "set mac_working_max off\nset tree_working_max 8\n");
});

function harness(initial: Reading) {
  let reading: Reading | null = initial;
  const writes: Array<[string, number | "off"]> = [];
  const queue = agentQueue(join(mkdtempSync(join(dir, "store-")), "agent-queue.json"), id => id === "s-q-1" ? "Crawler VP" : null,
    async () => { if (!reading) throw new Error("pi-pool failed: no answer"); return reading; },
    async (key, value) => {
      writes.push([key, value]);
      if (reading && key === "mac_working_max") reading = { ...reading, enabled: value !== "off", macWorkingMax: value === "off" ? null : value };
      if (reading && key === "tree_working_max" && value !== "off") reading = { ...reading, treeWorkingMax: value };
    });
  return { queue, writes, fail: () => { reading = null; } };
}

test("the switch writes off in one write and restores the number the owner set", async () => {
  const { queue, writes } = harness(parseAgentQueue(raw()));
  await queue.apply({ action: "mac", value: 12 });
  const off = await queue.apply({ action: "off" });
  assert.equal(off.state === "read" && off.enabled, false);
  assert.equal(off.restoreMax, 12);
  const on = await queue.apply({ action: "on" });
  assert.equal(on.state === "read" && on.macWorkingMax, 12);
  assert.deepEqual(writes, [["mac_working_max", 12], ["mac_working_max", "off"], ["mac_working_max", 12]]);
});

test("with nothing remembered the switch restores the measured default, and the per-chat limit is its own write", async () => {
  const { queue, writes } = harness(parseAgentQueue({ ...raw(), enabled: false, mac_working_max: "off" }));
  assert.equal((await queue.view()).restoreMax, DEFAULT_MAC_WORKING_MAX);
  await queue.apply({ action: "on" });
  await queue.apply({ action: "tree", value: 6 });
  assert.deepEqual(writes, [["mac_working_max", 16], ["tree_working_max", 6]]);
});

test("the live line counts working and queued turns and names the next one", async () => {
  const { queue, fail } = harness(parseAgentQueue(raw()));
  const view = await queue.view();
  assert.equal(queueLine(view), "2 working, 2 queued. Next: Crawler VP, a low turn moved up to normal, queued for 4m 5s.");
  assert.equal(queueLine({ ...view, queued: [], nextTitle: null } as typeof view), "2 working, 0 queued.");
  assert.equal(queueLine({ ...view, enabled: false } as typeof view), "The queue is off, so every turn starts at once.");
  fail();
  const silent = await queue.view();
  assert.equal(silent.state, "unread");
  assert.equal(queueLine(silent), POOL_SILENT);
  assert.equal(POOL_SILENT, "The pool did not answer. The queue is off until it does.");
});

test("an Agent queue write takes on, off, or a whole limit from 1 to 999", () => {
  assert.deepEqual(parseAgentQueueInput({ action: "off" }), { action: "off" });
  assert.deepEqual(parseAgentQueueInput({ action: "mac", value: 16 }), { action: "mac", value: 16 });
  for (const bad of [{ action: "mac", value: 0 }, { action: "tree", value: 2.5 }, { action: "mac", value: "16" }, { action: "reset" }, null]) assert.throws(() => parseAgentQueueInput(bad));
});
