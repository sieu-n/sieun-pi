// Guards the 10-18 slow agents reads: api/threads/<id>/agents built a whole catalog projection on each call and answered in 1.0 to 3.5 s 34 times on us-metal02 between 15:13Z and 17:03Z, which made d7 count CPU minutes dirty and came near the chat_board tool's 3 s give-up.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { SessionsEvent } from "../src/shared/types.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { startChatServer } from "../src/chat-server.ts";
import { asset, packAsset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

const agent = { key: "child:a", name: "release test failure", state: "working" };

async function serve(catalog: Record<string, unknown>) {
  const backend = { close: async () => {}, chats: { ids: async () => new Set(["chat-a", "chat-b"]) }, catalog } as unknown as ChatBackend;
  return await startChatServer({ backend, bundle: { js: packAsset(asset(Buffer.from("0"), "text/javascript; charset=utf-8")), css: packAsset(asset(Buffer.from("a{}"), "text/css; charset=utf-8")), version: "test" },
    port: 0, capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-agents.sock" }, onStop: async () => {} });
}

const agentsOf = async (url: string, id: string): Promise<unknown> =>
  (await (await fetch(`${url}api/threads/${id}/agents`, { signal: AbortSignal.timeout(5000) })).json() as { agents: unknown }).agents;

test("the agents read answers from the last frame's row and never waits for a projection", async t => {
  const server = await serve({
    framedRows: () => [{ id: "chat-a", agents: [agent] }],
    summary: async () => undefined,
    rows: () => new Promise(() => {}),
  });
  t.after(() => server.close());
  assert.deepEqual(await agentsOf(server.url, "chat-a"), [agent]);
});

test("a chat that is not in the last frame yet gets its row from a projection", async t => {
  let built = 0;
  const server = await serve({
    framedRows: () => [{ id: "chat-a", agents: [agent] }],
    summary: async () => undefined,
    rows: async () => { built++; return [{ id: "chat-b", agents: [{ ...agent, key: "child:b" }] }]; },
  });
  t.after(() => server.close());
  assert.deepEqual(await agentsOf(server.url, "chat-b"), [{ ...agent, key: "child:b" }]);
  assert.equal(built, 1);
});

test("the catalog hands out the last frame's rows only while a listener holds the feed", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = [{ sessionId: "s1", activeSessionId: "a1", cwd: "/tmp", sessionName: "one", messageCount: 3 } as SessionSummary];
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  assert.equal(catalog.framedRows(), null, "no frame before a listener");
  const frames: SessionsEvent[] = [];
  const unsubscribe = catalog.subscribe(event => { frames.push(event); });
  for (let tries = 0; !frames.length && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(catalog.framedRows()?.map(row => row.id), ["s1"]);
  unsubscribe();
  assert.equal(catalog.framedRows(), null, "a frame nobody holds stops following changes");
});
