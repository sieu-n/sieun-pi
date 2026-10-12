import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { messageText } from "../src/shared/turns.ts";

type NativeListener = (event: unknown) => void;

/**
 * A pinned chat coming back after a daemon restart and the chat's own turn restart (or an owner send) both resume the same saved thread. Before
 * the fix each resume attached and subscribed, so every later event reached the thread twice and the feed drew each message twice.
 */
test("two resumes of one saved thread at once attach it once, so each message shows once", async () => {
  const summary = { sessionId: "chat-1", cwd: process.cwd(), sessionFile: "/nonexistent/chat-1.jsonl" } as SessionSummary;
  const creates: string[] = [];
  const catalog = {
    summary: async () => ({ ...summary }),
    refresh: async () => {},
    connect: async () => {},
    client: { request: async () => { creates.push("create"); summary.activeSessionId = "active-1"; return { success: true, data: {} }; } },
  } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const listeners: NativeListener[] = [];
  const attaches: string[] = [];
  const connection = {
    subscribe: (listener: NativeListener) => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
    getQueue: async () => ({ steering: [], followUp: [] }),
    dispose: async () => {},
  };
  const internals = hub as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(): Promise<unknown>; savedMessages(): unknown };
  internals.savedMessages = () => ({ messages: [], info: { sessionId: "chat-1", cwd: summary.cwd, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
    isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 0, context: null, usage: null, sessionAction: null, queuedActions: 0 } });
  internals.attach = async id => { attaches.push(id); await new Promise(resolve => setTimeout(resolve, 5)); return connection; };
  internals.liveSnapshot = async () => ({ kind: "live", info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 },
    messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });

  const [pin, send] = await Promise.all([hub.resume("chat-1", true), hub.resume("chat-1")]);
  assert.equal(pin, send, "both callers get the same thread");
  assert.deepEqual(creates, ["create"], "the saved session is resumed once");
  assert.deepEqual(attaches, ["active-1"], "and attached once");
  assert.equal(listeners.length, 1, "one daemon subscription feeds the thread");

  for (const listener of [...listeners]) listener({ type: "session_event", event: { type: "message_end", message: { role: "user", content: "also Chats in show details view", timestamp: 5 } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const texts = hub.state("chat-1")!.messages.map(message => message.role === "user" ? messageText(message) : message.role);
  assert.deepEqual(texts, ["also Chats in show details view"], "the owner's message is in the thread once");
  await hub.close();
});

/**
 * A worker that died (here 17:51 KST on 10-12, under swap) leaves its sessions listed with the dead worker's active id and workerState "failed".
 * Attaching that id fails with "Session worker is failed", so the pinned chat retried every 5 min and never came back. Opening the saved file
 * is what makes the daemon reclaim the dead worker.
 */
test("a thread whose worker failed is reopened from its saved file, not attached to the dead worker", async () => {
  const summary = { sessionId: "chat-2", cwd: process.cwd(), sessionFile: "/nonexistent/chat-2.jsonl", activeSessionId: "dead-1", workerState: "failed" } as SessionSummary;
  const creates: unknown[] = [];
  const catalog = {
    summary: async () => ({ ...summary }),
    refresh: async () => {},
    connect: async () => {},
    client: { request: async (command: unknown) => { creates.push(command); Object.assign(summary, { activeSessionId: "fresh-1", workerState: "ready" }); return { success: true, data: {} }; } },
  } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const attaches: string[] = [];
  const connection = { subscribe: () => () => {}, getQueue: async () => ({ steering: [], followUp: [] }), dispose: async () => {} };
  const internals = hub as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(): Promise<unknown>; savedMessages(): unknown };
  internals.savedMessages = () => ({ messages: [], info: { sessionId: "chat-2", cwd: summary.cwd, model: null, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false,
    isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 0, context: null, usage: null, sessionAction: null, queuedActions: 0 } });
  internals.attach = async id => { if (id === "dead-1") throw new Error("Session worker is failed"); attaches.push(id); return connection; };
  internals.liveSnapshot = async () => ({ kind: "live", info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 },
    messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });

  await hub.resume("chat-2", true);
  assert.deepEqual(creates, [{ type: "create", lifecycle: "resident", sessionPath: "/nonexistent/chat-2.jsonl", config: { cwd: summary.cwd } }], "the saved file is opened once");
  assert.deepEqual(attaches, ["fresh-1"], "and the new worker's session is attached");
  await hub.close();
});
