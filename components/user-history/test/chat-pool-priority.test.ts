import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIORITY_RETRY_MS, PoolPriorities } from "../src/chat-pool-priority.ts";
import { readPoolClasses, type PoolTreeClass } from "../src/chat-pool.ts";
import type { PoolPriority, SessionRow } from "../src/shared/types.ts";

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, name: id, kind: "live", archived: false, chat: false, priority: 0, origin: "agent", ...extra }) as SessionRow;

function pool(rows: SessionRow[], held: Record<string, PoolTreeClass> | null) {
  const calls = { reads: [] as string[][], sets: [] as [string, PoolPriority][] };
  let clock = 0;
  const failing = new Set<string>();
  const priorities = new PoolPriorities({
    rows: async () => rows, duties: async () => new Set(),
    read: async ids => { calls.reads.push([...ids]); return held && new Map(Object.entries(held)); },
    set: async (id, priority) => { calls.sets.push([id, priority]); if (failing.has(id)) throw new Error("busy"); if (held) held[id] = { priority, label: null }; },
    now: () => clock,
  });
  return { priorities, calls, failing, tick: (ms: number) => { clock += ms; } };
}

test("a start reads every live root once and sets only the roots whose record holds another class, a label or nothing", async () => {
  // 10-18 13:07:56Z: a start of the chat service ran pi-pool priority for 52 live roots in 10 s, though the pool held each class already.
  const rows = [row("chat", { chat: true }), row("owner", { origin: "user" }), row("job"), row("labelled"), row("new"), row("saved", { kind: "saved" })];
  const { priorities, calls } = pool(rows, {
    chat: { priority: "high", label: null }, owner: { priority: "normal", label: null }, job: { priority: "normal", label: null },
    labelled: { priority: "normal", label: "high" }, new: { priority: null, label: null } });
  await priorities.sync();
  assert.deepEqual(calls.reads, [["chat", "owner", "job", "labelled", "new"]]);
  assert.deepEqual(calls.sets, [["owner", "high"], ["labelled", "normal"], ["new", "normal"]]);
  await priorities.sync();
  assert.equal(calls.reads.length, 1, "a later sync with no class change reads nothing");
  assert.equal(calls.sets.length, 3);
});

test("a pool that cannot say what it holds gets every root set, as before", async () => {
  const { priorities, calls } = pool([row("chat", { chat: true }), row("job")], null);
  await priorities.sync();
  assert.deepEqual(calls.sets, [["chat", "high"], ["job", "normal"]]);
  await priorities.sync();
  assert.equal(calls.sets.length, 2);
});

test("a label change sets the root it changes, and a root that comes back live is read again", async () => {
  const rows = [row("chat", { chat: true }), row("job")];
  const { priorities, calls } = pool(rows, { chat: { priority: "high", label: null }, job: { priority: "normal", label: null } });
  await priorities.sync();
  assert.deepEqual(calls.sets, []);
  rows[0] = row("chat", { chat: true, priority: 1 });
  await priorities.sync();
  assert.deepEqual(calls.reads.at(-1), ["chat"]);
  assert.deepEqual(calls.sets, [["chat", "low"]]);
  rows[1] = row("job", { kind: "saved" });
  await priorities.sync();
  rows[1] = row("job");
  await priorities.sync();
  assert.deepEqual(calls.reads.at(-1), ["job"]);
  assert.deepEqual(calls.sets, [["chat", "low"]]);
});

test("a failed set is read and tried again after PRIORITY_RETRY_MS, not on the next sync", async () => {
  const { priorities, calls, failing, tick } = pool([row("job", { origin: "user" })], { job: { priority: "normal", label: null } });
  failing.add("job");
  await priorities.sync();
  tick(30_000);
  await priorities.sync();
  assert.equal(calls.sets.length, 1);
  failing.clear();
  tick(PRIORITY_RETRY_MS);
  await priorities.sync();
  assert.deepEqual(calls.sets, [["job", "high"], ["job", "high"]]);
  assert.equal(calls.reads.length, 2);
});

test("readPoolClasses asks one snapshot with a --tree per root and gives null for a pool from before --tree", async () => {
  const asked: string[][] = [];
  const out = JSON.stringify({ queue: {}, config: {}, threads: [], trees: [
    { session: "a", priority: "high", label: null }, { session: "b", priority: null, label: null }, { session: "c", priority: "urgent", label: null }] });
  const classes = await readPoolClasses(["a", "b", "c"], async args => { asked.push([...args]); return { code: 0, out, err: "" }; });
  assert.deepEqual(asked, [["snapshot", "--json", "--tree", "a", "--tree", "b", "--tree", "c"]]);
  assert.deepEqual([...classes!], [["a", { priority: "high", label: null }], ["b", { priority: null, label: null }]]);
  const old = 'usage: pi-pool snapshot --json [--thread <session or ""> <model or "">]...\n';
  assert.equal(await readPoolClasses(["a"], async () => ({ code: 1, out: "", err: old })), null);
});
