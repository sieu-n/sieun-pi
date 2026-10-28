// Guards 10-18 05:39:42Z: the idle unload's kill archived the owner's plain thread 01a14c31 three minutes after its restore, and only chats
// were unarchived after a kill, so it left his list while it stayed in threads.json. An archive by the owner or an agent still wins.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { type DaemonAnswer, IdleUnloader } from "../src/idle-unload.ts";

const MIN = 60_000;

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "idle-unload-listed-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "hi!", timestamp: 1 });
  manager.appendSessionState({ status: "active" });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const now = Date.now();
  const live: SessionSummary = { id, sessionId: id, sessionFile: file, cwd: dir, lifecycle: "live", activeSessionId: "worker-1", workerState: "ready",
    activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    lastActivityAt: new Date(now - 11 * MIN).toISOString(), sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as SessionSummary;
  const archived: SessionSummary = { ...live, lifecycle: "archived" };
  delete archived.activeSessionId;
  let listed = live;
  const catalog = new Catalog("/isolated-idle-unload.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [id] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "request", async (command: { type: string }) => {
    if (command.type === "list") return { success: true, data: { sessions: [listed] } };
    if (command.type === "kill" || command.type === "detach") return { success: false, error: "Unknown active session: worker-1" };
    throw new Error(`Unexpected daemon command ${command.type}`);
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-idle-unload.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  let release = (): void => {};
  const killing = new Promise<void>(resolve => { release = resolve; });
  let killStarted = (): void => {};
  const killAsked = new Promise<void>(resolve => { killStarted = resolve; });
  // The daemon's kill writes the archived state, as daemon-mode archiveSession does, then the row lists archived with no active session.
  const kill = async (): Promise<DaemonAnswer> => {
    killStarted();
    await killing;
    SessionManager.open(file).appendSessionState({ status: "archived", reason: undefined });
    listed = archived;
    return { success: true };
  };
  const unloader = new IdleUnloader({
    rows: () => [listed], localRows: () => [], idleMs: () => 10 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (_row, type) => type === "get_state" ? { success: true, data: { isSessionActive: false } } : kill(),
    // The chat backend's wiring for a thread in threads.json that the owner did not archive as a chat.
    stopped: async (row, _isChat, since) => { await hub.keepListed(row.sessionId, since); },
    log: () => {}, now: () => Date.now(),
  });
  const shown = async () => (await catalog.rows()).find(row => row.id === id);
  return { id, file, hub, catalog, unloader, release, killAsked, shown,
    state: () => SessionManager.open(file).getSessionState()?.status,
    close: async () => { await hub.close(); await catalog.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("the idle unload's stop of the owner's plain thread frees it and leaves it listed as a saved thread", async t => {
  const f = await fixture(t);
  try {
    await f.unloader.sweep();
    await f.killAsked;
    f.release();
    await f.unloader.settled();
    assert.equal(f.state(), "active", "the kill's archived state is undone");
    const row = await f.shown();
    assert.equal(row?.archived, false, "still on the owner's list");
    assert.equal(row?.status, "saved", "unloaded, not live");
  } finally { await f.close(); }
});

test("an explicit archive that lands while the unload's kill is out wins", async t => {
  const f = await fixture(t);
  try {
    await f.unloader.sweep();
    await f.killAsked;
    await f.hub.archive(f.id, "owner");
    f.release();
    await f.unloader.settled();
    assert.equal(f.state(), "archived");
    assert.equal((await f.shown())?.archived, true, "off the list, as the archive asked");
  } finally { await f.close(); }
});

test("the unload's stop writes the thread's state back without a full open of its transcript", async t => {
  const f = await fixture(t);
  try {
    await f.unloader.sweep();
    await f.killAsked;
    const opens = t.mock.method(SessionManager, "open");
    f.release();
    await f.unloader.settled();
    assert.equal(opens.mock.callCount(), 1, "only the fake daemon's kill opens the file");
    opens.mock.restore();
    assert.equal(f.state(), "active");
  } finally { await f.close(); }
});
