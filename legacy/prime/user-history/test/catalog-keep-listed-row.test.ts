// Guards the catalog's forget, which until 11-20 dropped a session's row from the index until the next index placed it again. A thread whose
// link closed and a thread the idle unload kept listed each forgot their row and then asked for a list, so a frame that no copy change started
// (the rates timer's, a notify) or a lookup while that list was out lacked the thread. The incremental index test failed three releases on it.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const row = (n: number): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionName: `thread ${n}`, messageCount: 3, activeSessionId: `a-s${n}`,
  lastActivityAt: new Date(Date.parse("2026-11-20T00:00:00Z") - n * 1000).toISOString() } as SessionSummary);

test("a thread the idle unload keeps listed stays in the frames and lookups while the catalog's list is out", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  const hub = new ThreadHub("unused", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); catalog.close(); });
  // Every list after the first waits until the test lets it answer, as a list to a busy daemon does.
  let lists = 0;
  let answer = (): void => {};
  const held = new Promise<void>(resolve => { answer = resolve; });
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    if (lists++ > 0) await held;
    return { success: true, data: { sessions: [row(0), row(1), row(2)] } };
  });
  Object.defineProperty(catalog.client as unknown as Record<string, unknown>, "isConnected", { get: () => connected });
  await catalog.refresh();
  assert.equal(await hub.keepListed("s1", 0), true);
  const ids = (await catalog.event()).sessions.map(session => session.id);
  assert.deepEqual(ids, ["s0", "s1", "s2"], "the frame while the list is out");
  assert.equal(catalog.title("s1"), "thread 1", "a lookup while the list is out");
  answer();
});
