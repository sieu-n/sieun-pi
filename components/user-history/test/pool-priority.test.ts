import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyJobIds, LABEL_POOL_PRIORITY, PoolPriorities, poolPriorities, PRIORITY_RETRY_MS } from "../src/chat-pool-priority.ts";
import { parsePoolPriority, parsePoolWait, poolCommand } from "../src/chat-pool.ts";
import type { ChatAgent, PoolPriority, Priority, SessionRow } from "../src/shared/types.ts";

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/w", kind: "live", status: "idle", archived: false, messageCount: 1, working: false,
  subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", origin: "agent", ...extra });
const agent = (sessionId: string, link: ChatAgent["link"]): ChatAgent => ({ key: "thread:" + sessionId, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state: "idle", steps: [] });
const chat = (id: string, agents: ChatAgent[], priority: Priority = 0): SessionRow => row(id, { chat: true, origin: "user", agents, priority });

test("priority labels map None to no override, Low to low, Medium to normal and High to high", () => {
  assert.deepEqual(LABEL_POOL_PRIORITY, { 0: null, 1: "low", 2: "normal", 3: "high" });
});

test("a chat is high, its jobs follow it, a duty run is low, the owner's own thread is high and any other is normal", () => {
  const rows = [chat("vp", [agent("job", "root"), agent("duty", "root"), agent("talk", "message")]), row("job"), row("duty"), row("talk"),
    row("mine", { origin: "user" }), row("old", { archived: true, origin: "user" }), row("saved", { kind: "saved", origin: "user" })];
  assert.deepEqual(Object.fromEntries(poolPriorities(rows, new Set(["duty"]))),
    { vp: "high", job: "high", duty: "low", talk: "normal", mine: "high" });
});

test("a job owned by several chats takes the highest of their priorities, and a step owner counts as an owner", () => {
  const rows = [chat("a", [agent("job", "root")], 1), chat("b", [agent("job", "step")], 2), row("job")];
  assert.equal(poolPriorities(rows, new Set()).get("job"), "normal");
  assert.equal(poolPriorities([...rows.slice(0, 2), row("job"), chat("c", [agent("job", "step")])], new Set()).get("job"), "high");
});

test("a set priority label overrides the class, on a chat (and so its jobs) and on a duty run", () => {
  const rows = [chat("vp", [agent("job", "root")], 1), row("job"), row("duty", { priority: 3 })];
  assert.deepEqual(Object.fromEntries(poolPriorities(rows, new Set(["duty"]))), { vp: "low", job: "low", duty: "high" });
});

test("duty job ids are the registry entries that are session ids; create_session roots are registered by name", async () => {
  const rows = [chat("c1", [], 0), row("d1"), row("named-job")];
  const registry = { rootsOf: async (chats: readonly string[]) => chats.includes("c1") ? ["d1", "named-job-name", "gone-id"] : [] };
  assert.deepEqual([...await dutyJobIds(rows, registry)], ["d1"]);
});

test("a sync sets each root once, again only when its class changes, and a failed set waits before it retries", async () => {
  let rows = [chat("vp", [agent("job", "root")]), row("job"), row("new")];
  const calls: string[] = [];
  let now = 1_000_000;
  let refuse = new Set(["new"]);
  const sync = new PoolPriorities({ rows: async () => rows, duties: async () => new Set(), now: () => now,
    set: async (id: string, priority: PoolPriority) => { calls.push(`${id}=${priority}`); if (refuse.has(id)) throw new Error("matches no known session"); } });
  await sync.sync();
  assert.deepEqual(calls.sort(), ["job=high", "new=normal", "vp=high"]);
  calls.length = 0;
  await sync.sync();
  assert.deepEqual(calls, [], "nothing changed and the failed one is not due yet");
  rows = [chat("vp", [agent("job", "root")], 1), row("job"), row("new")];
  refuse = new Set();
  now += PRIORITY_RETRY_MS;
  await sync.sync();
  assert.deepEqual(calls.sort(), ["job=low", "new=normal", "vp=low"]);
});

test("syncs asked for while one runs run once more after it, not in parallel", async () => {
  let running = 0, most = 0, reads = 0;
  const sync = new PoolPriorities({ rows: async () => { reads++; running++; most = Math.max(most, running); await new Promise(resolve => setTimeout(resolve, 5)); running--; return []; },
    duties: async () => new Set(), set: async () => {} });
  await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
  assert.equal(most, 1);
  assert.equal(reads, 2);
});

test("pi-pool priority and wait parse at the boundary, and the priority command names the session", () => {
  assert.equal(parsePoolPriority("high"), "high");
  assert.equal(parsePoolPriority("urgent"), null);
  assert.deepEqual(parsePoolWait({ account: "c7", slot_at: 1791790000 }), { account: "c7", slotAt: 1791790000000 });
  assert.equal(parsePoolWait(null), null);
  assert.equal(parsePoolWait({ account: "", slot_at: 1 }), null);
  assert.deepEqual(poolCommand.priority("01a1", "low"), ["priority", "low", "--session", "01a1"]);
});
