// Guards the 10-20 owner ask behind p104 (a live loop p99 under 1 s): a chat row and its agents were new objects on every projection, so a
// scratch serve on a copy of the live data dir with its chats promoted them to old space, which grew 1.0 to 1.3 GB between two major GCs
// whose pauses were 0.4 to 0.6 s, and each feed wrote every new agent and row to JSON again.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const at = "2026-10-20T03:00:00.000Z";
const chat: SessionSummary = { sessionId: "s1", activeSessionId: "a1", cwd: "/tmp", sessionName: "chat", messageCount: 3, lastActivityAt: at } as SessionSummary;
const job = (n: number, name: string): SessionSummary => ({ sessionId: `c${n}`, activeSessionId: `ac${n}`, cwd: "/tmp", parentSessionId: "s1", rlmChildId: `job-${n}`,
  sessionName: name, runtimeKind: "subagent", messageCount: 2, lastActivityAt: at }) as SessionSummary;

async function catalog(t: TestContext, sessions: SessionSummary[]) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set(["s1"]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }), roster: async () => {} };
  const result = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => result.close());
  let connected = false;
  t.mock.method(result.client, "reconnect", async () => { connected = true; });
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(result.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(result.client as unknown as object, "isConnected", { get: () => connected });
  await result.refresh();
  await new Promise(resolve => setImmediate(resolve));
  return result;
}

test("a chat row and its agents that did not change are the last projection's objects, and a changed agent is new while the others stay", async t => {
  const c = await catalog(t, [chat, job(1, "first job"), job(2, "second job")]);
  const first = (await c.rows()).find(row => row.id === "s1")!;
  assert.equal(first.agents?.length, 2);
  c.patchRow("s2", {});
  c.holdLifecycle("nobody", "active");
  const second = (await c.rows()).find(row => row.id === "s1")!;
  assert.equal(second, first, "an unchanged chat row is the same object");
  c.patchRow("c2", { sessionName: "second job renamed" });
  const third = (await c.rows()).find(row => row.id === "s1")!;
  assert.notEqual(third, first);
  const renamed = third.agents!.find(agent => agent.sessionId === "c2")!;
  const kept = third.agents!.find(agent => agent.sessionId === "c1")!;
  assert.equal(renamed.name, "second job renamed");
  assert.equal(kept, first.agents!.find(agent => agent.sessionId === "c1"), "the unchanged agent is the same object");
});
