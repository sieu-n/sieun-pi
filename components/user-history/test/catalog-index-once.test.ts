// Guards the 10-19 owner ask to watch the d7 clean minutes: under load from job rigs the live chat's main thread stalled 1.1 to 1.9 s, and on a
// scratch serve on a copy of the live data dir every change of a copy indexed all rows at once, about twice per projection, 31 s of 124 s
// of main-thread time from minute 3 on (/home/sieun/scratch/d7-daemon-faults/steady-profile.md).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const live = (n: number, name = `thread ${n}`): SessionSummary => ({ sessionId: `s${n}`, activeSessionId: `a${n}`, cwd: "/tmp", sessionName: name, messageCount: 3 }) as SessionSummary;
const child = (n: number): SessionSummary => ({ sessionId: `c${n}`, activeSessionId: `ac${n}`, cwd: "/tmp", parentSessionId: "s1", rlmChildId: `job-${n}`, runtimeKind: "subagent", messageCount: 2 }) as SessionSummary;

async function catalog(t: TestContext) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const handed: number[] = [];
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }),
    roster: async (roster: ReadonlyMap<string, readonly unknown[]>) => { handed.push(roster.get("s1")?.length ?? 0); } };
  const result = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => result.close());
  let connected = false;
  t.mock.method(result.client, "reconnect", async () => { connected = true; });
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(result.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: [live(1), live(2), child(1)] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(result.client as unknown as object, "isConnected", { get: () => connected });
  await result.refresh();
  await new Promise(resolve => setImmediate(resolve));
  handed.length = 0;
  return { catalog: result, handed };
}

test("ten copy changes between two projections index the rows once, and the projection after them has the last one", async t => {
  const { catalog: c, handed } = await catalog(t);
  for (let n = 0; n < 10; n++) c.patchRow("s2", { sessionName: `renamed ${n}` });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handed, [], "no change indexed the rows before a reader needed them");
  const rows = await c.rows();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.find(row => row.id === "s2")?.name, "renamed 9");
  assert.deepEqual(handed, [1], "the projection indexed the rows once and handed the roster on once");
});

test("a copy change with no reader still hands the roster on within emitGapMs", async t => {
  const { catalog: c, handed } = await catalog(t);
  c.emitGapMs = 20;
  c.patchRow("s2", { sessionName: "renamed" });
  for (let waited = 0; !handed.length && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(handed, [1]);
});

// Guards 10-27: each catalog.hostOf call after a copy change indexed every row, 108.5 s of the main thread in a 48 min profile.
test("hostOf between copy changes reads this box's ids without indexing the rows, and sees a session that joined", async t => {
  const { catalog: c, handed } = await catalog(t);
  const mac = { name: "mac" };
  Object.assign(c as unknown as object, { hosts: { hostOf: () => mac, isActive: () => true, rows: () => [], patch: () => false, allSynced: () => true, close: async () => {} } });
  for (let n = 0; n < 10; n++) {
    c.patchRow("s2", { sessionName: `renamed ${n}` });
    assert.equal(c.hostOf("s1"), null, "this box's own live session");
    assert.equal(c.hostOf("x9"), "mac", "a session only the other box lists");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handed, [], "no hostOf call indexed the rows");
  c.patchRow("s2", { activeSessionId: undefined });
  assert.equal(c.hostOf("s2"), "mac", "a session this box lists with no worker, while the other box runs it");
});
