// Guards the 10-18 sidebar emit window: a scratch serve at the live rate (13.3 roster updates a second) spent about 200 ms per catalog projection, 4.9 frames a second and 29.1% main-thread busy with no window, and owner rule c106 keeps a profiler off the live service, so the service logs each minute's projection times.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog, PROJECTION_LOG_MS, projectionLine } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("projectionLine gives the count, median, 90th percentile and longest wall time", () => {
  assert.equal(projectionLine([]), null);
  assert.equal(projectionLine([30, 10, 20, 40, 50, 60, 70, 80, 90, 210.4]), "catalog: 10 projections in 60 s, median 50 ms, p90 90 ms, max 210 ms");
});

test("the catalog logs one line a minute on the projections it ran", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
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
  const box = [{ sessionId: "s1", activeSessionId: "a1", cwd: "/tmp", sessionName: "one", messageCount: 3 } as SessionSummary];
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  await catalog.event();
  await catalog.event();
  await new Promise(resolve => setImmediate(resolve));
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { lines.push(String(chunk)); return true; });
  t.mock.timers.tick(PROJECTION_LOG_MS);
  const logged = lines.filter(line => line.includes("projections in"));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /catalog: [23] projections in 60 s, median \d+ ms, p90 \d+ ms, max \d+ ms\n$/);
  t.mock.timers.tick(PROJECTION_LOG_MS);
  assert.equal(lines.filter(line => line.includes("projections in")).length, 1, "a minute with no projection logs nothing");
});
