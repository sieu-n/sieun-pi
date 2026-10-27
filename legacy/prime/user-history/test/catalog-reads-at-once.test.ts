// Guards the 10-19 steady wall time: a projection read each chat's links, then the turn queue, then the wakes, one after another, and on the live
// service each read waited behind the rest of the main thread's work (wall p90 100 to 133 ms against own code p90 58 to 66 ms).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("a projection asks every chat's links, the turn queue and the wakes at once", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = ["c1", "c2", "c3"];
  // Each read answers only once all five were asked, so a projection that waits for one before asking the next never ends.
  const asked = new Set<string>();
  let all = (): void => {};
  const everyone = new Promise<void>(resolve => { all = resolve; });
  const ask = async <T>(what: string, answer: T): Promise<T> => { asked.add(what); if (asked.size === ids.length + 2) all(); await everyone; return answer; };
  const chats = { ids: async () => new Set(ids), checkIns: async () => new Map(),
    links: (id: string) => ask(`links ${id}`, { children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  catalog.queueSource = () => ask("queue", new Map());
  catalog.wakesSource = () => ask("wakes", []);
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = ids.map((id, at) => ({ sessionId: id, activeSessionId: `a${at}`, cwd: "/tmp", sessionName: id, messageCount: 3 } as SessionSummary));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  const rows = await Promise.race([catalog.rows(), new Promise<null>(resolve => setTimeout(resolve, 2000, null))]);
  assert.notEqual(rows, null, `the projection waited on one read before asking the next (asked: ${[...asked].join(", ")})`);
  assert.deepEqual(rows!.filter(row => row.chat).map(row => row.id).sort(), ids);
});
