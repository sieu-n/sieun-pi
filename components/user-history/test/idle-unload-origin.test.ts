// Guards p8-stop-provenance (10-18): a Prime that lists kill_origin records a kill with no origin as the owner's stop, and mem.3 ignores the
// field, so the idle unload names its kill only to a daemon whose hello on that connection lists kill_origin, and an archive's kill stays bare.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { type DaemonAnswer, DETACHED_GUARD, DETACHED_REFUSAL, IdleUnloader, KILL_ORIGIN, NO_BARE_KILL, idleKillCommand, unloadRequest } from "../src/idle-unload.ts";

const MIN = 60_000;
const OLD = ["attach_snapshot", "event_sequence", "delete_rlm_subagent", "abort_and_send_queued"];
const NEW = [...OLD, KILL_ORIGIN];

type Sent = { type: string; activeSessionId?: string; origin?: unknown };

const REFUSAL = { error: "Idle unload skipped: the session holds detached processes", errorInfo: { code: DETACHED_REFUSAL, activeSessionId: "w1", holderActiveSessionIds: ["w1"] } };

async function fakeDaemon(path: string, capabilities: readonly string[], options: { holdHello?: boolean; refuse?: boolean } = {}) {
  const sent: Sent[] = [];
  const sockets = new Set<Socket>();
  const hello = `${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, appVersion: "fixture", serverCapabilities: capabilities })}\n`;
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (!options.holdHello) socket.write(hello);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { type: string; id: string; command?: Sent & { id: string } };
        buffer = buffer.slice(end + 1);
        const command = line.type === "command" && line.command ? line.command : line as unknown as Sent & { id: string };
        if (command.type === "ack_result") continue;
        sent.push(command);
        const data = command.type === "get_state" ? { isSessionActive: false } : undefined;
        const refused = command.type === "kill" && command.origin === "idle_unload" && options.refuse;
        socket.write(`${JSON.stringify({ type: "response", id: line.id, command: command.type, ...refused ? { success: false, ...REFUSAL } : { success: true, ...data ? { data } : {} } })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    sent,
    kills: () => sent.filter(command => command.type === "kill"),
    greet: () => { for (const socket of sockets) socket.write(hello); },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function privateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "idle-unload-origin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function connected(path: string): Promise<DaemonClient> {
  const client = new DaemonClient(path);
  await client.connect();
  await client.waitForHello();
  return client;
}

function idleRow(activeSessionId: string): SessionSummary {
  return { id: "01a14e20-0000-7000-8000-000000000001", sessionId: "01a14e20-0000-7000-8000-000000000001", cwd: "/", lifecycle: "live",
    activeSessionId, workerState: "ready", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0,
    messageCount: 1, lastActivityAt: new Date(Date.now() - 11 * MIN).toISOString(), sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as SessionSummary;
}

function unloaderOn(client: DaemonClient, row: SessionSummary, stopped: string[], restorable = true, logs: string[] = []): IdleUnloader {
  return new IdleUnloader({
    rows: () => [row], localRows: () => [], idleMs: () => 10 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: (stop, type) => unloadRequest(client, stop.activeSessionId!, type, restorable),
    stopped: async stop => { stopped.push(stop.sessionId); },
    log: line => { logs.push(line); }, now: () => Date.now(),
  });
}

test("the idle kill names its origin only under a hello that lists kill_origin", () => {
  assert.deepEqual(idleKillCommand("w1", { serverCapabilities: OLD }), { type: "kill", activeSessionId: "w1" });
  assert.deepEqual(idleKillCommand("w1", {}), { type: "kill", activeSessionId: "w1" });
  assert.deepEqual(idleKillCommand("w1", { serverCapabilities: NEW }), { type: "kill", activeSessionId: "w1", origin: "idle_unload" });
});

for (const [name, capabilities, origin] of [["a mem.3 daemon gets a bare kill", OLD, undefined], ["a kill_origin daemon gets origin idle_unload", NEW, "idle_unload"]] as const) {
  test(`idle unload sweep: ${name}, and the stop is still recorded`, async t => {
    const path = join(await privateDir(t), "daemon.sock");
    const daemon = await fakeDaemon(path, capabilities);
    const client = await connected(path);
    try {
      assert.deepEqual(client.hello?.serverCapabilities, capabilities, "the fixture's hello came before any kill");
      const stopped: string[] = [];
      const unloader = unloaderOn(client, idleRow("w1"), stopped);
      await unloader.sweep();
      await unloader.settled();
      assert.deepEqual(daemon.sent.map(command => command.type), ["get_state", "kill"]);
      assert.equal(daemon.kills()[0]!.origin, origin);
      assert.equal("origin" in daemon.kills()[0]!, origin !== undefined);
      assert.equal(stopped.length, 1, "unloaded.json and keepListed still run after the kill");
    } finally { client.close(); await daemon.close(); }
  });
}

test("a reconnect reads the new daemon's hello: old to new adds the origin, new to old drops it", async t => {
  const path = join(await privateDir(t), "daemon.sock");
  const client = new DaemonClient(path);
  const steps: [readonly string[], string | undefined][] = [[OLD, undefined], [NEW, "idle_unload"], [OLD, undefined]];
  try {
    for (const [capabilities, origin] of steps) {
      const daemon = await fakeDaemon(path, capabilities);
      await client.connect();
      assert.equal((await unloadRequest(client, "w1", "kill")).success, true);
      assert.equal(daemon.kills().length, 1);
      assert.equal(daemon.kills()[0]!.origin, origin);
      const closed = new Promise<void>(resolve => { const off = client.onClose(() => { off(); resolve(); }); });
      await daemon.close();
      await closed;
      assert.deepEqual(client.hello?.serverCapabilities, capabilities, "DaemonClient keeps the closed link's hello until the next connect");
      assert.equal((await unloadRequest(client, "w1", "kill")).success, false, "no kill goes out on the closed link under its old hello");
    }
  } finally { client.close(); }
});

test("a kill on a connection whose hello has not come yet waits for it, and none goes out if the link closes first", async t => {
  const dir = await privateDir(t);
  const late = await fakeDaemon(join(dir, "late.sock"), NEW, { holdHello: true });
  const client = new DaemonClient(join(dir, "late.sock"));
  try {
    await client.connect();
    const answer = unloadRequest(client, "w1", "kill");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(late.sent.length, 0, "nothing goes out before the hello");
    late.greet();
    assert.equal((await answer).success, true);
    assert.equal(late.kills()[0]!.origin, "idle_unload");
  } finally { client.close(); await late.close(); }
  const silent = await fakeDaemon(join(dir, "silent.sock"), NEW, { holdHello: true });
  const other = new DaemonClient(join(dir, "silent.sock"));
  try {
    await other.connect();
    const answer = unloadRequest(other, "w1", "kill");
    await new Promise(resolve => setTimeout(resolve, 50));
    await silent.close();
    assert.equal((await answer).success, false);
    assert.equal(silent.sent.length, 0, "no bare kill reaches a daemon whose hello was never read");
  } finally { other.close(); }
});

async function threadFixture(t: TestContext) {
  const dir = await privateDir(t);
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "hi!", timestamp: 1 });
  manager.appendSessionState({ status: "active" });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const live: SessionSummary = { ...idleRow("worker-1"), id, sessionId: id, sessionFile: file, cwd: dir };
  const archived: SessionSummary = { ...live, lifecycle: "archived" };
  delete archived.activeSessionId;
  let listed = live;
  const sent: Sent[] = [];
  const catalog = new Catalog(join(dir, "daemon.sock"), new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [id] }));
  let release = (): void => {};
  const killing = new Promise<void>(resolve => { release = resolve; });
  let killStarted = (): void => {};
  const killAsked = new Promise<void>(resolve => { killStarted = resolve; });
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.getter(DaemonClient.prototype, "hello", () => ({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: NEW }));
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "request", async (command: Sent): Promise<DaemonAnswer> => {
    if (command.type === "list") return { success: true, data: { sessions: [listed] } };
    if (command.type === "get_state") return { success: true, data: { isSessionActive: false } };
    if (command.type === "detach") return { success: false, error: "Unknown active session: worker-1" };
    if (command.type !== "kill") throw new Error(`Unexpected daemon command ${command.type}`);
    sent.push(command);
    if (command.origin === undefined) return { success: false, error: "Unknown active session: worker-1" };
    killStarted();
    await killing;
    SessionManager.open(file).appendSessionState({ status: "archived" });
    listed = archived;
    return { success: true };
  });
  await catalog.refresh();
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const unloader = new IdleUnloader({
    rows: () => [listed], localRows: () => [], idleMs: () => 10 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: (row, type) => unloadRequest(catalog.clientFor(row.activeSessionId!), row.activeSessionId!, type),
    stopped: async (row, _isChat, since) => { await hub.keepListed(row.sessionId, since); },
    log: () => {}, now: () => Date.now(),
  });
  return { id, hub, unloader, sent, release, killAsked,
    state: () => SessionManager.open(file).getSessionState()?.status,
    shown: async () => (await catalog.rows()).find(row => row.id === id),
    close: async () => { await hub.close(); await catalog.close(); } };
}

test("on a kill_origin daemon the idle stop keeps the owner's thread listed, and an archive during it wins with a bare kill", async t => {
  const f = await threadFixture(t);
  try {
    await f.unloader.sweep();
    await f.killAsked;
    await f.hub.archive(f.id);
    f.release();
    await f.unloader.settled();
    assert.deepEqual(f.sent.map(command => command.origin), ["idle_unload", undefined], "the idle kill names itself and the archive's kill stays the owner's");
    assert.equal(f.state(), "archived");
    assert.equal((await f.shown())?.archived, true);
  } finally { await f.close(); }
});

test("on a kill_origin daemon an idle stop with no archive leaves the thread listed as saved", async t => {
  const f = await threadFixture(t);
  try {
    await f.unloader.sweep();
    await f.killAsked;
    f.release();
    await f.unloader.settled();
    assert.deepEqual(f.sent.map(command => command.origin), ["idle_unload"]);
    assert.equal(f.state(), "active");
    const row = await f.shown();
    assert.equal(row?.archived, false);
    assert.equal(row?.status, "saved");
  } finally { await f.close(); }
});

// 10-18 12:53:05Z: the sweep's bare kill archived the Mac's runner reviewer (01a11d25), whose file this box cannot rewrite as active.
test("another box's session under a daemon without kill_origin is never killed, and is not asked again until its row changes", async t => {
  const path = join(await privateDir(t), "daemon.sock");
  const daemon = await fakeDaemon(path, OLD);
  const client = await connected(path);
  try {
    const stopped: string[] = [], logs: string[] = [];
    const unloader = unloaderOn(client, idleRow("w1"), stopped, false, logs);
    for (let sweep = 0; sweep < 2; sweep++) { await unloader.sweep(); await unloader.settled(); }
    assert.deepEqual(daemon.sent.map(command => command.type), ["get_state"], "one look, no kill, and the second sweep skips the row");
    assert.deepEqual(stopped, []);
    assert.equal(logs.filter(line => line.includes(NO_BARE_KILL)).length, 1);
  } finally { client.close(); await daemon.close(); }
});

test("a kill_origin daemon still gets the idle kill for another box's session", async t => {
  const path = join(await privateDir(t), "daemon.sock");
  const daemon = await fakeDaemon(path, NEW);
  const client = await connected(path);
  try {
    const stopped: string[] = [];
    const unloader = unloaderOn(client, idleRow("w1"), stopped, false);
    await unloader.sweep();
    await unloader.settled();
    assert.deepEqual(daemon.sent.map(command => command.type), ["get_state", "kill"]);
    assert.equal(daemon.kills()[0]!.origin, "idle_unload");
    assert.equal(stopped.length, 1);
  } finally { client.close(); await daemon.close(); }
});

// p8-metal/detached-guard-contract.md (10-18): a daemon that lists idle_unload_detached_guard refuses the idle kill of a session holding detached
// processes with errorInfo.code idle_unload_detached_processes and changes nothing. The sweep skips the session that time only.
test("a guard daemon's refusal skips the session for that sweep only, and the next sweep stops it once the daemon lets it go", async t => {
  const path = join(await privateDir(t), "daemon.sock");
  const options = { refuse: true };
  const daemon = await fakeDaemon(path, [...NEW, DETACHED_GUARD], options);
  const client = await connected(path);
  try {
    const stopped: string[] = [];
    const logs: string[] = [];
    const unloader = unloaderOn(client, idleRow("w1"), stopped, true, logs);
    await unloader.sweep();
    await unloader.settled();
    assert.deepEqual(daemon.sent.map(command => command.type), ["get_state", "kill"]);
    assert.deepEqual(stopped, []);
    assert.deepEqual(logs, ["idle unload: 01a14e20: kept, it holds detached processes"], "no error line and no skip until the row changes");
    options.refuse = false;
    await unloader.sweep();
    await unloader.settled();
    assert.deepEqual(daemon.sent.map(command => command.type), ["get_state", "kill", "get_state", "kill"], "the same row was asked again");
    assert.equal(stopped.length, 1);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("without idle_unload_detached_guard in the hello the same answer is logged as a failed kill, as before", async t => {
  const path = join(await privateDir(t), "daemon.sock");
  const daemon = await fakeDaemon(path, NEW, { refuse: true });
  const client = await connected(path);
  try {
    const answer = await unloadRequest(client, "w1", "kill");
    assert.deepEqual(answer.success ? null : { error: answer.error, detachedHold: answer.detachedHold }, { error: REFUSAL.error, detachedHold: undefined });
    const logs: string[] = [];
    const unloader = unloaderOn(client, idleRow("w1"), [], true, logs);
    await unloader.sweep();
    await unloader.settled();
    assert.deepEqual(logs, [`idle unload: 01a14e20: ${REFUSAL.error}`]);
  } finally {
    client.close();
    await daemon.close();
  }
});
