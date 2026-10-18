import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { source } from "./chats-helpers.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";

const chat = "01a14bcc-27a8-719f-bf2d-06519218c7eb";
const child = "01a14bcc-f1ee-7124-aedd-4ae3f0096d73";
const caller = "01a14bc8-861e-75b8-b9a1-5d6a977901a9";

async function fixture(archive: (id: string) => Promise<void>) {
  const backend = { chats: { ids: async () => new Set([chat]), archive }, threads: { archive }, catalog: { notify: async () => {} }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/none" }, onStop: async () => {} });
  return { ...server, post: (id: string, headers: Record<string, string> = {}) => fetch(server.url + `api/threads/${id}/archive`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token", ...headers }, body: JSON.stringify({ ignored: "body-secret" }),
  }) };
}

test("archive audit records exact targets and unverified claims without request secrets", async t => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  const archived: string[] = [];
  const server = await fixture(async id => {
    assert.equal(JSON.parse(lines.at(-1)!).outcome, "started");
    archived.push(id);
  });
  try {
    for (const id of [chat, child]) {
      const response = await server.post(id, { "x-chat-agent-session": caller, "user-agent": "node", cookie: "cookie-secret", authorization: "Bearer auth-secret", "x-other": "other-secret" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.deepEqual(archived, [chat, child]);
    const events = lines.map(line => JSON.parse(line));
    assert.equal(events.length, 4);
    for (const [index, id] of [chat, child].entries()) {
      const [start, end] = events.slice(index * 2, index * 2 + 2);
      assert.deepEqual([start.outcome, end.outcome], ["started", "completed"]);
      assert.equal(start.targetSessionId, id);
      assert.equal(end.targetSessionId, id);
      assert.equal(start.requestId, end.requestId);
      assert.match(start.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(start.event, "chat_archive");
      assert.deepEqual(start.unverifiedClientClaims, { sessionId: caller, userAgent: "node" });
      assert(Number.isFinite(Date.parse(start.at)));
      assert(Number.isFinite(Date.parse(end.at)));
    }
    assert.notEqual(events[0].requestId, events[2].requestId);
    assert(!lines.join("").includes("secret"));
    assert(!lines.join("").includes("test-token"));
    const before = lines.length;
    assert.equal((await server.post(chat, { "x-chat-token": "wrong" })).status, 403);
    assert.equal(lines.length, before);
    assert.deepEqual(archived, [chat, child]);
  } finally { await server.close(); }
});

test("archive audit records failure without serializing errors or invalid client claims", async t => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  const server = await fixture(async () => { throw new Error("backend-secret"); });
  try {
    const response = await server.post(chat, { "x-chat-agent-session": "invalid-secret", "user-agent": "unknown-secret" });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "backend-secret" });
    const events = lines.map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.outcome), ["started", "failed"]);
    assert.equal(events[0].requestId, events[1].requestId);
    assert.deepEqual(events[0].unverifiedClientClaims, { sessionId: null, userAgent: "other" });
    assert(!lines.join("").includes("secret"));
  } finally { await server.close(); }
});

test("a failed audit write does not block a valid archive", async t => {
  t.mock.method(process.stderr, "write", () => { throw new Error("audit unavailable"); });
  const archived: string[] = [];
  const server = await fixture(async id => { archived.push(id); });
  try {
    assert.equal((await server.post(child)).status, 200);
    assert.deepEqual(archived, [child]);
  } finally { await server.close(); }
});

for (const failure of ["refresh", "notification", "reply"] as const) {
  test(`archive keeps disk state and chat indexes consistent when ${failure} fails, and a retry is safe`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "archive-transaction-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
    manager.flushNow();
    const id = manager.getSessionId();
    const file = manager.getSessionFile()!;
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
    await index.add(id);
    const summary: SessionSummary = { id: "fixture-active", sessionId: id, activeSessionId: "fixture-active", sessionFile: file, cwd: dir, lifecycle: "live",
      activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
      sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
    const abort = new AbortController();
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const logs: string[] = [];
    t.mock.method(process.stderr, "write", (line: string) => {
      logs.push(line);
      if (line.startsWith('{"event":"chat_archive"') && JSON.parse(line).outcome === "completed") complete();
      return true;
    });
    let kills = 0, lists = 0;
    let failNotification = failure === "notification";
    const catalog = new Catalog("/none", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
      { ids: async () => new Set(await index.ids()), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) }, new ThreadOrigins({ ids: async () => [] }));
    t.mock.method(catalog, "connect", async () => {});
    t.mock.method(catalog, "notify", async () => { if (failNotification) throw new Error("notification unavailable"); });
    t.mock.method(catalog.client, "request", async (command: { type: string }) => {
      if (command.type === "list") {
        if (++lists === 1) return { success: true, data: { sessions: [summary] } };
        throw new Error("daemon list unavailable");
      }
      assert.equal(command.type, "kill");
      kills++;
      SessionManager.open(file).appendSessionState({ status: "archived" });
      if (failure === "reply") abort.abort();
      return { success: true };
    });
    await catalog.refresh();
    const hub = new ThreadHub("/none", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
    const chats = new Chats(index, hub, id => catalog.summary(id), "test", loadRecord(join(dir, "loads.json")), { ...source(dir), archived });
    const backend = { chats, threads: hub, catalog, close: async () => { chats.close(); await hub.close(); await catalog.close(); } } as unknown as ChatBackend;
    const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
    const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
      identity: { pid: process.pid, instanceId: "test", socketPath: "/none" }, onStop: async () => {} });
    const post = (signal?: AbortSignal) => fetch(server.url + `api/threads/${id}/archive`, {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" }, body: "{}", ...(signal ? { signal } : {}),
    });
    try {
      if (failure === "reply") { await assert.rejects(post(abort.signal), { name: "AbortError" }); await completed; }
      else assert.equal((await post()).status, failure === "notification" ? 502 : 200);
      assert.equal(SessionManager.open(file).getSessionState()?.status, "archived");
      assert.deepEqual(await index.ids(), []);
      assert.deepEqual(await archived.ids(), [id]);
      assert.equal((await catalog.summary(id))?.lifecycle, "archived");
      assert.equal((await catalog.summary(id))?.activeSessionId, undefined);
      assert.equal(lists, 2);
      assert(logs.some(line => line.startsWith("catalog: full list failed") && line.includes("daemon list unavailable")));
      failNotification = false;
      assert.equal((await post()).status, 200);
      assert.equal(SessionManager.open(file).getSessionState()?.status, "archived");
      assert.deepEqual(await index.ids(), []);
      assert.deepEqual(await archived.ids(), [id]);
      const reopened = await hub.open(id);
      assert.equal(reopened.live, null);
      assert.equal(reopened.state.kind, "saved");
      assert.equal(kills, 1);
      assert.equal(lists, 2);
      catalog.holdLifecycle(id, "active");
      assert.equal((await catalog.summary(id))?.activeSessionId, "fixture-active");
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const failure of ["kill", "write"] as const) test(`a failed ${failure} still rejects archive without recording completion`, async t => {
  t.mock.method(process.stderr, "write", () => true);
  const dir = await mkdtemp(join(tmpdir(), "archive-refused-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 }); manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  await index.add(id);
  const catalog = { summary: async () => ({ sessionId: id, activeSessionId: "fixture-active", sessionFile: file }), connect: async () => {}, hostOf: () => null, daemonPath: (row: { sessionFile?: string }) => row.sessionFile,
    client: { request: async () => failure === "kill" ? { success: false, error: "kill refused" } : { success: true } } } as unknown as Catalog;
  const hub = new ThreadHub("/none", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const chats = new Chats(index, hub, async () => undefined, "test", loadRecord(join(dir, "loads.json")), { ...source(dir), archived });
  try {
    const failingWrite = failure === "write" ? t.mock.method(SessionManager, "open", () => { throw new Error("session write refused"); }) : undefined;
    await assert.rejects(chats.archive(id), failure === "kill" ? /kill refused/ : /session write refused/);
    failingWrite?.mock.restore();
    assert.notEqual(SessionManager.open(file).getSessionState()?.status, "archived");
    assert.deepEqual(await index.ids(), [id]);
    assert.deepEqual(await archived.ids(), []);
  } finally { chats.close(); await hub.close(); await rm(dir, { recursive: true, force: true }); }
});
