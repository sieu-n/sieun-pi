// Guards the 10-18 restarts' slow first minutes: at 21:14:29Z the live chat service's first wake tick woke 71 sessions at once, and a catalog projection built every working row again on each pass, kept or not.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("a working row whose daemon row and running subagents did not change is kept, and a subagent's change builds it again", async (t: TestContext) => {
  const working = (n: number): SessionSummary => ({ sessionId: `w${n}`, activeSessionId: `a${n}`, cwd: "/tmp", sessionName: `job ${n}`, messageCount: 3, rosterStatus: "running",
    lastActivityAt: "2026-10-18T21:14:29.000Z" }) as SessionSummary;
  const child = (at: string): SessionSummary => ({ sessionId: "c1", activeSessionId: "ac1", parentSessionId: "w0", rlmChildId: "sub-1", runtimeKind: "subagent", rosterStatus: "running",
    cwd: "/tmp", sessionName: "child", messageCount: 1, lastActivityAt: at }) as SessionSummary;
  const box = [...Array.from({ length: 70 }, (_, n) => working(n)), child("2026-10-18T21:14:30.000Z")];
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
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: [...box] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  const byId = async () => new Map((await catalog.event()).sessions.map(row => [row.id, row]));
  const first = await byId();
  assert.equal(first.get("w1")?.working, true);
  const second = await byId();
  assert.equal([...second].filter(([id, row]) => first.get(id) === row).length, 70, "no working row is built again");

  box[70] = child("2026-10-18T21:15:00.000Z");
  await catalog.refresh();
  const third = await byId();
  assert.notEqual(third.get("w0"), second.get("w0"), "a running subagent's change builds its parent again");
  assert.equal(third.get("w0")?.pulse?.activityAt, "2026-10-18T21:15:00.000Z");
});
