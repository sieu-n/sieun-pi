// Guards the 10-18 projection cost at the live rate: on a scratch serve (this box's 588 rows and the Mac's 3,053, 13.3 roster updates a second) the rows map took 15 ms of a 47 ms projection, asking each row's box twice and parsing every row's time for the sort again.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("a projection asks each row's box once and parses only new rows' times", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "row-map-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = (n: number): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionFile: join(dir, `s${n}.jsonl`), sessionName: `thread ${n}`, messageCount: 3,
    lastActivityAt: new Date(Date.parse("2026-10-18T08:00:00Z") - n * 1000).toISOString() }) as SessionSummary;
  for (let n = 0; n < 200; n++) await writeFile(join(dir, `s${n}.jsonl`), "");
  const box = Array.from({ length: 100 }, (_, n) => row(n));
  const mac = Array.from({ length: 100 }, (_, n) => row(100 + n));
  let asked = 0;
  const hosts = { selfName: "box", onChange: () => {}, start: () => {}, close: () => {}, loaded: async () => {}, rows: () => mac, isActive: () => false,
    hostOf: (id: string) => { asked++; return mac.some(entry => entry.sessionId === id) ? { name: "mac" } : null; } } as unknown as HostCatalogs;
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), hosts);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  const first = (await catalog.event()).sessions;
  assert.equal(first.length, 200);
  assert.equal(first.find(entry => entry.id === "s150")?.host, "mac");

  asked = 0;
  const parse = t.mock.method(Date, "parse");
  const second = (await catalog.event()).sessions;
  assert.deepEqual(second.map(entry => entry.id), first.map(entry => entry.id), "the same order");
  assert.ok(asked <= 200, `${asked} box lookups for 200 rows`);
  const sortParses = parse.mock.calls.filter(call => second.some(entry => entry.lastActivityAt === call.arguments[0])).length;
  assert.equal(sortParses, 0, "a kept row's time is not parsed again");
});
