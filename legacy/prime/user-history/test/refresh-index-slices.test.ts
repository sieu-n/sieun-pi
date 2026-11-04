// d7 11-04: 5 s after release-3750cce started at 01:15:49Z, the catalog's first index of every row held the chat's main thread 1.05 s in one
// run with CI on 42 of 80 cores, and d7 read a 1.49 s loop stall for 01:16Z. A refresh's index now gives the loop a turn every
// PROJECTION_SLICE_MS, and a reader in between still gets rows no older than the refresh's list.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ROWS = 60_000;
const row = (n: number): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionFile: `/s/s${n}.jsonl`, messageCount: 3, lifecycle: "saved" }) as unknown as SessionSummary;

function catalogOf(t: TestContext, onRoster: () => void, onList: () => void = () => {}): Catalog {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }),
    roster: async () => { onRoster(); } };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const box = Array.from({ length: ROWS }, (_, n) => row(n));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    onList();
    return { success: true, data: { sessions: box } };
  });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  return catalog;
}

test("the first refresh's index of every row gives the loop turns, and the rows are all there after it", async t => {
  let ticks = 0;
  let ticking = true;
  const tick = (): void => { ticks += 1; if (ticking) setImmediate(tick); };
  let atRoster = -1;
  let atStart = -1;
  // The list answers just before the index starts, so the turns from then to the roster hand-on are the index's.
  const catalog = catalogOf(t, () => { if (atRoster < 0) atRoster = ticks; }, () => { if (atStart < 0) atStart = ticks; });
  setImmediate(tick);
  await catalog.refresh();
  await new Promise(resolve => setImmediate(resolve));
  ticking = false;
  assert.ok(atStart >= 0 && atRoster >= 0, "the refresh indexed the rows and handed the roster on");
  assert.ok(atRoster - atStart >= 2, `the loop got ${atRoster - atStart} turns while ${ROWS} rows were indexed`);
  assert.equal((Reflect.get(catalog, "summaries") as Map<string, unknown>).size, ROWS);
});

test("a reader during the sliced index gets the refresh's rows at once", async t => {
  const catalog = catalogOf(t, () => {});
  const refreshing = catalog.refresh();
  let found: unknown;
  const reader = (async () => {
    for (let n = 0; n < 50 && found === undefined; n++) {
      await new Promise(resolve => setImmediate(resolve));
      found = (Reflect.get(catalog, "find") as (id: string) => unknown).call(catalog, "s59999");
    }
  })();
  await Promise.all([refreshing, reader]);
  assert.notEqual(found, undefined, "a find during the index read the refresh's rows");
});
