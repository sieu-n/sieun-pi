// Guards the 10-18 slow agents reads: api/threads/<id>/agents built a whole catalog projection on each call and answered in 1.0 to 3.5 s 34 times on us-metal02 between 15:13Z and 17:03Z, which made d7 count CPU minutes dirty and came near the chat_board tool's 3 s give-up.
// And the 10-24 ones: with no page open, and in the minute after each start, the read still waited for a projection (2.8 s at 20:32Z, 14.0 s on a scratch serve's first read).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the agents read answers from the rows the catalog holds and never waits for a projection", async t => {
  const server = await serve({
    heldAgents: (id: string) => id === "chat-a" ? [agent] : undefined,
    unplacedNow: async () => false,
    summary: async () => undefined,
    rows: () => new Promise(() => {}),
  });
  t.after(() => server.close());
  assert.deepEqual(await agentsOf(server.url, "chat-a"), [agent]);
});

test("a chat that is not in the rows the catalog holds gets its row from a projection, and the read logs what lacked it", async t => {
  let built = 0;
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { lines.push(String(chunk)); return write(chunk); });
  const server = await serve({
    heldAgents: (id: string) => id === "chat-a" ? [agent] : undefined,
    heldSource: () => "the last frame of 1 rows lacks its row",
    unplacedNow: async () => false,
    summary: async () => undefined,
    rows: async () => { built++; return [{ id: "chat-b", agents: [{ ...agent, key: "child:b" }] }]; },
  });
  t.after(() => server.close());
  assert.deepEqual(await agentsOf(server.url, "chat-b"), [{ ...agent, key: "child:b" }]);
  assert.equal(built, 1);
  assert.ok(lines.some(line => /^\S+Z agents chat-b: the last frame of 1 rows lacks its row, so the read projected in \d+ ms\n$/.test(line)), lines.join(""));
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

/** A catalog over one chat (s1) that started a root (s2), on a fake daemon; `projections` counts the projections it built. */
function chatCatalog(t: TestContext, agentsFile: string | null = null) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set(["s1"]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: ["s2"], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), null, null, agentsFile);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = [
    { sessionId: "s1", activeSessionId: "a1", cwd: "/tmp", sessionName: "chat one", messageCount: 3 },
    { sessionId: "s2", activeSessionId: "a2", cwd: "/tmp", sessionName: "root two", messageCount: 2 },
  ] as SessionSummary[];
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  const counted = { projections: 0 };
  const project = (catalog as unknown as { project: () => Promise<unknown> }).project.bind(catalog);
  (catalog as unknown as { project: () => Promise<unknown> }).project = () => { counted.projections++; return project(); };
  return { catalog, counted };
}

test("with no listener the agents come from the last projection, and a change since starts the next one behind the answer", async t => {
  const { catalog, counted } = chatCatalog(t);
  await catalog.refresh();
  assert.equal(catalog.heldAgents("s1"), undefined, "nothing to answer from before a projection");
  assert.equal(catalog.heldSource("s1"), "no frame, projection or saved agents yet");
  await catalog.rows();
  assert.equal(catalog.heldSource("s9"), "the last projection of 2 rows lacks its row");
  const built = counted.projections;
  assert.deepEqual(catalog.heldAgents("s1")?.map(entry => entry.sessionId), ["s2"]);
  assert.equal(counted.projections, built, "rows that are current start no projection");
  void catalog.notify();
  assert.deepEqual(catalog.heldAgents("s1")?.map(entry => entry.sessionId), ["s2"], "the last projection answers at once after a change");
  assert.equal(counted.projections, built + 1, "and one projection starts behind it");
});

test("a start answers with the agents the last run saved at its stop until its first projection, and reads the file once", async t => {
  const dir = mkdtempSync(join(tmpdir(), "agents-saved-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "chat-agents.json");
  const first = chatCatalog(t, file);
  await first.catalog.refresh();
  await first.catalog.rows();
  await first.catalog.close();
  const saved = JSON.parse(readFileSync(file, "utf8")) as { chats: Record<string, { sessionId?: string }[]> };
  assert.deepEqual(Object.keys(saved.chats), ["s1"]);
  assert.deepEqual(saved.chats.s1!.map(entry => entry.sessionId), ["s2"]);

  const next = chatCatalog(t, file);
  assert.equal(existsSync(file), false, "the start deletes the file it read, so a crash leaves none behind");
  assert.deepEqual(next.catalog.heldAgents("s1")?.map(entry => entry.sessionId), ["s2"]);
  assert.equal(next.catalog.heldSource("s9"), "the agents the last run saved for 1 chats lack it");
  assert.equal(next.counted.projections, 0);
  writeFileSync(file, "not json");
  assert.equal(chatCatalog(t, file).catalog.heldAgents("s1"), undefined, "a file of another shape is no answer");
});
