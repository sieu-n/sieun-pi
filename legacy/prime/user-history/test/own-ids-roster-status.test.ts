// d7 11-04: at 22:17:26Z on 11-03 the chat on us-metal02 ran an 847 ms major GC inside a 1.86 s run of its main thread (CI on 37 of 80 cores).
// Most of the ~330 roster updates a minute change only a live row's status, yet each one made the catalog's ownNow build Sets of all ~8,400
// rows' ids again (2.4 s of main-thread time from 22:15:00Z to 22:17:27Z), and Sets that size live in V8's large-object space, which only a
// major GC frees. The copy now keeps an idsVersion that moves only when a row's ids can have changed, and ownNow and isActive key on it.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { type RosterUpdate, SessionPeer } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const row = (id: string, live: boolean, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, messageCount: 3, ...(live ? { activeSessionId: `a-${id}` } : {}), ...extra }) as SessionSummary;
const status = (n: number): RosterUpdate => ({ changed: [{ agentId: "live", status: n % 2 ? "running" : "idle", summary: row("live", true, { sessionName: `turn ${n}` }) }] });

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

test("roster updates that change only a live row's status keep the catalog's own id Sets, and a start or stop builds them again", async t => {
  const box = [row("live", true), ...Array.from({ length: 2_000 }, (_, n) => row(`saved-${n}`, false))];
  const catalog = catalogOf(t, box);
  await catalog.refresh();
  const peer = Reflect.get(catalog, "peer") as SessionPeer;
  const roster = (update: RosterUpdate): void => { (Reflect.get(peer, "onRoster") as (update: RosterUpdate) => void).call(peer, update); };
  const ownNow = () => (Reflect.get(catalog, "ownNow") as () => { own: ReadonlySet<string>; ownActive: ReadonlySet<string> }).call(catalog);
  const first = ownNow();
  for (let n = 0; n < 50; n++) {
    roster(status(n));
    assert.equal(ownNow().own, first.own, `status update ${n} built the own ids again`);
  }
  assert.equal(peer.list().find(entry => entry.sessionId === "live")?.sessionName, "turn 49", "the rows still take each update");
  roster({ changed: [{ agentId: "saved-7", status: "running", summary: row("saved-7", true) }] });
  assert.notEqual(ownNow().own, first.own);
  assert.equal(ownNow().ownActive.has("a-saved-7"), true, "a started worker's active session is this box's");
  roster({ removed: ["saved-7"] });
  assert.equal(ownNow().ownActive.has("a-saved-7"), false, "a stopped worker's active session is gone");
  assert.equal(peer.isActive("a-live"), true);
  roster({ changed: [{ agentId: "fresh", status: "running", summary: row("fresh", true) }] });
  assert.equal(ownNow().own.has("fresh"), true, "a row that joins is this box's");
  assert.equal(peer.isActive("a-fresh"), true);
});
