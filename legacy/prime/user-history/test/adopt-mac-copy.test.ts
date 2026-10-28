// Guards the 10-18 restarts on us-metal02 that forgot chat 01a11ba8 at each restart from a 29-minute-old Mac copy: 5 times from 07:23Z to 07:54Z
// service.log printed "chat 01a11ba8: forgotten, the daemon does not list it" right after "copy mac: 3104 rows from mac.sessions.json". The chat
// runs on the Mac and the copy held it, but adopt's lookup waited for the copy and never looked again; a chat the copy lacks waits for the Mac.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { Chats } from "../src/chats.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { IdIndex } from "../src/id-index.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const MAC_CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const macRow = { sessionId: MAC_CHAT, cwd: "/Users/sieunpark", sessionFile: `/Users/sieunpark/.prime/agent/sessions/${MAC_CHAT}.jsonl`, messageCount: 703,
  lifecycle: "live", activeSessionId: "5f62f184170b" } as SessionSummary;

/** The Mac as the catalog reads it: `read` loads its disk copy (as SessionPeer's load does, with an onChange), `sync` is its first list of this run. */
function macHosts(copy: SessionSummary[]) {
  const state = { rows: [] as SessionSummary[], listed: false, synced: false };
  let loadedCopy!: () => void;
  const loading = new Promise<void>(resolve => { loadedCopy = resolve; });
  const hosts = { selfName: "us-metal02", registry: { hosts: [] }, onChange: () => {}, start: () => {}, close: () => {},
    allListed: () => state.listed, allSynced: () => state.synced, loaded: () => loading, isActive: () => false, rows: () => state.rows, hostRows: () => [],
    hostOf: (id: string) => state.rows.some(row => row.sessionId === id) ? { name: "mac" } : null };
  const read = () => { state.rows = copy; state.listed = true; hosts.onChange(); loadedCopy(); };
  const sync = (rows: SessionSummary[]) => { state.rows = rows; state.synced = true; hosts.onChange(); };
  return { hosts: hosts as unknown as HostCatalogs, read, sync };
}

/** A catalog whose own box answers its lists with no sessions, and the chats of `ids` adopted through it. */
async function restart(t: TestContext, hosts: HostCatalogs, ids: string[]) {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chatIds = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chatIds, new ThreadOrigins({ ids: async () => [] }), hosts);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({}));
  t.mock.method(catalog.client, "request", async () => ({ success: true, data: { sessions: [] } }));
  Object.defineProperty(catalog.client, "isConnected", { get: () => connected });
  const dir = await mkdtemp(join(tmpdir(), "adopt-mac-copy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ids) await index.add(id);
  const chats = new Chats(index, fakeThreads([]), id => catalog.summary(id), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir));
  t.after(() => chats.close());
  return { catalog, chats, index };
}

test("a Mac chat that the Mac's disk copy holds is pinned at a restart whose adopt runs while the copy is read", async (t: TestContext) => {
  const { hosts, read } = macHosts([macRow]);
  const { chats, index } = await restart(t, hosts, [MAC_CHAT]);
  const adopted = chats.adopt();
  await new Promise(resolve => setTimeout(resolve, 20));
  read();
  const { pinned, forgotten } = await adopted;
  assert.deepEqual({ pinned, forgotten }, { pinned: [MAC_CHAT], forgotten: [] });
  assert.deepEqual(await index.ids(), [MAC_CHAT]);
});

test("a Mac chat missing from a stale Mac copy stays in the chat list until the Mac answers a list this run", async (t: TestContext) => {
  const { hosts, read, sync } = macHosts([]);
  const { catalog, chats, index } = await restart(t, hosts, [MAC_CHAT]);
  read();
  const { pinned, forgotten } = await chats.adopt();
  assert.deepEqual({ pinned, forgotten }, { pinned: [MAC_CHAT], forgotten: [] }, "the copy alone does not forget it");
  assert.deepEqual(await index.ids(), [MAC_CHAT]);
  sync([macRow]);
  assert.equal((await catalog.summary(MAC_CHAT))?.sessionId, MAC_CHAT, "the Mac's first roster list places it");
  sync([]);
  assert.equal(await catalog.summary(MAC_CHAT), undefined, "once the Mac answered, a chat it does not list reads as missing");
});
