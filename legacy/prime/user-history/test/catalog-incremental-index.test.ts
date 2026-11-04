// Guards the 11-04 cut of the chat's main thread: each catalog index, about one per projection, built its maps of every box's ~12,500 rows
// again while a roster update changed a few of them (89 s of the live chat's 1,968 s run from 08:24Z, pid 2551281).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { RosterUpdate } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const START = Date.parse("2026-11-04T09:00:00Z");
/** Counts reads of each row's runtimeKind, which the index reads first of every row it looks at (`isTopLevel`). */
let kindReads = 0;
const counted = (row: SessionSummary): SessionSummary => new Proxy(row, { get(target, key, receiver) { if (key === "runtimeKind") kindReads++; return Reflect.get(target, key, receiver); } });
const top = (n: number, fields: Partial<SessionSummary> = {}): SessionSummary => counted({ sessionId: `s${n}`, cwd: "/tmp", sessionName: `thread ${n}`, messageCount: 3,
  lastActivityAt: new Date(START - n * 1000).toISOString(), ...fields } as SessionSummary);
const kid = (n: number, parent: string, fields: Partial<SessionSummary> = {}): SessionSummary => counted({ sessionId: `k${n}`, cwd: "/tmp", sessionName: `job ${n}`,
  runtimeKind: "subagent", rlmChildId: `job-${n}`, parentSessionId: parent, messageCount: 2, lastActivityAt: new Date(START - n * 500).toISOString(), ...fields } as unknown as SessionSummary);

function catalogOf(t: TestContext, rows: Map<string, SessionSummary>) {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const empty = { children: [], board: null, roots: [], messages: [] };
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), archivedIds: async () => new Set<string>(), links: async () => empty, roster: async () => {} };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string; all?: boolean }) => command.type !== "list" ? { success: true, data: { jobs: [] } }
    : { success: true, data: { sessions: [...rows.values()].filter(entry => command.all || entry.activeSessionId !== undefined) } });
  Object.defineProperty(catalog.client as unknown as Record<string, unknown>, "isConnected", { get: () => connected });
  const internals = catalog as unknown as { peer: { onRoster(update: RosterUpdate): void }; apply(): Promise<void> };
  const roster = async (update: RosterUpdate) => { internals.peer.onRoster(update); await internals.apply(); };
  return { catalog, roster };
}

test("a roster update that changes one row indexes that row, not all 12,500", async (t: TestContext) => {
  const rows = new Map<string, SessionSummary>();
  for (let n = 0; n < 6000; n++) rows.set(`s${n}`, top(n, n % 50 === 0 ? { activeSessionId: `a-s${n}` } : {}));
  for (let n = 0; n < 6500; n++) rows.set(`k${n}`, kid(n, `s${n % 6000}`, n % 40 === 0 ? { activeSessionId: `a-k${n}` } : {}));
  const { catalog, roster } = catalogOf(t, rows);
  await catalog.refresh();
  catalog.title("s0");
  const indexed = async (update: RosterUpdate): Promise<number> => {
    await roster(update);
    kindReads = 0;
    catalog.title("s0");
    return kindReads;
  };
  const one = await indexed({ changed: [{ agentId: "s50", status: "running", summary: top(50, { activeSessionId: "a-s50", summary: "working" }) }] } as RosterUpdate);
  assert.ok(one <= 10, `a one-row top-level change read ${one} rows' kind`);
  const child = await indexed({ changed: [{ agentId: "k40", status: "running", summary: kid(40, "s40", { activeSessionId: "a-k40", summary: "working" }) }] } as RosterUpdate);
  assert.ok(child <= 10, `a one-row subagent change read ${child} rows' kind`);
  assert.equal(catalog.title("s50"), "thread 50");
});

/** A small seeded generator, so a failing sequence repeats. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2 ** 31; return state / 2 ** 31; };
}

type Internals = { summaries: Map<string, SessionSummary>; childById: Map<string, SessionSummary>; childSummaries: SessionSummary[]; indexedRows: Set<SessionSummary>;
  pending: Set<string>; settle(): void; apply(): Promise<void> };
const plain = (row: SessionSummary): SessionSummary => ({ ...row });
const byId = (map: Map<string, SessionSummary>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, row]) => [id, plain(row)]);

test("the incremental index holds what a full index of the same rows holds, over random roster changes, removals and forgets", async (t: TestContext) => {
  const rows = new Map<string, SessionSummary>();
  for (let n = 0; n < 80; n++) rows.set(`s${n}`, top(n, n % 7 === 0 ? { activeSessionId: `a-s${n}` } : {}));
  for (let n = 0; n < 60; n++) rows.set(`k${n}`, kid(n, n % 3 === 0 ? `k${Math.max(0, n - 3)}` : `s${n % 80}`, n % 5 === 0 ? { activeSessionId: `a-k${n}` } : {}));
  const incremental = catalogOf(t, rows);
  const full = catalogOf(t, rows);
  full.catalog.incrementalIndex = false;
  await incremental.catalog.refresh();
  await full.catalog.refresh();
  const pick = random(11);
  const any = (size: number) => Math.floor(pick() * size);
  let tops = 80;
  let kids = 60;
  let visited = 0;
  for (let step = 0; step < 150; step++) {
    const kind = any(9);
    let update: RosterUpdate | undefined;
    let forget: string | undefined;
    if (kind === 0) { const n = any(tops); update = { changed: [{ agentId: `s${n}`, summary: top(n, { activeSessionId: `a-s${n}`, sessionName: `renamed ${step}` }) }] }; }
    else if (kind === 1) { const n = any(tops); update = { changed: [{ agentId: `s${n}`, status: "running", summary: top(n, { activeSessionId: `a-s${n}`, summary: `step ${step}` }) }] }; }
    else if (kind === 2) { const n = tops++; update = { changed: [{ agentId: `s${n}`, status: "idle", summary: top(n, { activeSessionId: `a-s${n}` }) }] }; }
    else if (kind === 3) { const n = kids++; update = { changed: [{ agentId: `k${n}`, status: "running", summary: kid(n, `s${any(tops)}`, { activeSessionId: `a-k${n}` }) }] }; }
    else if (kind === 4) { const n = any(kids); update = { changed: [{ agentId: `k${n}`, status: pick() < 0.5 ? "running" : "idle", summary: kid(n, `s${n % 80}`, { activeSessionId: `a-k${n}`, summary: `kid step ${step}` }) }] }; }
    else if (kind === 5) { const n = any(tops); update = { removed: [`a-s${n}`] }; }
    else if (kind === 6) { const n = any(kids); update = { removed: [`a-k${n}`] }; }
    else if (kind === 7) forget = `s${any(tops)}`;
    else { const n = any(tops); const m = any(kids); update = { changed: [{ agentId: `s${n}`, status: "running", summary: top(n, { activeSessionId: `a-s${n}` }) }, { agentId: `k${m}`, status: "idle", summary: kid(m, `s${n}`, { activeSessionId: `a-k${m}` }) }] }; }
    for (const side of [incremental, full]) {
      if (update) await side.roster(JSON.parse(JSON.stringify(update)) as RosterUpdate);
      if (forget) side.catalog.forget(forget);
    }
    const left = incremental.catalog as unknown as Internals;
    const right = full.catalog as unknown as Internals;
    left.settle();
    right.settle();
    visited += incremental.catalog.rowsIndexed;
    const label = `step ${step} (change ${kind})`;
    assert.deepEqual(byId(left.summaries), byId(right.summaries), `${label}: top-level rows`);
    assert.deepEqual(byId(left.childById), byId(right.childById), `${label}: subagent rows`);
    assert.deepEqual(left.childSummaries.map(plain), right.childSummaries.map(plain), `${label}: subagent list`);
    assert.deepEqual([...left.indexedRows].map(row => row.sessionId).sort(), [...right.indexedRows].map(row => row.sessionId).sort(), `${label}: indexed rows`);
    for (const id of right.pending) assert.ok(left.pending.has(id), `${label}: ${id} marked for the row stage`);
    assert.deepEqual((await incremental.catalog.event()).sessions, (await full.catalog.event()).sessions, `${label}: sessions`);
  }
  assert.ok(visited < 150 * 20, `the incremental index looked at ${visited} rows over 150 changes`);
});
