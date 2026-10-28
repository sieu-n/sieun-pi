// Guards p1254 (10-28): Prime's idle_unload kill writes the archived state, and this box cannot rewrite another box's file, so a Mac thread the
// idle unload stopped dropped out of the list once the hold in memory was gone, as the Mac chat frontend bro did from 17:20Z to 18:02Z.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog, unloadedOnly } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { forgetUnloaded, recordUnloaded, UNLOADED_FILE, unloadedReader } from "../src/unloaded.ts";

const STOP = Date.parse("2026-10-28T17:11:20.048Z");

async function catalogOf(t: TestContext, dataDir: string, rows: SessionSummary[]) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), archivedIds: async () => new Set<string>(), unloaded: unloadedReader(dataDir),
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

test("a top-level thread the idle unload stopped stays listed while its daemon lists it archived, until an archive through the hub drops it", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "unloaded-listed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = (sessionId: string, lastActivityAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => {
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "{}\n");
    return { id: sessionId, sessionId, sessionName: sessionId, sessionFile, cwd: dir, lifecycle: "archived", messageCount: 5, lastActivityAt, ...extra } as unknown as SessionSummary;
  };
  const rows = [
    saved("unloaded", "2026-10-28T16:52:56.668Z"),
    saved("active-after", "2026-10-28T17:30:00.000Z"),
    saved("job", "2026-10-28T16:52:56.668Z", { runtimeKind: "subagent", rlmDepth: 1, rlmChildId: "c1" } as Partial<SessionSummary>),
    saved("never-unloaded", "2026-10-28T16:52:56.668Z"),
  ];
  await recordUnloaded(dir, ["unloaded", "active-after", "job"], STOP);
  const catalog = await catalogOf(t, dir, rows);
  const archived = async () => Object.fromEntries((await catalog.rows()).map(row => [row.id, row.archived]));
  const before = await archived();
  assert.deepEqual([before.unloaded, before["active-after"], before["never-unloaded"]], [false, true, true],
    "only the top-level thread whose last activity is before its unload stop stays listed");
  assert.equal(unloadedOnly(rows[2]!, STOP), false, "a job's archive may be its parent's delete, so a job is left as its daemon lists it");
  await forgetUnloaded(dir, ["unloaded"]);
  catalog.holdLifecycle("unloaded", "archived");
  assert.equal((await archived()).unloaded, true, "an archive through the hub hides it again");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, UNLOADED_FILE), "utf8")), { "active-after": new Date(STOP).toISOString(), job: new Date(STOP).toISOString() });
});
