// Guards p75 (10-18): Prime close-keeps-jobs (3e0130b) keeps a root's heartbeats and cron jobs through an idle unload, so the owner's archive of
// an unloaded chat must send archive_saved_session to that chat's own box, gated on that connection's hello, or the kept jobs wake the chat.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const home = mkdtempSync(join(tmpdir(), "saved-session-archive-"));
for (const key of Object.keys(process.env)) if (/^(PRIME|PI|RLM)_/.test(key)) delete process.env[key];
Object.assign(process.env, {
  HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "run"), PRIME_AGENT_CODING_AGENT_DIR: join(home, ".prime/agent"),
  PI_POOL_DIR: join(home, "pi-pool"), AGENT_CHAT_DATA_DIR: join(home, "chat"), SIEUN_PI_HOSTS: join(home, "no-hosts.json"),
});
const { DaemonClient, SessionManager } = await import("prime-agent");
type SessionSummary = import("prime-agent").SessionSummary;
const { Catalog } = await import("../src/chat-catalog.ts");
const { ChatReadState } = await import("../src/chat-read-state.ts");
const { ChatLabels } = await import("../src/chat-labels.ts");
const { ThreadOrigins } = await import("../src/thread-origin.ts");
const { ThreadHub } = await import("../src/chat-threads.ts");
const { Chats } = await import("../src/chats.ts");
const { IdIndex } = await import("../src/id-index.ts");
const { loadRecord } = await import("../src/chat-brief.ts");
const { ScheduledJobsLeft, ServicesStopPending, SAVED_SESSION_ARCHIVE, archiveSavedSession, resumeSince } = await import("../src/saved-archive.ts");
const { source } = await import("./chats-helpers.ts");
test.after(() => rm(home, { recursive: true, force: true }));

const OLD = ["attach_snapshot", "event_sequence", "delete_rlm_subagent", "abort_and_send_queued", "kill_origin"];
const NEW = [...OLD, SAVED_SESSION_ARCHIVE];
const RESIDENT = "Cannot archive a resident session; stop it with kill";

type Answer = { success: true } | { success: false; error: string; errorInfo?: unknown };
type Archived = { sessionPath: string; clientId: unknown; protocol: unknown; acked: boolean };

/** A supervisor socket with its own hello, which answers archive_saved_session with `answer` and records each one and its ack. */
async function fakeDaemon(path: string, capabilities: readonly string[], answer: (sessionPath: string) => Answer | Promise<Answer> = () => ({ success: true })) {
  const archives: Archived[] = [];
  const other: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, clientId: "c", serverCapabilities: capabilities })}\n`);
    let buffer = "";
    const byId = new Map<string, Archived>();
    socket.on("data", async chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { type: string; id: string; clientId?: unknown; protocol?: unknown; command: { type: string; sessionPath?: string; commandId?: string } };
        buffer = buffer.slice(end + 1);
        assert.equal(line.type, "command", "every command goes in a protocol 7 envelope");
        const command = line.command;
        if (command.type === "ack_result") { const entry = byId.get(command.commandId!); if (entry) entry.acked = true; continue; }
        if (command.type !== "archive_saved_session") { other.push(command.type); continue; }
        const entry = { sessionPath: command.sessionPath!, clientId: line.clientId, protocol: line.protocol, acked: false };
        archives.push(entry);
        byId.set(line.id, entry);
        const result = await answer(command.sessionPath!);
        socket.write(`${JSON.stringify({ type: "response", id: line.id, command: command.type, ...result })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { archives, other, connections: () => connections,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

type Sent = { type: string; activeSessionId?: string; origin?: unknown; host: string };

/** The row with no worker holding it. */
function unloaded(row: SessionSummary): SessionSummary {
  const { activeSessionId: _gone, ...rest } = row;
  return rest;
}

/**
 * One chat whose catalog row is `listed`, on this box or on "mac". The catalog's own daemon link is a stub whose hello lists `known`, as the
 * existing hub tests stub it; archive_saved_session goes out on its own connection to the fake supervisor of the chat's box.
 */
async function fixture(t: TestContext, options: { known: readonly string[]; box?: readonly string[]; mac?: readonly string[]; host?: "mac";
  answer?: (sessionPath: string) => Answer | Promise<Answer>; kill?: (activeSessionId: string) => Answer; noQueue?: boolean }) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const dir = mkdtempSync(join(home, "case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  manager.appendCustomEntry("chat_mode", { v: 1 });
  manager.appendMessage({ role: "user", content: "hi!", timestamp: 1 });
  manager.appendSessionState({ status: "active" });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const macFile = `/Users/sieunpark/.prime/agent/sessions/${id}.jsonl`;
  const saved: SessionSummary = { id, sessionId: id, sessionFile: file, cwd: dir, lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false,
    isCompacting: false, attachedClients: 0, messageCount: 1, sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as SessionSummary;
  const bystander: SessionSummary = { ...saved, id: "01a14f00-0000-7000-8000-00000000000b", sessionId: "01a14f00-0000-7000-8000-00000000000b",
    sessionFile: join(dir, "other.jsonl"), activeSessionId: "w-other", workerState: "ready" };
  let listed: SessionSummary[] = [saved, bystander];
  const boxSock = join(dir, "box.sock"), macSock = join(dir, "mac.sock");
  const box = options.box ? await fakeDaemon(boxSock, options.box, options.answer) : undefined;
  let mac = options.mac ? await fakeDaemon(macSock, options.mac, options.answer) : undefined;
  t.after(async () => { await box?.close(); await mac?.close(); });
  const up = { box: true, mac: options.mac !== undefined };
  const sent: Sent[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index"), archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  await index.add(id);
  let chats!: InstanceType<typeof Chats>;
  const catalog = new Catalog(boxSock, new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: () => chats.ids(), checkIns: async () => new Map(), archivedIds: () => chats.archivedIds(),
      links: async () => ({ children: [], board: null, roots: [], messages: [] }) }, new ThreadOrigins({ ids: async () => [] }));
  const macClient = new DaemonClient(macSock);
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(catalog, "reachable", (name: string | null) => name === "mac" ? up.mac : up.box);
  if (options.host === "mac") {
    const onMac = (key: string) => key === id || listed.some(row => row.sessionId === id && row.activeSessionId === key);
    t.mock.method(catalog, "hostOf", (key: string) => onMac(key) ? "mac" : null);
    t.mock.method(catalog, "daemonPath", (row: Pick<SessionSummary, "sessionId" | "sessionFile">) => row.sessionId === id ? macFile : row.sessionFile);
    t.mock.method(catalog, "socketPathFor", (name?: string | null) => name === "mac" ? macSock : boxSock);
    t.mock.method(catalog, "hostClient", async (name?: string | null) => name === "mac" ? macClient : catalog.client);
    t.mock.method(catalog, "remoteRows", () => listed.filter(row => row.sessionId === id));
    t.mock.method(catalog, "localFile", async () => { if (!up.mac) throw new Error("mac did not answer; this box has no copy"); return file; });
  }
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.getter(DaemonClient.prototype, "hello", () => ({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: options.known }));
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "request", async function (this: unknown, command: Omit<Sent, "host">): Promise<Answer | { success: true; data: unknown }> {
    if (command.type === "list") return { success: true, data: { sessions: listed } };
    if (command.type === "detach") return { success: false, error: `Unknown active session: ${command.activeSessionId}` };
    sent.push({ ...command, host: this === macClient ? "mac" : "box" });
    if (command.type !== "kill") throw new Error(`Unexpected daemon command ${command.type}`);
    const result = options.kill?.(command.activeSessionId!) ?? { success: true };
    if (result.success) listed = listed.map(row => row.activeSessionId === command.activeSessionId ? { ...unloaded(row), lifecycle: "archived" } : row);
    return result;
  });
  await catalog.refresh();
  t.mock.timers.setTime(Date.now() + 1_000);
  const hub = new ThreadHub(boxSock, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), undefined, {}, undefined, false,
    options.noQueue ? null : join(dir, "saved-archive-queue.json"));
  chats = new Chats(index, hub, sessionId => catalog.summary(sessionId), "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir), archived });
  t.after(async () => { chats.close(); await hub.close(); await catalog.close(); });
  return { id, file, macFile, box, get mac() { return mac; }, sent, chats, catalog, hub, up,
    startMac: async (capabilities: readonly string[]) => { mac = await fakeDaemon(macSock, capabilities, options.answer); up.mac = true; },
    pending: async () => await hub.cancels?.pending() ?? [],
    restartedHub: () => new ThreadHub(boxSock, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), undefined, {}, undefined, false,
      join(dir, "saved-archive-queue.json")),
    later: (ms: number) => { t.mock.timers.setTime(Date.now() + ms); },
    /** A turn after the archive, as the session's file records it: what started it, then the reply. */
    turn: (start: "agent_message" | "service_message" | "heartbeat_prompt" | "user") => {
      const writer = SessionManager.open(file);
      if (start === "user") writer.appendMessage({ role: "user", content: "run the nightly check", timestamp: Date.now() });
      else if (start === "heartbeat_prompt") writer.appendCustomMessageEntry(start, "[heartbeat: */30 * * * * run#4]\n\ncheck the board", true);
      // As the daemon records them: an agent_message.send from another session names it and its relationship; the chat service's send_message
      // (a board.wake, a held outbox send) names only the service's client id.
      else writer.appendCustomMessageEntry("agent_message", "[agent-message from x]\n\nstatus?", true, start === "agent_message"
        ? { id: "m1", message: "status?", from: { sessionId: "01a14f00-0000-7000-8000-0000000000aa", activeSessionId: "w-aa", sessionName: "job", clientId: "agent" }, fromRelationship: "child" }
        : { id: "m2", message: "[board.wake] check the run", from: { clientId: "a5f0c1d2-service" } });
      writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "anthropic-messages", provider: "anthropic", model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() });
      writer.flushNow();
    },
    list: (rows: (all: SessionSummary[]) => SessionSummary[]) => { listed = rows(listed); },
    state: () => SessionManager.open(file).getSessionState()?.status,
    archivedChat: async () => (await archived.ids()).includes(id),
    chat: async () => (await index.ids()).includes(id),
    row: async () => (await catalog.rows()).find(row => row.id === id) };
}

test("a mem.3 daemon without saved_session_archive gets no new command, and the archive works as before", async t => {
  const f = await fixture(t, { known: OLD, box: OLD });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.box!.connections(), 0, "no connection opens for a command the daemon does not list");
  assert.deepEqual(f.sent, []);
  assert.equal(f.state(), "archived", "the session file records the archive, as before");
  assert.equal(await f.archivedChat(), true);
  assert.equal(await f.chat(), false);
  assert.equal((await f.row())?.archived, true);
});

test("a mem.3 daemon that is down still gets the archive as before, with no error", async t => {
  const f = await fixture(t, { known: OLD });
  t.mock.method(f.catalog, "connect", async () => { throw new Error("The Prime Agent daemon on this box is not reachable."); });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.state(), "archived");
  assert.equal(await f.archivedChat(), true);
});

test("a daemon replaced by an older one meanwhile gets nothing on the connection whose hello lacks the capability", async t => {
  const f = await fixture(t, { known: NEW, box: OLD });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.box!.connections(), 1);
  assert.deepEqual(f.box!.archives, []);
  assert.deepEqual(f.box!.other, []);
  assert.equal(f.state(), "archived");
  assert.equal(await f.archivedChat(), true);
});

test("an unloaded chat on this box is archived through archive_saved_session by its full path, with no kill and no wake", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: path => { SessionManager.open(path).appendSessionState({ status: "archived" }); return { success: true }; } });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.box!.archives.length, 1);
  const [archive] = f.box!.archives;
  assert.equal(archive!.sessionPath, f.file);
  assert.deepEqual(archive!.protocol, { name: "prime-agent.daemon", version: 7 });
  assert.equal(typeof archive!.clientId, "string");
  assert.equal(archive!.acked, true, "the answer is acknowledged, so the daemon's command journal can drop it");
  assert.deepEqual(f.box!.other, []);
  assert.deepEqual(f.sent, [], "no kill, attach, create or resume goes out");
  assert.equal(f.state(), "archived");
  assert.equal(await f.archivedChat(), true);
  assert.equal((await f.row())?.archived, true);
});

test("an unloaded chat on the Mac goes to the Mac's daemon by the Mac's path, and this box's daemon gets nothing", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, mac: NEW, host: "mac" });
  await f.chats.archive(f.id, "owner");
  assert.deepEqual(f.mac!.archives.map(archive => archive.sessionPath), [f.macFile]);
  assert.equal(f.box!.connections(), 0);
  assert.deepEqual(f.sent, []);
  assert.equal(f.state(), "active", "another box's file is that box's to write");
  assert.equal(await f.archivedChat(), true);
});

test("a Mac daemon without the capability gets nothing, as before", async t => {
  const f = await fixture(t, { known: OLD, box: NEW, mac: OLD, host: "mac" });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.mac!.connections(), 0);
  assert.equal(f.box!.connections(), 0);
  assert.equal(await f.archivedChat(), true);
});

test("a chat that loaded again before the archive is refused as resident, and only its own active session gets the owner's bare kill", async t => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { known: NEW, box: NEW, answer: () => {
    f.list(rows => rows.map(row => row.sessionId === f.id ? { ...row, activeSessionId: "w-2", workerState: "ready" } : row));
    return { success: false, error: RESIDENT };
  } });
  await f.chats.archive(f.id, "owner");
  assert.equal(f.box!.archives.length, 1);
  assert.deepEqual(f.sent.map(command => [command.type, command.activeSessionId, command.origin]), [["kill", "w-2", undefined]], "never w-other, never an origin");
  assert.equal(await f.archivedChat(), true);
});

test("a session loaded after the daemon confirmed the archive is left to its work, as an agent message may load an archived thread", async t => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { known: NEW, box: NEW, answer: () => {
    f.list(rows => rows.map(row => row.sessionId === f.id ? { ...row, activeSessionId: "w-3", workerState: "ready" } : row));
    return { success: true };
  } });
  await f.chats.archive(f.id, "owner");
  assert.deepEqual(f.sent, [], "no kill");
  assert.deepEqual(await f.pending(), []);
});

test("a chat the idle unload stopped while the archive's kill was out still gets archive_saved_session", async t => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { known: NEW, box: NEW, kill: active => {
    f.list(rows => rows.map(row => row.activeSessionId === active ? unloaded(row) : row));
    return { success: false, error: `Unknown active session: ${active}` };
  } });
  f.list(rows => rows.map(row => row.sessionId === f.id ? { ...row, activeSessionId: "w-1", workerState: "ready" } : row));
  await f.catalog.refresh();
  await f.chats.archive(f.id, "owner");
  assert.deepEqual(f.sent.map(command => [command.type, command.activeSessionId]), [["kill", "w-1"]]);
  assert.deepEqual(f.box!.archives.map(archive => archive.sessionPath), [f.file]);
});

test("a failed archive_saved_session is reported, the owner's archive still holds, and the cancel is queued by box and full path", async t => {
  let fail = true;
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => fail ? { success: false, error: "The supervisor is draining" } : { success: true } });
  await assert.rejects(f.chats.archive(f.id, "owner"), (error: unknown) => error instanceof ScheduledJobsLeft && /retries the cancel/.test(error.message));
  assert.equal(await f.archivedChat(), true, "archived-chats.json keeps the owner's archive");
  assert.equal(await f.chat(), false);
  assert.equal(f.state(), "archived", "the file records the archive as before, so the daemon's passive wakes skip it");
  assert.equal((await f.row())?.archived, true);
  assert.deepEqual((await f.pending()).map(entry => [entry.id, entry.host, entry.sessionPath, entry.archivedAt <= Date.now()]), [[f.id, null, f.file, true]]);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "nothing goes out before the entry is due");
  fail = false;
  f.later(61_000);
  await f.hub.cancels!.drain();
  assert.deepEqual(f.box!.archives.map(archive => archive.sessionPath), [f.file, f.file]);
  assert.deepEqual(await f.pending(), []);
  assert.deepEqual(f.sent, [], "the retry never kills or opens the session");
});

test("without a queue file the archive still reports that its jobs may still run", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, noQueue: true, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(f.chats.archive(f.id, "owner"), (error: unknown) => error instanceof ScheduledJobsLeft && /may still run/.test(error.message));
  assert.equal(await f.archivedChat(), true);
});

test("an offline Mac's cancel is queued, and goes to the Mac by the Mac's path on the first drain after the Mac answers", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, host: "mac" });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  assert.equal(f.box!.connections(), 0, "nothing is sent to this box instead");
  assert.equal(await f.archivedChat(), true);
  assert.equal((await f.row())?.archived, true);
  assert.deepEqual((await f.pending()).map(entry => [entry.host, entry.sessionPath, entry.offline]), [["mac", f.macFile, true]]);
  await f.hub.cancels!.drain();
  assert.equal((await f.pending())[0]!.tries, 1, "no try while the Mac is still down and the entry is not due");
  await f.startMac(NEW);
  await f.hub.cancels!.drain();
  assert.deepEqual(f.mac!.archives.map(archive => archive.sessionPath), [f.macFile], "the Mac answering again makes the entry due at once");
  assert.equal(f.box!.connections(), 0);
  assert.deepEqual(await f.pending(), []);
  assert.deepEqual(f.sent, []);
});

test("the owner's reopen ends a pending cancel, and waits for a retry already out so no cancel lands after it", async t => {
  let mode: "fail" | "hold" = "fail";
  let release = (): void => {};
  let out = (): void => {};
  const sentOut = new Promise<void>(resolve => { out = resolve; });
  const f = await fixture(t, { known: NEW, box: NEW, answer: async () => {
    if (mode === "fail") return { success: false, error: "The supervisor is draining" };
    out();
    await new Promise<void>(resolve => { release = resolve; });
    return { success: false, error: "The supervisor is draining" };
  } });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  assert.equal((await f.pending()).length, 1, "the failed cancel is queued");
  mode = "hold";
  f.later(61_000);
  const retry = f.hub.cancels!.drain();
  await sentOut;
  const order: string[] = [];
  const reopen = f.hub.unarchive(f.id).then(() => { order.push("reopened"); });
  await Promise.race([reopen, new Promise(resolve => setTimeout(resolve, 500))]);
  assert.equal(order.length, 0, "the reopen waits while the retry is out");
  order.push("retry answered");
  release();
  await Promise.all([retry, reopen]);
  assert.deepEqual(order, ["retry answered", "reopened"]);
  assert.deepEqual(await f.pending(), [], "the reopen dropped the entry and the retry did not put it back");
  assert.equal(f.state(), "active");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 2, "no cancel after the reopen");
});

test("an agent message that loads the archived thread is never killed, and the cancel never ends the work it answered", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  f.later(1_000);
  f.list(rows => rows.map(row => row.sessionId === f.id ? { ...row, activeSessionId: "w-9", workerState: "ready", lifecycle: "live" } : row));
  await f.catalog.refresh();
  f.turn("agent_message");
  f.later(61_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "no cancel while the session is loaded");
  assert.equal((await f.pending()).length, 1, "the entry waits for the unload");
  f.list(rows => rows.map(row => row.sessionId === f.id ? unloaded(row) : row));
  await f.catalog.refresh();
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "the answer's work is not cancelled");
  assert.deepEqual(await f.pending(), []);
  assert.deepEqual(f.sent, [], "never a kill");
});

test("a heartbeat that fires on the Mac while it is offline is no reopen: the owner's cancel still goes out after the Mac answers", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, host: "mac" });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  f.later(1_000);
  f.turn("heartbeat_prompt");
  f.later(1_000);
  f.turn("heartbeat_prompt");
  await f.hub.cancels!.drain();
  assert.equal((await f.pending())[0]!.tries, 1, "nothing while the Mac is down");
  await f.startMac(NEW);
  await f.hub.cancels!.drain();
  assert.deepEqual(f.mac!.archives.map(archive => archive.sessionPath), [f.macFile]);
  assert.deepEqual(await f.pending(), []);
  assert.deepEqual(f.sent, []);
});

test("a user prompt after the archive, which a plain cron run writes too, keeps the cancel pending and sends nothing", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  f.later(1_000);
  f.turn("heartbeat_prompt");
  f.turn("user");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "no cancel on an unproven wake");
  const [entry] = await f.pending();
  assert.equal(entry?.tries, 2, "still pending, never cleared");
  assert.match(entry!.error, /user prompt/);
  await f.hub.unarchive(f.id);
  assert.deepEqual(await f.pending(), [], "the owner's reopen settles it");
});

test("a message the chat service delivered, such as a board.wake or a held outbox send, is no authorized resume: the cancel stays pending", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  f.later(1_000);
  f.turn("service_message");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "no cancel and no drop");
  const [entry] = await f.pending();
  assert.match(entry!.error, /service-sent message/);
  f.turn("agent_message");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.deepEqual(await f.pending(), [], "a later message from another session settles it as accepted work");
  assert.equal(f.box!.archives.length, 1);
});

test("a Mac whose session file does not read keeps the cancel pending and sends nothing", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, host: "mac" });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  await f.startMac(NEW);
  t.mock.method(f.catalog, "localFile", async () => { throw new Error("relay read failed"); });
  await f.hub.cancels!.drain();
  assert.equal(f.mac!.archives.length, 0);
  assert.match((await f.pending())[0]!.error, /did not read/);
});

test("the idle unload's rewrite after its own stop never reopens a thread whose cancel is pending, also after a service start", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  const restarted = f.restartedHub();
  t.after(() => restarted.close());
  assert.equal(await restarted.keepListed(f.id, 0), false, "a service start forgets its archive times, and the queue file still holds the archive");
  assert.equal(f.state(), "archived");
  assert.equal((await f.pending()).length, 1);
});

/** Prime's answer when it archived the session and cancelled its jobs but could not read a handed-off service's receipt (contract addendum 2026-10-19T01:07Z). */
const STOP_PENDING: Answer = { success: false, error: "Detached handoff ownership is unresolved", errorInfo: { code: "ownership_unresolved", sessionId: "s",
  unresolved: [{ handoffId: "h-b", errorClass: "EACCES", sessionId: "s" }], intentPersisted: true, sessionArchived: true } };

test("an archive whose only open part is Prime's stop of a handed-off service says the jobs are cancelled, and queues no archive retry", async t => {
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => STOP_PENDING });
  await assert.rejects(f.chats.archive(f.id, "owner"), (error: unknown) => error instanceof ServicesStopPending && !(error instanceof ScheduledJobsLeft) &&
    /scheduled jobs are cancelled/.test(error.message) && /h-b: EACCES/.test(error.message) && !/may still run|not cancelled/.test(error.message));
  assert.equal(await f.archivedChat(), true, "the owner's archive holds");
  assert.equal(f.state(), "archived");
  assert.deepEqual(await f.pending(), [], "Prime finishes its own stop intent, so the app keeps no archive retry");
  f.later(1_000);
  f.turn("agent_message");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 1, "an authorized agent reply is never followed by a second archive");
  assert.deepEqual(f.sent, [], "never a kill");
});

test("a queued retry that Prime answers with a pending service stop ends the retry, and an agent reply after it reissues nothing", async t => {
  let answer: Answer = { success: false, error: "The supervisor is draining" };
  const f = await fixture(t, { known: NEW, box: NEW, answer: () => answer });
  await assert.rejects(f.chats.archive(f.id, "owner"), ScheduledJobsLeft);
  assert.equal((await f.pending()).length, 1);
  answer = STOP_PENDING;
  f.later(61_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 2);
  assert.deepEqual(await f.pending(), [], "the jobs are cancelled, so the retry ends");
  f.turn("agent_message");
  f.later(3_600_000);
  await f.hub.cancels!.drain();
  assert.equal(f.box!.archives.length, 2, "no archive after the agent reply");
});

test("a queued retry whose session answered an authorized agent message is dropped before any archive goes out", async t => {
  const failing = await fixture(t, { known: NEW, box: NEW, answer: () => ({ success: false, error: "The supervisor is draining" }) });
  await assert.rejects(failing.chats.archive(failing.id, "owner"), ScheduledJobsLeft);
  failing.later(1_000);
  failing.turn("agent_message");
  failing.later(61_000);
  await failing.hub.cancels!.drain();
  assert.equal(failing.box!.archives.length, 1, "the resume rule drops the retry, so the archive is not reissued over the new work");
  assert.deepEqual(await failing.pending(), []);
});

test("archiveSavedSession reads a link that closes before the answer as failed", async t => {
  const dir = mkdtempSync(join(home, "close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "d.sock");
  const server = createServer(socket => {
    socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: NEW })}\n`);
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answer = await archiveSavedSession(path, "/x.jsonl", 5000);
  assert.equal(answer.kind, "failed");
  assert.equal((await archiveSavedSession(join(dir, "none.sock"), "/x.jsonl", 5000)).kind, "failed");
});

test("resumeSince reads from the end across chunk edges and multibyte text, and only a message another session sent is accepted", async t => {
  const dir = mkdtempSync(join(home, "since-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 20, 0, seconds)).toISOString();
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  const path = join(dir, "s.jsonl");
  const write = (lines: string[]) => writeFileSync(path, lines.join(""));
  const archive = Date.UTC(2026, 9, 18, 20, 0, 2);
  const SELF = "01a14f00-0000-7000-8000-0000000000ff";
  const old = line({ type: "message", timestamp: at(1), message: { role: "user", content: "before the archive" } });
  const sender = { from: { sessionId: "01a14f00-0000-7000-8000-0000000000aa", clientId: "agent" }, fromRelationship: "sibling" };
  const agent = line({ type: "custom_message", timestamp: at(3), customType: "agent_message", content: "é".repeat(1_500_000), display: true, details: sender });
  const wake = line({ type: "custom_message", timestamp: at(3), customType: "agent_message", content: "[board.wake]", display: true, details: { from: { clientId: "svc" } } });
  const self = line({ type: "custom_message", timestamp: at(3), customType: "agent_message", content: "me", display: true,
    details: { from: { sessionId: SELF }, fromRelationship: "sibling" } });
  const user = line({ type: "message", timestamp: at(4), message: { role: "user", content: "nightly" } });
  const beat = line({ type: "custom_message", timestamp: at(5), customType: "heartbeat_prompt", content: "[heartbeat]", display: true });
  const pad = line({ type: "message", timestamp: at(6), message: { role: "assistant", content: "ü".repeat(800_000) } });
  write([old, agent, user, beat, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "accepted");
  write([old, wake, beat, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "unproven", "a send with no sending session proves nothing");
  const noFamily = line({ type: "custom_message", timestamp: at(3), customType: "agent_message", content: "relay", display: true,
    details: { from: { sessionId: "01a14f00-0000-7000-8000-0000000000aa" } } });
  const badFamily = line({ type: "custom_message", timestamp: at(3), customType: "agent_message", content: "relay", display: true,
    details: { from: { sessionId: "01a14f00-0000-7000-8000-0000000000aa" }, fromRelationship: "owner" } });
  for (const unproven of [noFamily, badFamily]) {
    write([old, unproven, beat, pad]);
    assert.equal(await resumeSince(path, archive, SELF), "unproven", "a sender session with no valid family relationship proves nothing");
  }
  write([old, self, beat, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "unproven", "the session's own id is no other sender");
  write([old, user, beat, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "unproven");
  write([old, beat, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "scheduled");
  write([old, pad]);
  assert.equal(await resumeSince(path, archive, SELF), "none");
  await assert.rejects(resumeSince(join(dir, "missing.jsonl"), archive, SELF));
});

test("the hub records the service's own archive before it goes out, and the owner's later archive takes the record back", async t => {
  const f = await fixture(t, { known: OLD, box: OLD });
  const { serviceArchiveRecord } = await import("../src/service-archives.ts");
  const { archiveDutyJob } = await import("../src/chat-duty-job.ts");
  f.hub.serviceArchives = serviceArchiveRecord(join(mkdtempSync(join(tmpdir(), "service-archives-")), "service-archives.json"));
  const before = Date.now();
  await archiveDutyJob(f.hub, () => f.catalog.rows())(f.id);
  assert.equal(f.state(), "archived");
  const entry = await f.hub.serviceArchiveOf(f.id);
  assert.equal(entry?.reason, "duty_job_end");
  assert.ok(entry!.at >= before, "the record is written as the archive starts");
  await f.hub.archive(f.id, "owner");
  assert.equal(await f.hub.serviceArchiveOf(f.id), undefined);
});
