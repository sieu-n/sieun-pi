// d7 11-04: at 23:21:49Z on 11-03, with CI on 38 of 80 cores, the chat's event loop stalled 1.3 s, and 0.8 s of it sat between two CPU samples
// in the idle unload's park watch, which walked every one of the ~8,400 daemon rows on each roster update to find the few hundred with a
// worker. The watch now reads only the rows with a worker, whose keys the copy keeps until a row starts, stops, joins or leaves.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { parkChanges } from "../src/idle-unload.ts";
import type { RosterUpdate, SessionPeer } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const row = (id: string, live: boolean, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, messageCount: 3, lifecycle: live ? "live" : "saved", ...(live ? { activeSessionId: `a-${id}` } : {}), ...extra }) as SessionSummary;

function catalogOf(t: TestContext, box: SessionSummary[]): Catalog {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  return catalog;
}

test("the park watch's rows are the live rows, and a status-only roster update reads them without a pass over every row", async t => {
  const parked = { isQuotaParked: true, activity: "idle", isSessionActive: false } as Partial<SessionSummary>;
  const box = [row("live", true), row("parked", true, parked), ...Array.from({ length: 2_000 }, (_, n) => row(`saved-${n}`, false))];
  const catalog = catalogOf(t, box);
  await catalog.refresh();
  const peer = Reflect.get(catalog, "peer") as SessionPeer;
  const roster = (update: RosterUpdate): void => { (Reflect.get(peer, "onRoster") as (update: RosterUpdate) => void).call(peer, update); };
  const live = () => catalog.daemonLiveRows().map(entry => entry.sessionId).sort();
  assert.deepEqual(live(), ["live", "parked"]);
  assert.deepEqual(parkChanges(new Map(), catalog.daemonLiveRows()), parkChanges(new Map(), catalog.daemonRows()), "the watch finds what a pass over every row finds");

  const rows = Reflect.get(peer, "rows") as Map<string, SessionSummary>;
  const passes = t.mock.method(rows, "entries");
  const values = t.mock.method(rows, "values");
  const iterate = t.mock.method(rows, Symbol.iterator);
  for (let n = 0; n < 20; n++) {
    roster({ changed: [{ agentId: "live", status: n % 2 ? "running" : "idle", summary: row("live", true, { sessionName: `turn ${n}` }) }] });
    assert.equal(catalog.daemonLiveRows().find(entry => entry.sessionId === "live")?.sessionName, `turn ${n}`, "the live row is the update's");
  }
  assert.equal(passes.mock.callCount() + values.mock.callCount() + iterate.mock.callCount(), 0, "no status update walked every row");

  roster({ changed: [{ agentId: "saved-7", status: "running", summary: row("saved-7", true) }] });
  assert.deepEqual(live(), ["live", "parked", "saved-7"], "a started worker's row joins");
  roster({ removed: ["live"] });
  assert.deepEqual(live(), ["parked", "saved-7"], "a stopped worker's row leaves");
});
