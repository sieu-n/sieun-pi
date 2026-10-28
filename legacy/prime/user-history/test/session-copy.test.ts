// Guards the 10-18 owner report on us-metal02 (15:15 KST): the page showed "The Prime Agent daemon is not reachable. Timed out after 30000ms
// waiting for the Prime Agent daemon response to "list"" while this box's full list answered in 0.1 to 5.8 s, because a refresh that waited 30 s
// set the whole page down, and every service start ran the Mac's full list (3,051 rows, 38 MB, 11 s) before the Mac's rows showed.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { RESYNC_MS, SessionPeer } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { SessionsEvent } from "../src/shared/types.ts";

const row = (id: string, live: boolean, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, messageCount: 3, ...(live ? { activeSessionId: `a-${id}` } : {}), ...extra }) as SessionSummary;

/** A daemon link: `list` answers from `box`, `hold` keeps roster lists from answering, and `fail` makes connects fail. */
function fakeDaemon(box: { live: SessionSummary[]; saved: SessionSummary[] }) {
  const asked: string[] = [];
  const messages = new Set<(message: { type: string }) => void>();
  const closes = new Set<(error: Error) => void>();
  const state = { hold: false, fail: false, connected: false, held: [] as ((error: Error) => void)[] };
  const client = {
    get isConnected() { return state.connected; },
    reconnect: async () => { if (state.fail) throw new Error("connect ENOENT /tmp/daemon.sock"); state.connected = true; },
    waitForHello: async () => ({ appVersion: "0.9.8" }),
    resetTransportForReconnect: () => { state.connected = false; },
    onMessage: (listener: (message: { type: string }) => void) => { messages.add(listener); return () => messages.delete(listener); },
    onClose: (listener: (error: Error) => void) => { closes.add(listener); return () => closes.delete(listener); },
    close: () => {},
    request: async (command: { type: string; all?: boolean }) => {
      if (command.type !== "list") return { success: true, data: { jobs: [] } };
      asked.push(command.all ? "all" : "roster");
      if (state.hold && !command.all) await new Promise((_, reject) => { state.held.push(reject); });
      const savedOnly = box.saved.filter(saved => !box.live.some(live => live.sessionId === saved.sessionId));
      return { success: true, data: { sessions: command.all ? [...box.live, ...savedOnly] : box.live } };
    },
  };
  return { client: client as unknown as DaemonClient, asked, state, send: (message: object) => { for (const listener of messages) listener(message as { type: string }); },
    drop: () => { state.connected = false; for (const listener of closes) listener(new Error("Connection to the Prime Agent daemon closed.")); } };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test("a refresh that waits past 30 s rejects for its caller and leaves the page up; only a failed connect shows a banner, and it names the box", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }));
  catalog.fullListClient = () => catalog.client;
  t.after(() => catalog.close());
  const dir = await mkdtemp(join(tmpdir(), "session-copy-banner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const id of ["a", "b"]) await writeFile(join(dir, `${id}.jsonl`), "");
  const daemon = fakeDaemon({ live: [row("a", true, { sessionFile: join(dir, "a.jsonl") })], saved: [row("b", false, { sessionFile: join(dir, "b.jsonl") })] });
  const client = catalog.client as unknown as Record<string, unknown>;
  for (const key of ["reconnect", "waitForHello", "request", "resetTransportForReconnect"]) t.mock.method(catalog.client, key as "request", (daemon.client as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!);
  Object.defineProperty(client, "isConnected", { get: () => daemon.state.connected });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames: SessionsEvent[] = [];
  catalog.subscribe(event => frames.push(event));
  await settle();
  assert.deepEqual(daemon.asked, ["all"], "the first start with no copy lists everything once");
  daemon.state.hold = true;
  const waiting = catalog.refresh();
  const failed = waiting.then(() => null, (error: Error) => error.message);
  await settle();
  t.mock.timers.tick(30_000);
  assert.match(await failed ?? "", /Timed out after 30000ms waiting for the session list of this box/);
  await settle();
  assert.equal(frames.some(frame => frame.daemon === "down"), false, "a slow list is no banner");
  assert.equal((await catalog.event()).daemon, "up");
  daemon.state.hold = false;
  daemon.state.fail = true;
  daemon.state.connected = false;
  // A closed link rejects the requests it carried, as DaemonClient's rejectAll does.
  const closed = new Error("Connection to the Prime Agent daemon closed.");
  for (const reject of daemon.state.held) reject(closed);
  for (const listener of client.closeListeners as Set<(error: Error) => void>) listener(closed);
  await settle();
  assert.equal(frames.some(frame => frame.daemon === "down"), false, "a closed link shows no banner before its reconnect fails");
  t.mock.timers.tick(2000);
  await settle();
  const down = frames.findLast(frame => frame.daemon === "down");
  assert.match(down?.error ?? "", /^The Prime Agent daemon on this box is not reachable\. connect ENOENT/);
  assert.deepEqual(down?.sessions.map(session => session.id).sort(), ["a", "b"], "the page keeps the rows it had");
});

test("a restart serves the box's copy from disk with no full list, roster updates keep it current, and a full list runs only when the copy is 30 min old", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "session-copy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "mac.sessions.json");
  const box = { live: [row("a", true)], saved: Array.from({ length: 50 }, (_, i) => row(`s${i}`, false)) };
  const open = (daemon: ReturnType<typeof fakeDaemon>) => new SessionPeer({ name: "mac", client: daemon.client, file, deadlines: { socketMs: 10, helloMs: 10 }, changeMs: 0,
    reconnectMs: 10, log: () => {}, onChange: () => {} });

  const first = fakeDaemon(box);
  const before = open(first);
  t.after(() => before.close());
  await before.sync();
  await before.flushed();
  assert.deepEqual(first.asked, ["all"]);
  before.close();

  const second = fakeDaemon(box);
  const after = open(second);
  t.after(() => after.close());
  box.live = [row("a", true, { sessionName: "renamed" }), row("n", true)];
  await after.sync();
  assert.deepEqual(second.asked, ["roster"], "the restart lays the roster over the disk copy instead of a full list");
  assert.equal(after.list().length, 52);
  assert.equal(after.list().find(entry => entry.sessionId === "a")?.sessionName, "renamed");
  second.send({ type: "roster_update", changed: [{ agentId: "n", status: "running", summary: row("n", true, { sessionName: "started" }) }], removed: ["a"] });
  assert.deepEqual(second.asked, ["roster"], "a roster update lists nothing");
  assert.equal(after.list().find(entry => entry.sessionId === "n")?.sessionName, "started");
  assert.equal(after.list().find(entry => entry.sessionId === "a")?.activeSessionId, undefined, "a removed agent's row is saved");
  after.close();

  await writeFile(file, JSON.stringify({ version: 1, fullAt: Date.now() - RESYNC_MS - 1000, rows: [row("old", false)] }));
  const third = fakeDaemon(box);
  const stale = open(third);
  t.after(() => stale.close());
  await stale.sync();
  assert.deepEqual(third.asked, ["roster"], "the page reads the old copy at once");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(third.asked, ["roster", "all", "roster"], "the 30 min old copy gets one full list in the background");
  assert.equal(stale.list().some(entry => entry.sessionId === "old"), false);
});

test("the first frame after a service start is the box's copy from disk, with no down frame and no empty list before it (socket activation, f0f25d495)", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "session-copy-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const id of ["a", "b"]) await writeFile(join(dir, `${id}.jsonl`), "");
  const rows = [row("a", true, { sessionFile: join(dir, "a.jsonl") }), row("b", false, { sessionFile: join(dir, "b.jsonl") })];
  const copy = join(dir, "session-copy.json");
  await writeFile(copy, JSON.stringify({ version: 1, fullAt: Date.now(), rows }));
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }), null, copy);
  catalog.fullListClient = () => catalog.client;
  t.after(() => catalog.close());
  const daemon = fakeDaemon({ live: [rows[0]!], saved: [rows[1]!] });
  let release!: () => void;
  const connected = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(catalog.client, "reconnect", async () => { await connected; daemon.state.connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", (daemon.client as unknown as { request: DaemonClient["request"] }).request);
  Object.defineProperty(catalog.client, "isConnected", { get: () => daemon.state.connected });
  const frames: SessionsEvent[] = [];
  catalog.subscribe(event => frames.push(event));
  await new Promise(resolve => setTimeout(resolve, 20));
  await catalog.notify();
  assert.equal(frames.length, 0, "no frame goes out while the restarted service connects");
  release();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(frames[0]?.daemon, "up");
  assert.deepEqual(frames[0]?.sessions.map(session => session.id).sort(), ["a", "b"], "the first frame is the copy");
  assert.equal(frames.some(frame => frame.daemon === "down" || frame.sessions.length === 0), false);
  assert.deepEqual(daemon.asked, ["roster"], "the start lists only the roster");
});

test("another box's link never subscribes to its roster and lists the roster every poll instead, because the Mac's roster_update stream resent its whole roster without end (10-18, 199.7 MB in 9 min)", async (t: TestContext) => {
  const daemon = fakeDaemon({ live: [row("a", true)], saved: [row("b", false)] });
  const types: string[] = [];
  const request = (daemon.client as unknown as { request: (command: { type: string }) => Promise<unknown> }).request;
  (daemon.client as unknown as { request: (command: { type: string; all?: boolean }) => Promise<unknown> }).request = async command => { types.push(command.type === "list" && command.all ? "list all" : command.type); return request(command); };
  const peer = new SessionPeer({ name: "mac", client: daemon.client, file: null, deadlines: { socketMs: 10, helloMs: 10 }, changeMs: 0, reconnectMs: 10, pollMs: 15,
    log: () => {}, onChange: () => {} });
  t.after(() => peer.close());
  await peer.sync();
  assert.equal(peer.state, "up");
  daemon.state.connected = true;
  // A fixed 60 ms wait saw one poll under a release's full suite at concurrency 20 on 10-20; the polls come every 15 ms, so wait for two.
  for (const until = Date.now() + 5000; types.filter(type => type === "list").length < 2 && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(types.includes("roster_subscribe"), false, "no roster stream from another box");
  assert.equal(types[0], "list all");
  assert.ok(types.filter(type => type === "list").length >= 2, `the roster is listed every poll: ${types.join(", ")}`);
  assert.deepEqual(peer.list().map(entry => entry.sessionId).sort(), ["a", "b"]);
});

// 10-24 us-metal02, CPU profile pid626077: with the Mac down for 30 min, every list() call copied each Mac row to its saved form, and the watch
// asks for the rows several times a tick, which held the chat's event loop up to 376 ms and 59 s in 50 min. A copy now answers once per version.
test("a down box's rows read as saved and one answer serves every call until the copy changes", async (t: TestContext) => {
  const box = { live: [row("a", true)], saved: Array.from({ length: 3000 }, (_, i) => row(`s${i}`, false)) };
  const daemon = fakeDaemon(box);
  const peer = new SessionPeer({ name: "mac", client: daemon.client, file: null, deadlines: { socketMs: 10, helloMs: 10 }, changeMs: 0, reconnectMs: 60_000,
    log: () => {}, onChange: () => {} });
  t.after(() => peer.close());
  await peer.sync();
  const up = peer.list();
  assert.equal(up.find(entry => entry.sessionId === "a")?.activeSessionId, "a-a");
  assert.equal(peer.list(), up, "an unchanged copy answers with the same rows");
  daemon.state.fail = true;
  daemon.drop();
  await peer.sync().catch(() => {});
  await settle();
  const down = peer.list();
  assert.equal(down.length, 3001);
  assert.equal(down.find(entry => entry.sessionId === "a")?.activeSessionId, undefined, "a down box's live row reads as saved");
  assert.equal(peer.list(), down, "a down box copies its rows once, not on every call");
  assert.equal(peer.patch("s7", { sessionName: "renamed" }), true);
  assert.equal(peer.list().find(entry => entry.sessionId === "s7")?.sessionName, "renamed", "a change makes a new answer");
});
