// Guards a projection's own code: it looked each of the 4,500 rows up in the parsed read state's sessions object, and on a bench over a copy of
// the live rows on 10-19 that was 1.9 of 29 ms of a projection's own code; the read markers now go into a Map once per projection.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ROWS = 2000;

test("a projection reads the read state once, not once per row", async (t: TestContext) => {
  const box = Array.from({ length: ROWS }, (_, at) => ({ sessionId: `s${at}`, activeSessionId: `a${at}`, cwd: "/tmp", sessionName: `row ${at}`, messageCount: 3 } as SessionSummary));
  let lookups = 0;
  const sessions = new Proxy<Record<string, { timestamp: number }>>({ s1: { timestamp: 5 }, s2: { timestamp: 7 } }, {
    get: (target, key, receiver) => { lookups++; return Reflect.get(target, key, receiver); },
  });
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  const rows = await catalog.rows();
  assert.equal(rows.length, ROWS);
  lookups = 0;
  await catalog.event();
  assert.ok(lookups < 50, `one projection looked the read state up ${lookups} times for ${ROWS} rows`);
});
