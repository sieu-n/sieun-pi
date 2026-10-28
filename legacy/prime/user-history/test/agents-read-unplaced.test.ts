// Guards the 08:57Z dirty minute on 10-25: api/threads/01a11b0b/agents asked about a Mac chat while the Mac was offline, and the read ran a daemon
// list and indexed all of this box's rows before it refused, 40 to 180 ms a read and 1.5 s that minute. It is now refused with no daemon list.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { asset, packAsset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const MAC_CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";

/** A catalog of this box's one chat (s1) beside a Mac that never listed, on a fake daemon; `lists` counts the daemon lists it ran. */
async function catalogBesideOfflineMac(t: TestContext, listFirst: boolean) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set(["s1", MAC_CHAT]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const hosts = { selfName: "us-metal02", onChange: () => {}, start: () => {}, close: () => {}, allListed: () => false, allSynced: () => false, loaded: async () => {},
    hostOf: () => null, isActive: () => false, rows: () => [], hostRows: () => [], client: () => null, ready: async () => null };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), hosts as unknown as HostCatalogs);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = [{ sessionId: "s1", activeSessionId: "a1", cwd: "/tmp", sessionName: "chat one", messageCount: 3 }] as SessionSummary[];
  const counted = { lists: 0 };
  t.mock.method(catalog.client, "request", async (command: { type: string }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    counted.lists++;
    return { success: true, data: { sessions: box } };
  });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  if (listFirst) { await catalog.refresh(); await catalog.rows(); }
  return { catalog, chats, counted };
}

async function serve(t: TestContext, catalog: Catalog, chats: unknown) {
  const backend = { close: async () => {}, chats, catalog } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: packAsset(asset(Buffer.from("0"), "text/javascript; charset=utf-8")), css: packAsset(asset(Buffer.from("a{}"), "text/css; charset=utf-8")), version: "test" },
    port: 0, capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-agents.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  return server;
}

test("an agents read of a chat no box places while the Mac has not listed is refused with no daemon list", async (t: TestContext) => {
  const { catalog, chats, counted } = await catalogBesideOfflineMac(t, true);
  const server = await serve(t, catalog, chats);
  const before = counted.lists;
  const res = await fetch(`${server.url}api/threads/${MAC_CHAT}/agents`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Session 01a11b0b is not on this box, and another box has not listed its sessions yet." });
  assert.equal(counted.lists, before, "the refusal ran no daemon list");
  const own = await fetch(`${server.url}api/threads/s1/agents`, { signal: AbortSignal.timeout(5000) });
  assert.equal(own.status, 200, "this box's own chat still answers");
});

test("before this box's copy has listed, an agents read of its own chat still lists and answers", async (t: TestContext) => {
  const { catalog, chats, counted } = await catalogBesideOfflineMac(t, false);
  const server = await serve(t, catalog, chats);
  const res = await fetch(`${server.url}api/threads/s1/agents`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200);
  assert.equal(counted.lists, 1);
});
