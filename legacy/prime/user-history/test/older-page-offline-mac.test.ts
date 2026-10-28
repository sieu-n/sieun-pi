// Guards 10-25 11:57Z on us-metal02, the one dirty minute of d7's 12:22Z run: with the owner's Mac offline, the chat service answered the older
// page of Mac chat 01a15427 in 1,044 ms. The Mac's copy lacked the chat, and each lookup of a session the rows lack listed this box's roster
// and indexed every row again before it answered (89 to 1,491 ms a read on a scratch serve with the live daemon's 5,720 rows). Meanwhile the
// Mac copy's failed background full list went again at once, about 750 times a second, 11.8 million service.log lines from 10-23 to 10-25.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { RESYNC_MS, SessionPeer } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const row = (id: string): SessionSummary => ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, messageCount: 3 }) as SessionSummary;
/** A UUIDv7 session id made at `at` (epoch ms). */
const bornAt = (at: number): string => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`;
};

test("a lookup of an old session the rows lack answers without listing the roster again, and a new one still lists it", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  const asked: string[] = [];
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string; all?: boolean }) => {
    if (command.type !== "list") return { success: true, data: {} };
    asked.push(command.all ? "all" : "roster");
    return { success: true, data: { sessions: [row("here")] } };
  });
  Object.defineProperty(catalog.client, "isConnected", { get: () => connected });
  await catalog.refresh();
  asked.length = 0;

  const old = bornAt(Date.now() - 6 * 86_400_000);
  assert.equal(await catalog.summary(old), undefined);
  assert.deepEqual(asked, [], "a session made 6 days ago that the rows lack is not on this box's roster, so the lookup lists nothing");
  assert.equal(await catalog.summary(bornAt(Date.now() - 1000)), undefined);
  assert.deepEqual(asked, ["roster"], "a session made a second ago may be missing from the rows yet, so the lookup lists the roster");
  assert.equal(await catalog.summary("a"), undefined);
  assert.deepEqual(asked, ["roster", "roster"], "an id that names no time keeps the list");
});

test("a failed background full list goes again after the reconnect wait, not at once", async (t: TestContext) => {
  let tries = 0;
  let offline = false;
  const client = {
    isConnected: false,
    reconnect: async () => { client.isConnected = true; },
    waitForHello: async () => ({ appVersion: "0.9.8" }),
    resetTransportForReconnect: () => { client.isConnected = false; },
    onMessage: () => () => {},
    onClose: () => () => {},
    close: () => {},
    request: async (command: { type: string; all?: boolean }) => {
      if (command.type !== "list") return { success: true, data: {} };
      return { success: true, data: { sessions: [row("m")] } };
    },
  };
  const logs: string[] = [];
  const peer = new SessionPeer({ name: "mac", client: client as unknown as DaemonClient, file: null, deadlines: { socketMs: 10, helloMs: 10 }, changeMs: 0,
    reconnectMs: 50, pollMs: 10_000, log: line => logs.push(line), reach: async () => { if (!offline) return null; tries++; return "mac is offline"; }, onChange: () => {} });
  t.after(() => peer.close());
  await peer.sync();
  // The Mac goes offline once its copy's full list is RESYNC_MS old, as the live copy's was.
  (peer as unknown as { fullAt: number }).fullAt = Date.now() - RESYNC_MS - 1000;
  offline = true;
  client.isConnected = false;
  (peer as unknown as { subscribed: boolean }).subscribed = false;
  const inner = peer as unknown as { resyncTimer: ReturnType<typeof setTimeout> | undefined; scheduleResync(): void };
  clearTimeout(inner.resyncTimer);
  inner.resyncTimer = undefined;
  inner.scheduleResync();
  await new Promise(resolve => setTimeout(resolve, 300));
  // The reconnect loop dials every 50 ms too, so the two loops come to about 12 tries.
  assert.ok(tries <= 20, `the copy dialed the offline Mac ${tries} times in 300 ms`);
  assert.equal(logs.filter(line => line.includes("background full list")).length, 1, "the same failure is logged once");
});
