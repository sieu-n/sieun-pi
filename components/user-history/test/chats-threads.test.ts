import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { AttachQueue, ThreadHub } from "../src/chat-threads.ts";
import { isThreadBusy, isTurnRunning } from "../src/shared/thread-state.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ThreadState } from "../src/shared/types.ts";
import { fileOrigin, ThreadOrigins } from "../src/thread-origin.ts";

test("id index: add puts the newest first once, forget removes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  assert.deepEqual(await index.ids(), []);
  await index.add("a");
  await index.add("b");
  await index.add("a");
  assert.deepEqual(await index.ids(), ["b", "a"]);
  await index.forget("b");
  await index.forget("zzz");
  assert.deepEqual(await index.ids(), ["a"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "chats.json"), "utf8")), { ids: ["a"] });
});

test("id index: a file it cannot parse fails the write and stays on disk; it is never replaced by an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const path = join(dir, "chats.json");
  await writeFile(path, '{"ids":["a","b"');
  const index = new IdIndex(path, "Chat index");
  await assert.rejects(index.add("c"));
  await assert.rejects(index.ids());
  assert.equal(await readFile(path, "utf8"), '{"ids":["a","b"');
});

const header = JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-10-03T10:23:48Z", cwd: "/repo", rlmDepth: 0 });
const info = JSON.stringify({ type: "session_info", id: "i", timestamp: "2026-10-03T10:23:50Z", name: "md-count" });
const state = JSON.stringify({ type: "session_state", id: "s", timestamp: "2026-10-03T10:23:50Z", state: { status: "active" } });
const digest = JSON.stringify({ type: "custom_message", id: "d", customType: "harness_digest", content: "x".repeat(70000) });
const message = JSON.stringify({ type: "message", id: "m", message: { role: "user", content: "Job: count the Markdown files", timestamp: 1 } });

test("origin: a root named at create (rlm.create_session) is the agent's; one named after its state entry or never named is the person's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "origin-"));
  const file = (name: string, lines: string[]) => { const path = join(dir, name); return writeFile(path, lines.join("\n") + "\n").then(() => path); };
  const agent = await file("agent.jsonl", [header, info, state, digest, message]);
  const renamed = await file("renamed.jsonl", [header, state, info, digest, message]);
  const unnamed = await file("unnamed.jsonl", [header, state, digest, message]);
  const legacyAgent = await file("legacy-agent.jsonl", [header, info, message]);
  const legacyUser = await file("legacy-user.jsonl", [header, message, info]);
  const fresh = await file("fresh.jsonl", [header, info]);
  assert.deepEqual(fileOrigin(agent), { origin: "agent", final: true });
  assert.deepEqual(fileOrigin(renamed), { origin: "user", final: true }, "a name after session_state is a rename");
  assert.deepEqual(fileOrigin(unnamed), { origin: "user", final: true });
  assert.deepEqual(fileOrigin(legacyAgent), { origin: "agent", final: true }, "no session_state: the name precedes the first message");
  assert.deepEqual(fileOrigin(legacyUser), { origin: "user", final: true });
  assert.deepEqual(fileOrigin(fresh), { origin: "agent", final: false }, "no state or message yet: asked again next time");
  assert.deepEqual(fileOrigin(join(dir, "missing.jsonl")), { origin: "user", final: false });

  const created = new IdIndex(join(dir, "threads.json"), "Thread index");
  await created.add("own");
  const origins = new ThreadOrigins(created);
  let resolve = await origins.resolver(new Set(["chat"]));
  assert.equal(resolve({ sessionId: "own", sessionFile: agent }), "user", "a thread this server created wins over its file");
  assert.equal(resolve({ sessionId: "chat", sessionFile: agent }), "user", "a chat is named at create and still the person's");
  assert.equal(resolve({ sessionId: "a", sessionFile: agent }), "agent");
  assert.equal(resolve({ sessionId: "f", sessionFile: fresh }), "agent");
  assert.equal(resolve({ sessionId: "n" }), "user", "no file, nothing says otherwise");
  await writeFile(agent, [header, state, info, message].join("\n") + "\n");
  await writeFile(fresh, [header, info, state, message].join("\n") + "\n");
  resolve = await origins.resolver(new Set());
  assert.equal(resolve({ sessionId: "a", sessionFile: agent }), "agent", "a final decision is kept; the head of a session file does not change");
  assert.equal(resolve({ sessionId: "f", sessionFile: fresh }), "agent", "an open decision is read again");
  assert.deepEqual(fileOrigin(fresh), { origin: "agent", final: true });
});

test("thread hub: running ignores queued input that busy counts; restart sends the text, then resumes the session's queued input", async () => {
  const info = { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 2 } as unknown as ThreadState["info"];
  assert.equal(isTurnRunning(info), false, "two steers queued behind a failed turn, nothing running");
  assert.equal(isThreadBusy({ info, queue: { steering: [], followUp: [] }, children: [], tools: [] }), true);
  assert.equal(isTurnRunning({ ...info, retryAttempt: 1 }), true, "an auto-retry of a 429 is still the turn");
  assert.equal(isTurnRunning({ ...info, isStreaming: true }), true);
  const hub = new ThreadHub("/nonexistent.sock", {} as Catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const calls: string[] = [];
  hub.prompt = async (id, input) => { calls.push(`prompt ${id} ${input.mode} ${input.message}`); };
  hub.resumeQueue = async id => { calls.push(`resume ${id}`); };
  await hub.restart("c1", "[check-in] Your last turn failed (429). Re-check the board and continue.");
  assert.deepEqual(calls, ["prompt c1 steer [check-in] Your last turn failed (429). Re-check the board and continue.", "resume c1"]);
  calls.length = 0;
  hub.abort = async id => { calls.push(`abort ${id}`); };
  await hub.restart("t1", "continue", true);
  assert.deepEqual(calls, ["abort t1", "prompt t1 steer continue", "resume t1"], "the way the owner unstuck a session by hand: abort, a steer, resume the queue");
  await hub.close();
});

test("attach queue: background attaches run two at a time in order; a foreground one starts at once and counts; promote starts a waiting one", async () => {
  const queue = new AttachQueue(2);
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (key: string, background: boolean) => queue.run(key, background, () => new Promise<void>(done => { log.push(key); gates.set(key, done); }));
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const runs = ["a", "b", "c", "d", "e"].map(key => job(key, true));
  await flush();
  assert.deepEqual(log, ["a", "b"], "two background attaches at a time");
  const tab = job("tab", false);
  await flush();
  assert.deepEqual(log, ["a", "b", "tab"], "a foreground attach does not wait");
  gates.get("a")!();
  await flush();
  assert.deepEqual(log, ["a", "b", "tab"], "the foreground one holds a slot");
  queue.promote("e");
  await flush();
  assert.deepEqual(log, ["a", "b", "tab", "e"], "a tab opening a waiting chat starts it");
  for (const key of ["b", "tab", "e"]) gates.get(key)!();
  await flush();
  assert.deepEqual(log, ["a", "b", "tab", "e", "c", "d"], "the rest in order");
  gates.get("c")!(); gates.get("d")!();
  await Promise.all([...runs, tab]);
});

test("thread hub: after a restart the pinned chats attach two at a time in pin order, an open tab goes first, and a failed attach waits before its retry", async () => {
  let fire: (event: { daemon: string }) => void = () => {};
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live" }), hostOf: () => null, daemonPath: (row: { sessionFile?: string }) => row.sessionFile,
    subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const started: string[] = [];
  const finish = new Map<string, (error?: Error) => void>();
  let running = 0, peak = 0;
  const connection = { subscribe: () => () => {}, dispose: async () => {} };
  const internals = hub as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(): Promise<unknown> };
  internals.attach = id => new Promise((resolve, reject) => {
    started.push(id.slice(2));
    peak = Math.max(peak, ++running);
    finish.set(id.slice(2), error => { running--; if (error) reject(error); else resolve(connection); });
  });
  internals.liveSnapshot = async () => ({ kind: "live", info: {}, messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });
  const flush = () => new Promise(resolve => setTimeout(resolve, 5));
  const chats = ["c1", "c2", "c3", "c4", "c5", "c6"];
  for (const id of chats) hub.pin(id);
  fire({ daemon: "up" });
  await flush();
  assert.deepEqual(started, ["c1", "c2"], "two pins at a time, in pin order");
  const tab = hub.open("c6");
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6"], "the chat open in a tab does not wait behind the others");
  finish.get("c6")!();
  assert.equal((await tab).live !== null, true);
  finish.get("c1")!();
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6", "c3"]);
  finish.get("c3")!(new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\"."));
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6", "c3", "c4"]);
  fire({ daemon: "up" });
  await flush();
  assert.equal(started.filter(id => id === "c3").length, 1, "a timed-out pin is not tried again at once");
  for (const id of ["c2", "c4"]) finish.get(id)!();
  await flush();
  finish.get("c5")!();
  await flush();
  assert.equal(peak, 3, "two background attaches plus the tab's");
  assert.deepEqual(chats.map(id => hub.state(id)?.kind ?? "none"), ["live", "live", "none", "live", "live", "live"], "every pin attached but the one waiting for its retry");
  await hub.close();
});

test("thread hub: a session the daemon list calls active but the daemon does not hold opens saved, so a wake reads it as not live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "build it", timestamp: 1000 });
  manager.flushNow();
  const summary = { sessionId: manager.getSessionId(), activeSessionId: "fa0261485da9", sessionFile: manager.getSessionFile(), cwd: dir };
  const hub = new ThreadHub("/nonexistent.sock", { summary: async () => summary, hostOf: () => null, daemonPath: (row: { sessionFile?: string }) => row.sessionFile } as unknown as Catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const attached: string[] = [];
  (hub as unknown as { attach(id: string): Promise<never> }).attach = async id => { attached.push(id); throw new Error(`Unknown active session: ${id}`); };
  assert.equal(await hub.view(summary.sessionId), null, "not live: no throw");
  assert.equal((await hub.open(summary.sessionId)).state.messages.length, 1, "the transcript from the session file");
  assert.deepEqual(attached, ["fa0261485da9"], "tried once; the saved thread is kept");
  (hub as unknown as { attach(id: string): Promise<never> }).attach = async () => { throw new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\"."); };
  await assert.rejects(hub.open("other"), /Timed out/, "a daemon timeout is still an error");
  await hub.close();
});
