// Guards the 10-17 22:37Z clean-room run-4 failure: the owner's first message after an archive and reopen got a 502 before the worker attached.
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
import { ThreadHub } from "../src/chat-threads.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "reopen-route-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "original history", timestamp: 1 });
  manager.appendSessionState({ status: "archived" });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const saved: SessionSummary = { id, sessionId: id, sessionFile: file, cwd: dir, lifecycle: "archived", activity: "idle",
    isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  const live: SessionSummary = { ...saved, id: "resumed-worker", activeSessionId: "resumed-worker", lifecycle: "live", workerState: "ready" };
  const creating = latch(), createReady = latch(), attaching = latch(), attachReady = latch(), accepted = latch(), replyReady = latch();
  const calls: { type: string; message?: string; streamingBehavior?: string; activeSessionId?: string }[] = [];
  let responseData: unknown = live;
  let listed = saved;
  const catalog = new Catalog("/isolated-reopen.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set([id]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) }, new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "request", async (command: typeof calls[number]) => {
    calls.push(command);
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [listed] } };
      case "create": creating.resolve(); await createReady.promise; return { success: true, data: responseData };
      case "attach": {
        attaching.resolve(); await attachReady.promise;
        SessionManager.open(file).appendSessionState({ status: "active" });
        return { success: true, data: { activeSessionId: live.activeSessionId, snapshot: { summary: live,
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null,
            isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1,
            sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "original history", timestamp: 1 }], children: [] } } };
      }
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      case "prompt":
        { const writer = SessionManager.open(file); writer.appendMessage({ role: "user", content: command.message!, timestamp: 2 }); writer.flushNow(); }
        accepted.resolve(); await replyReady.promise; return { success: true };
      case "detach": case "kill": return { success: true };
      default: throw new Error(`Unexpected daemon command ${command.type}`);
    }
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-reopen.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const backend = { chats: { ids: async () => new Set([id]) }, threads: hub, catalog,
    close: async () => { await hub.close(); await catalog.close(); } } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-reopen.sock" }, onStop: async () => {} });
  const post = (requestId = "reopen-owner-message-1", message = "first message after reopen", signal?: AbortSignal) => fetch(server.url + `api/threads/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" },
    body: JSON.stringify({ requestId, message, images: [], mode: "followUp" }), ...(signal ? { signal } : {}),
  });
  return { id, file, hub, catalog, calls, creating, createReady, attaching, attachReady, accepted, replyReady, post,
    publish: () => { listed = live; }, response: (data: unknown) => { responseData = data; },
    close: async () => { createReady.resolve(); attachReady.resolve(); replyReady.resolve(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("the first owner POST waits for the resumed snapshot even while the catalog still lists the archived session", async t => {
  const f = await fixture(t);
  try {
    let settled = false;
    const response = f.post().then(value => { settled = true; return value; });
    await f.creating.promise;
    assert.equal(settled, false);
    f.createReady.resolve();
    const phase = await Promise.race([f.attaching.promise.then(() => "attach"), response.then(async res => `${res.status} ${await res.clone().text()}`)]);
    assert.equal(phase, "attach");
    assert.equal(settled, false);
    assert.equal(f.calls.filter(c => c.type === "prompt").length, 0);
    f.attachReady.resolve(); f.replyReady.resolve();
    const res = await response;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: true });
    assert.equal((await f.catalog.summary(f.id))?.activeSessionId, undefined, "catalog freshness is not required for delivery");
    assert.deepEqual(f.calls.filter(c => c.type === "prompt").map(c => [c.activeSessionId, c.message, c.streamingBehavior]),
      [["resumed-worker", "first message after reopen", "steer"]]);
    assert.equal(f.hub.state(f.id)?.info.sessionId, f.id);
    assert.equal(f.hub.state(f.id)?.messages.length, 1);
    assert.equal(SessionManager.open(f.file).getSessionState()?.status, "active");
  } finally { await f.close(); }
});

test("a lost HTTP response after acceptance and concurrent same-ID retries deliver one owner message", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve();
    const abort = new AbortController();
    const first = f.post(undefined, undefined, abort.signal);
    await f.accepted.promise;
    abort.abort();
    await assert.rejects(first, { name: "AbortError" });
    const retry = f.post();
    f.replyReady.resolve();
    assert.equal((await retry).status, 200);
    assert.equal((await f.post()).status, 200);
    assert.equal((await f.post(undefined, "different message")).status, 409);
    assert.equal(f.calls.filter(c => c.type === "prompt").length, 1);
    const users = SessionManager.open(f.file).getBranch().filter(e => e.type === "message" && e.message.role === "user");
    assert.equal(users.length, 2, "original history and the first reopened message remain once each");
  } finally { await f.close(); }
});

for (const data of [{}, { sessionId: "another-chat", activeSessionId: "wrong-worker" }, { activeSessionId: "wrong-worker" }]) {
  test(`a resume response with no matching identity is rejected without sending: ${JSON.stringify(data)}`, async t => {
    const f = await fixture(t);
    try {
      f.response(data); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
      const res = await f.post();
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "Prime Agent returned no matching session for the resumed thread." });
      assert.equal(f.calls.filter(c => c.type === "attach" || c.type === "prompt").length, 0);
    } finally { await f.close(); }
  });
}

for (const reopen of [false, true]) test(`archiving during resume cancels the old send${reopen ? " even after another open" : ""}`, async t => {
  const f = await fixture(t);
  try {
    const response = f.post();
    f.createReady.resolve();
    const phase = await Promise.race([f.attaching.promise.then(() => "attach"), response.then(res => `HTTP ${res.status}`)]);
    assert.equal(phase, "attach");
    await f.hub.archive(f.id);
    const replacement = reopen ? await f.hub.open(f.id, false, false) : undefined;
    f.attachReady.resolve(); f.replyReady.resolve();
    const res = await response;
    assert.equal(res.status, 409);
    assert.equal(f.calls.filter(c => c.type === "prompt").length, 0);
    assert.equal(f.hub.state(f.id), replacement?.state);
    assert.equal(f.calls.filter(c => c.type === "detach").length, 1);
  } finally { await f.close(); }
});
