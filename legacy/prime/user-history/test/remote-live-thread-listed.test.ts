// Guards p1263 (10-29): Prime load.3.9.14 lists a thread its idle unload stopped as live, with no worker, on Linux and on the Mac. So another
// box's thread the daemon lists live stays in the sidebar with nothing in this service holding it, and an archived one reads as its daemon lists it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("another box's thread its daemon lists live after an idle unload stays in the sidebar, and an archived one stays archived", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-live-listed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = (sessionId: string, lifecycle: string): SessionSummary => {
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "{}\n");
    return { id: sessionId, sessionId, sessionName: sessionId, sessionFile, cwd: dir, lifecycle, messageCount: 5, lastActivityAt: "2026-10-28T23:36:27.237Z" } as unknown as SessionSummary;
  };
  const macRows = [saved("unloaded", "live"), saved("archived", "archived")];
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), archivedIds: async () => new Set<string>(),
    links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const hosts = { selfName: "us-metal02", onChange: () => {}, start: () => {}, close: () => {}, allListed: () => true, allSynced: () => true, loaded: async () => {},
    hostOf: (id: string) => macRows.some(row => row.sessionId === id) ? { name: "mac" } : null, isActive: () => false, rows: () => macRows, hostRows: () => [],
    client: () => null, ready: async () => null };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), hosts as unknown as HostCatalogs);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) =>
    command.type === "list" ? { success: true, data: { sessions: [] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  const rows = Object.fromEntries((await catalog.rows()).map(row => [row.id, { archived: row.archived, host: row.host }]));
  assert.deepEqual(rows.unloaded, { archived: false, host: "mac" }, "the Mac thread its daemon lists live is in the sidebar");
  assert.deepEqual(rows.archived, { archived: true, host: "mac" }, "the Mac thread its daemon lists archived reads archived");
});
