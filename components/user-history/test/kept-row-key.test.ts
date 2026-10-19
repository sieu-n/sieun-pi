// Guards a projection's own code on kept rows: for each of the 4,500 rows on every projection it built a new key array to compare with the kept
// one, a new subtree for a row with no subagent, and an entry object for the sort, about 870 bytes per kept row on 10-19.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getHeapStatistics } from "node:v8";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ROWS = 4000;

test("a projection that keeps every row allocates no key per row", async (t: TestContext) => {
  const box = Array.from({ length: ROWS }, (_, at) => ({ sessionId: `s${at}`, activeSessionId: `a${at}`, cwd: "/tmp", sessionName: `row ${at}`, messageCount: 3,
    lastActivityAt: new Date(Date.UTC(2026, 9, 19, 0, 0, at)).toISOString() } as SessionSummary));
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
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  assert.equal((await catalog.rows()).length, ROWS);
  for (let warm = 0; warm < 40; warm++) await catalog.event();
  const perRow: number[] = [];
  for (let run = 0; run < 5; run++) {
    const before = getHeapStatistics().total_allocated_bytes;
    await catalog.event();
    perRow.push((getHeapStatistics().total_allocated_bytes - before) / ROWS);
  }
  const least = Math.min(...perRow);
  console.log(`bytes per kept row: ${perRow.map(bytes => bytes.toFixed(0)).join(", ")}`);
  assert.ok(least < 300, `a projection allocated ${least.toFixed(0)} bytes per kept row`);
});
