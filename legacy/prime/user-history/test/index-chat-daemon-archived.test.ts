// Guards p1248 (10-28): the Mac chat frontend bro left the sidebar from 17:20Z to 18:02Z. The 17:11Z idle unload wrote the archived state into
// its Mac file, which this box cannot rewrite, and the 17:14Z release dropped the in-memory hold that kept it listed.
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

async function catalogOf(t: TestContext, rows: SessionSummary[], chatIds: string[], ownerArchived: string[] = []) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set(chatIds), checkIns: async () => new Map(), archivedIds: async () => new Set(ownerArchived),
    links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const hosts = { selfName: "us-metal02", onChange: () => {}, start: () => {}, close: () => {}, allListed: () => true, allSynced: () => true, loaded: async () => {},
    hostOf: () => null, isActive: () => false, rows: () => [], hostRows: () => [], client: () => null, ready: async () => null };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), hosts as unknown as HostCatalogs);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) =>
    command.type === "list" ? { success: true, data: { sessions: rows } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  return catalog;
}

test("a chat in the index that its daemon lists archived after an idle unload stays in the sidebar; a plain thread and an owner archive do not", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "index-chat-archived-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = (sessionId: string, sessionName: string): SessionSummary => {
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "{}\n");
    return { id: sessionId, sessionId, sessionName, sessionFile, cwd: dir, lifecycle: "archived", messageCount: 5, modified: "2026-10-28T16:52:56.668Z" } as unknown as SessionSummary;
  };
  const rows = [saved("frontend", "frontend bro"), saved("thread", "plain thread"), saved("leaving", "chat the owner archives")];
  const catalog = await catalogOf(t, rows, ["frontend", "leaving"]);
  catalog.holdLifecycle("leaving", "archived");
  const byId = new Map((await catalog.rows()).map(row => [row.id, row]));
  assert.equal(byId.get("frontend")?.archived, false, "the daemon's archived state of an index chat does not hide it");
  assert.equal(byId.get("frontend")?.chat, true);
  assert.equal(byId.get("thread")?.archived, true, "a plain thread the daemon archived stays archived");
  assert.equal(byId.get("leaving")?.archived, true, "an archive the owner started still hides the chat");
});

test("a chat the owner archived stays hidden even while still in the index", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "index-chat-archived-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "gone.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const row = { id: "gone", sessionId: "gone", sessionName: "gone", sessionFile, cwd: dir, lifecycle: "archived", messageCount: 5 } as unknown as SessionSummary;
  const catalog = await catalogOf(t, [row], ["gone"], ["gone"]);
  assert.equal((await catalog.rows()).find(item => item.id === "gone")?.archived, true);
});
