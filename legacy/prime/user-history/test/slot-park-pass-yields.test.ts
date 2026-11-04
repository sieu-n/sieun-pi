// d7 11-04: at 21:56:20Z on 11-03, with CI on 51 of 80 cores, the catalog's passes over every agent's slot park (each read stats its session
// file in-line before its first await) and spawned count (a folder read in-line) ran in one go beside a major GC, and held the chat's main
// thread 1.3 s. Both passes now give the loop a turn every PROJECTION_SLICE_MS, like the rest of the projection.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog, PROJECTION_SLICE_MS } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ROOT = "01a162bc-47b4-770b-a9fc-19c3a742e730";
const AGENTS = 120;
const SPIN_MS = 4;
const child = (n: number): SessionSummary => ({ sessionId: `child-${n}`, activeSessionId: `ac${n}`, cwd: "/tmp", parentSessionId: ROOT, rlmChildId: `job-${n}`,
  runtimeKind: "subagent", sessionName: `job ${n}`, messageCount: 2, rosterStatus: "idle", activity: "idle", isStreaming: false }) as SessionSummary;

function catalogOf(t: TestContext): Catalog {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set([ROOT]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = [{ sessionId: ROOT, activeSessionId: "aroot", cwd: "/tmp", sessionName: "root chat", messageCount: 3 } as SessionSummary,
    ...Array.from({ length: AGENTS }, (_, n) => child(n))];
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  return catalog;
}

test("the slot park and spawned-count passes over many stopped agents give the loop a turn between agents", async t => {
  const catalog = catalogOf(t);
  await catalog.refresh();
  await catalog.event();
  // Each agent's row lookup in either pass takes SPIN_MS, standing in for its in-line stat or folder read, as statSync does on a box with CI on
  // 51 of 80 cores. The test counts the loop's turns between the lookups, not their wall time, so a loaded test box reads the same.
  const find = Reflect.get(catalog, "find") as (id: string) => unknown;
  let ticks = 0;
  let parkReads = 0;
  let turnsWithin = 0;
  let lastTicks = -1;
  t.mock.method(catalog as unknown as { find: (id: string) => unknown }, "find", function (this: Catalog, id: string) {
    if (id.startsWith("child-")) {
      parkReads += 1;
      if (lastTicks >= 0) turnsWithin += ticks - lastTicks;
      lastTicks = ticks;
      for (const end = performance.now() + SPIN_MS; performance.now() < end;);
    }
    return find.call(this, id);
  });
  let ticking = true;
  const tick = (): void => { ticks += 1; if (ticking) setImmediate(tick); };
  setImmediate(tick);
  catalog.notify();
  await catalog.rows();
  ticking = false;
  assert.ok(parkReads >= AGENTS, `the projection read ${parkReads} parks`);
  const least = Math.floor((parkReads * SPIN_MS) / PROJECTION_SLICE_MS / 2);
  assert.ok(turnsWithin >= least, `the loop got ${turnsWithin} turns between ${parkReads} lookups of ${SPIN_MS} ms, under ${least}`);
});
