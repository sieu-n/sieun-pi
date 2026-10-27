// Guards the 10-18 owner ask for a "clean, snappy" chat from the Mac: the live chat's main thread was 73% busy, and on a scratch serve of this box's chats duty, check-in and archive code called rows() 22 to 98 times per 30 s, each call building all 3,700 rows beside the frames' own projections, so one 30 s window ran 2 sidebar frames instead of about 100.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("rows() calls while a projection runs share it, and a call after a change builds a new one", async (t: TestContext) => {
  const live = (n: number, name = `thread ${n}`): SessionSummary => ({ sessionId: `s${n}`, activeSessionId: `a${n}`, cwd: "/tmp", sessionName: name, messageCount: 3 }) as SessionSummary;
  const box = [live(1), live(2)];
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  let projections = 0;
  const chats = { ids: async () => { projections++; return new Set<string>(); }, checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: [...box] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();

  projections = 0;
  const all = await Promise.all(Array.from({ length: 50 }, () => catalog.rows()));
  assert.equal(projections, 1, "50 calls at once build one projection");
  assert.ok(all.every(rows => rows.length === 2));

  box[1] = live(2, "renamed");
  const before = catalog.rows();
  await catalog.refresh();
  const after = await catalog.rows();
  assert.equal(after.find(row => row.id === "s2")?.name, "renamed", "a call after new daemon rows sees them");
  await before;
  assert.equal(projections, 3);
});
