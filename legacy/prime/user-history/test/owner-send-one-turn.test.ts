// d2 on 11-03 read a follow-up to a Mac chat 1.8 round trips past the Mac's own turn, against 1.2 on 11-02 and 1.0 for the same prompt sent
// straight through a relay tunnel. The send path took three turns of the chat service's main thread before the prompt left: the POST, a stat of
// the job cancel record and a read of archived-chats.json, one after the other, and at box load 430 each turn waited 15 to 30 ms behind the
// catalog's projections. This pins the owner's send to a listed chat to the turn its POST came in.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { writesThroughClient } from "./keyed-writes.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobCancelRecord } from "../src/job-cancels.ts";
import { OwnerOutbox } from "../src/owner-outbox.ts";
import { source } from "./chats-helpers.ts";

/** Counts event-loop turns: a setImmediate that sets itself again runs once in each turn's check phase. */
function turns(t: TestContext): () => number {
  let count = 0;
  let timer = setImmediate(function tick() { count++; timer = setImmediate(tick); });
  t.after(() => clearImmediate(timer));
  return () => count;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "owner-send-turn-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendCustomEntry("chat_mode", { v: 1 });
  manager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const live: SessionSummary = { id: "live-worker", sessionId: id, activeSessionId: "live-worker", sessionFile: file, cwd: dir, lifecycle: "live", workerState: "ready",
    activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1, sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index"), archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  await index.add(id);
  await archived.add("01a0archived-other-chat");
  const prompts: { message: string; turn: number }[] = [];
  let now = () => -1;
  let chats!: Chats;
  const catalog = new Catalog("/isolated-owner-send.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: () => chats.ids(), checkIns: async () => new Map(), archivedIds: () => chats.archivedIds(),
      links: async () => ({ children: [], board: null, roots: [], messages: [] }) }, new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  writesThroughClient(t);
  t.mock.method(DaemonClient.prototype, "request", async (command: { type: string; message?: string }) => {
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [live] } };
      case "prompt": prompts.push({ message: command.message!, turn: now() }); return { success: true };
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      default: return { success: true, data: null };
    }
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-owner-send.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  chats = new Chats(index, hub, sessionId => catalog.summary(sessionId), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), archived, cancels: jobCancelRecord(join(dir, "job-cancels.json")) });
  await chats.ids();
  // The catalog reads archived-chats.json on each projection, so a live service always holds a read of it.
  await chats.archivedIds();
  const outbox = new OwnerOutbox(join(dir, "outbox"), { threads: hub, chats, catalog }, () => {}, { sleep: () => new Promise(done => setTimeout(done, 5)) });
  const backend = { chats, threads: hub, catalog, outbox,
    close: async () => { await outbox.close(); chats.close(); await hub.close(); await catalog.close(); } } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-owner-send.sock" }, onStop: async () => {} });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  // The route's first call that names the thread marks the turn its POST came in.
  let posted = -1;
  const reopenJob = chats.reopenJob.bind(chats);
  t.mock.method(chats, "reopenJob", (thread: string) => { if (posted < 0) posted = now(); return reopenJob(thread); });
  const post = (requestId: string, message: string) => fetch(server.url + `api/threads/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" },
    body: JSON.stringify({ requestId, message, images: [], mode: "followUp" }) });
  return { id, archived, prompts, outbox, post, posted: () => posted, count: (counter: () => number) => { now = counter; } };
}

test("an owner send to a listed chat reaches the daemon in the turn its POST came in, with no file step before it", async t => {
  const f = await fixture(t);
  const turn = turns(t);
  f.count(turn);
  const res = await f.post("owner-send-turn-0001", "ok?");
  assert.equal(res.status, 200, await res.clone().text());
  await f.outbox.outbox.idle();
  assert.deepEqual(f.prompts.map(prompt => prompt.message), ["ok?"]);
  assert.ok(f.posted() >= 0, "the route named the thread");
  assert.equal(f.prompts[0]!.turn - f.posted(), 0, `the prompt left ${f.prompts[0]!.turn - f.posted()} turns after the POST came in`);
});

test("IdIndex.known holds the last read or write, and drops a read that a write overlapped", async t => {
  const dir = await mkdtemp(join(tmpdir(), "id-index-known-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  assert.equal(archived.known(), undefined);
  assert.deepEqual([...(await archived.ids(), archived.known()!)], []);
  await archived.add("a");
  assert.deepEqual([...archived.known()!], ["a"]);
  const read = archived.ids();
  const write = archived.add("b");
  await Promise.all([read, write]);
  assert.deepEqual([...archived.known()!].sort(), ["a", "b"]);
  await archived.forget("a");
  assert.deepEqual([...archived.known()!], ["b"]);
});
