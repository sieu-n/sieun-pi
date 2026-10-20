// Guards the 10-17 22:37Z clean-room run-4 failure: the owner's first message after an archive and reopen got a 502 before the worker attached.
// Also guards 10-18 run-2: that message was answered, but the chat stayed in archived-chats.json and GET agents answered 404 "This thread is not a chat."
// Since 10-18 08:16Z the route answers once the send is on disk (src/outbox.ts), so these tests wait for the outbox and read its entries.
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
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { OwnerOutbox } from "../src/owner-outbox.ts";
import { source } from "./chats-helpers.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "reopen-route-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendCustomEntry("chat_mode", { v: 1 });
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
  const steering = latch(), steeringReady = latch(), detached = latch();
  let holdSteering = false, holdKill = false, promptTimesOut = false;
  const killing = latch(), killReady = latch();
  let killAnswer: { success: true } | { success: false; error: string } = { success: true };
  let responseData: unknown = live;
  let listed = saved;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index"), archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  await archived.add(id);
  let chats!: Chats;
  const catalog = new Catalog("/isolated-reopen.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: () => chats.ids(), checkIns: async () => new Map(), archivedIds: () => chats.archivedIds(),
      links: async () => ({ children: [], board: null, roots: [], messages: [] }) }, new ThreadOrigins({ ids: async () => [] }));
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
        accepted.resolve(); await replyReady.promise;
        if (promptTimesOut) { promptTimesOut = false; throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "prompt".'); }
        return { success: true };
      case "set_steering_mode": if (holdSteering) { steering.resolve(); await steeringReady.promise; } return { success: true };
      case "detach": detached.resolve(); return { success: true };
      case "kill": if (holdKill) { killing.resolve(); await killReady.promise; } return killAnswer;
      case "get_heartbeat": return { success: true, data: null };
      default: throw new Error(`Unexpected daemon command ${command.type}`);
    }
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-reopen.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  chats = new Chats(index, hub, sessionId => catalog.summary(sessionId), "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir), archived });
  const outbox = new OwnerOutbox(join(dir, "outbox"), { threads: hub, chats, catalog }, line => process.stderr.write(`${line}\n`),
    { sleep: () => new Promise(done => setTimeout(done, 5)) });
  const backend = { chats, threads: hub, catalog, outbox,
    close: async () => { await outbox.close(); chats.close(); await hub.close(); await catalog.close(); } } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-reopen.sock" }, onStop: async () => {} });
  const post = (requestId = "reopen-owner-message-1", message = "first message after reopen", signal?: AbortSignal) => fetch(server.url + `api/threads/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" },
    body: JSON.stringify({ requestId, message, images: [], mode: "followUp" }), ...(signal ? { signal } : {}),
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { createReady.resolve(); attachReady.resolve(); replyReady.resolve(); steeringReady.resolve(); killReady.resolve(); await server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); })();
  t.after(close);
  const archive = () => fetch(server.url + `api/threads/${id}/archive`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" }, body: "{}" });
  const agents = () => fetch(server.url + `api/threads/${id}/agents`, { headers: { origin: new URL(server.url).origin, "x-chat-token": "test-token" } });
  const membership = async () => ({ chats: await index.ids(), archived: await archived.ids() });
  const delivered = () => outbox.outbox.idle();
  const entries = () => outbox.outbox.view(id);
  return { id, file, hub, catalog, chats, calls, agents, delivered, entries, timeOutPrompt: () => { promptTimesOut = true; }, membership, archive, steering, steeringReady, detached, holdSteering: () => { holdSteering = true; }, killing, killReady,
    holdKill: () => { holdKill = true; }, failKill: (error: string) => { killAnswer = { success: false, error }; }, creating, createReady, attaching, attachReady, accepted, replyReady, post,
    publish: () => { listed = live; }, response: (data: unknown) => { responseData = data; },
    close };
}

const prompts = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.type === "prompt");
async function until(check: () => boolean) { while (!check()) await new Promise(done => setTimeout(done, 5)); }

test("the first owner POST answers once the send is on disk, and the send goes after the resumed snapshot", async t => {
  const f = await fixture(t);
  try {
    const res = await f.post();
    assert.equal(res.status, 200);
    const body = await res.json() as { accepted: boolean; outbox: { id: string; state: string } };
    assert.equal(body.accepted, true);
    assert.equal(body.outbox.id, "reopen-owner-message-1");
    assert.ok(body.outbox.state === "queued" || body.outbox.state === "sending");
    await f.creating.promise;
    f.createReady.resolve();
    await f.attaching.promise;
    assert.equal(prompts(f).length, 0);
    f.attachReady.resolve(); f.replyReady.resolve();
    await f.delivered();
    assert.equal((await f.catalog.summary(f.id))?.activeSessionId, undefined, "catalog freshness is not required for delivery");
    assert.deepEqual(prompts(f).map(c => [c.activeSessionId, c.message, c.streamingBehavior]), [["resumed-worker", "first message after reopen", "steer"]]);
    assert.deepEqual(f.entries(), []);
    assert.equal(f.hub.state(f.id)?.info.sessionId, f.id);
    assert.equal(f.hub.state(f.id)?.messages.length, 1);
    assert.equal(SessionManager.open(f.file).getSessionState()?.status, "active");
  } finally { await f.close(); }
});

test("the owner's first message to a chat he archived reopens it: same session and history, back in chats.json and the agents route", async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.agents()).status, 404, "an archived chat is not a chat");
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    assert.equal((await f.post()).status, 200);
    await f.delivered();
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
    assert.ok((await f.chats.ids()).has(f.id));
    const agents = await f.agents();
    assert.equal(agents.status, 200, await agents.clone().text());
    assert.deepEqual(prompts(f).map(c => [c.activeSessionId, c.message, c.streamingBehavior]), [["resumed-worker", "first message after reopen", "steer"]]);
    const users = SessionManager.open(f.file).getBranch().flatMap(e => e.type === "message" && e.message.role === "user" ? [e.message.content] : []);
    assert.deepEqual(users, ["original history", "first message after reopen"]);
    assert.equal(f.hub.state(f.id)?.info.sessionId, f.id);
    assert.equal((await f.catalog.rows()).find(row => row.id === f.id)?.archived, false);
    assert.equal((await f.post("reopen-owner-message-2", "second message")).status, 200, "a second send to the reopened chat");
    await f.delivered();
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
  } finally { await f.close(); }
});

test("concurrent owner sends with different request ids reopen the chat once and deliver both", async t => {
  const f = await fixture(t);
  try {
    f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    const answers = await Promise.all([f.post("reopen-owner-message-a", "message a"), f.post("reopen-owner-message-b", "message b")]);
    assert.deepEqual(answers.map(res => res.status), [200, 200]);
    await f.delivered();
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
    assert.equal(f.calls.filter(c => c.type === "create").length, 1);
    assert.deepEqual(prompts(f).map(c => c.message), ["message a", "message b"], "one thread's sends go in the order they came");
  } finally { await f.close(); }
});

test("a message that resumes an archived chat outside the owner's send route leaves it archived", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    await f.hub.prompt(f.id, { message: "a board.wake note", images: [], mode: "steer" }, "wake");
    assert.deepEqual(await f.membership(), { chats: [], archived: [f.id] });
    assert.equal((await f.agents()).status, 404);
  } finally { await f.close(); }
});

test("a sidebar update that fails after the reopen does not hold the first message back", async t => {
  const f = await fixture(t);
  try {
    const errors: string[] = [];
    t.mock.method(f.catalog, "notify", async () => { throw new Error("catalog notify failed"); });
    const write = process.stderr.write.bind(process.stderr);
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array, ...rest: never[]) => { errors.push(String(chunk)); return write(chunk, ...rest); });
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    assert.equal((await f.post()).status, 200);
    await f.delivered();
    await new Promise(done => setImmediate(done));
    assert.deepEqual(prompts(f).map(c => c.message), ["first message after reopen"]);
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
    assert.ok(errors.some(line => line.includes(`chat ${f.id.slice(0, 8)}: reopen: sidebar update: catalog notify failed`)), errors.join(""));
  } finally { await f.close(); }
});

test("an archive that lands after the attach, while the reopen writes the chat list, stops the older send, also with a new thread open", async t => {
  const f = await fixture(t);
  try {
    f.holdSteering(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    assert.equal((await f.post()).status, 200);
    await f.steering.promise;
    const archived = f.archive();
    await f.detached.promise;
    const replacement = await f.hub.open(f.id, false, false);
    f.steeringReady.resolve();
    await f.delivered();
    assert.deepEqual(f.entries().map(entry => [entry.state, entry.error]), [["failed", "The chat was archived before this message went."]]);
    assert.equal((await archived).status, 200);
    assert.equal(prompts(f).length, 0);
    assert.equal(f.calls.filter(c => c.type === "create").length, 1, "no worker starts again for the archived chat");
    assert.deepEqual(await f.membership(), { chats: [], archived: [f.id] });
    assert.equal(SessionManager.open(f.file).getSessionState()?.status, "archived");
    assert.notEqual(f.hub.state(f.id), replacement.state, "the reopen archived the session again after the replacement opened");
    assert.equal((await f.agents()).status, 404);
  } finally { await f.close(); }
});

test("an archive through the route while the reopen resumes keeps the chat archived and sends nothing", async t => {
  const f = await fixture(t);
  try {
    f.replyReady.resolve();
    assert.equal((await f.post()).status, 200);
    f.createReady.resolve();
    await f.attaching.promise;
    const archived = f.archive();
    while (f.chats.archives(f.id) === 0) await new Promise(done => setTimeout(done, 5));
    f.attachReady.resolve();
    assert.equal((await archived).status, 200);
    await f.delivered();
    assert.deepEqual(f.entries().map(entry => entry.state), ["failed"]);
    assert.equal(prompts(f).length, 0);
    assert.deepEqual(await f.membership(), { chats: [], archived: [f.id] });
    assert.equal(SessionManager.open(f.file).getSessionState()?.status, "archived");
  } finally { await f.close(); }
});

test("an owner send that comes in while an older archive still stops the worker is the last word: no stale archive write follows it", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    assert.equal((await f.post("reopen-owner-message-first", "first")).status, 200);
    await f.delivered();
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
    f.holdKill();
    const archived = f.archive();
    await f.killing.promise;
    assert.equal((await f.post("reopen-owner-message-after-archive", "sent after the archive")).status, 200);
    await new Promise(done => setTimeout(done, 50));
    f.killReady.resolve();
    assert.equal((await archived).status, 200);
    await f.delivered();
    await new Promise(done => setTimeout(done, 50));
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] }, "the newer send reopened the chat after the archive's writes");
    assert.deepEqual(prompts(f).map(c => c.message), ["first", "sent after the archive"]);
    assert.equal((await f.agents()).status, 200);
  } finally { await f.close(); }
});

test("a kill the daemon refuses fails the archive route and writes no archive into the chat list", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
    assert.equal((await f.post("reopen-owner-message-first", "first")).status, 200);
    await f.delivered();
    f.failKill("worker refused the kill");
    const archived = await f.archive();
    assert.equal(archived.status, 502, await archived.clone().text());
    assert.deepEqual(await archived.json(), { error: "worker refused the kill" });
    assert.deepEqual(await f.membership(), { chats: [f.id], archived: [] });
  } finally { await f.close(); }
});

test("same-ID resends while the prompt is out and after it went deliver one owner message", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve();
    assert.equal((await f.post()).status, 200);
    await f.accepted.promise;
    const retry = await f.post();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { outbox: { state: string } }).outbox.state, "sending");
    f.replyReady.resolve();
    await f.delivered();
    const after = await f.post();
    assert.equal((await after.json() as { outbox: { state: string } }).outbox.state, "delivered");
    assert.equal((await f.post(undefined, "different message")).status, 409);
    assert.equal(prompts(f).length, 1);
    const users = SessionManager.open(f.file).getBranch().filter(e => e.type === "message" && e.message.role === "user");
    assert.equal(users.length, 2, "original history and the first reopened message remain once each");
  } finally { await f.close(); }
});

test("a prompt that times out after it reached the session file is found there and not sent again", async t => {
  const f = await fixture(t);
  try {
    f.publish(); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve(); f.timeOutPrompt();
    assert.equal((await f.post()).status, 200);
    await f.delivered();
    assert.equal(prompts(f).length, 1);
    assert.deepEqual(f.entries(), []);
    const users = SessionManager.open(f.file).getBranch().filter(e => e.type === "message" && e.message.role === "user");
    assert.equal(users.length, 2);
  } finally { await f.close(); }
});

for (const data of [{}, { sessionId: "another-chat", activeSessionId: "wrong-worker" }, { activeSessionId: "wrong-worker" }]) {
  test(`a resume response with no matching identity sends nothing and keeps the send queued: ${JSON.stringify(data)}`, async t => {
    const f = await fixture(t);
    try {
      f.response(data); f.createReady.resolve(); f.attachReady.resolve(); f.replyReady.resolve();
      assert.equal((await f.post()).status, 200);
      await until(() => f.calls.filter(c => c.type === "create").length >= 3);
      assert.equal(f.entries().length, 1);
      assert.ok(["queued", "sending"].includes(f.entries()[0]!.state), "a 502 from the daemon is tried again, never a failure");
      assert.equal(f.calls.filter(c => c.type === "attach" || c.type === "prompt").length, 0);
      assert.deepEqual(await f.membership(), { chats: [], archived: [f.id] }, "a failed resume leaves the chat archived");
      assert.equal((await f.agents()).status, 404);
    } finally { await f.close(); }
  });
}

for (const reopen of [false, true]) test(`archiving during resume cancels the old send${reopen ? " even after another open" : ""}`, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.post()).status, 200);
    f.createReady.resolve();
    await f.attaching.promise;
    await f.hub.archive(f.id, "owner");
    const replacement = reopen ? await f.hub.open(f.id, false, false) : undefined;
    f.attachReady.resolve(); f.replyReady.resolve();
    await f.delivered();
    assert.deepEqual(f.entries().map(entry => entry.state), ["failed"]);
    assert.equal(prompts(f).length, 0);
    assert.equal(f.hub.state(f.id), replacement?.state);
    assert.equal(f.calls.filter(c => c.type === "detach").length, 1);
    assert.deepEqual(await f.membership(), { chats: [], archived: [f.id] }, "an archive during the resume keeps the chat archived");
  } finally { await f.close(); }
});
