// Guards the 11-04 owner ask to cut the chat's main thread ("F*UCKING WATCH THIS"): the live chat's catalog ran about 50 projections a minute at
// about 210 ms of own code each, and each walked all 4,500 listed rows to check, sort and index them while a roster update changed a few.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { RosterUpdate } from "../src/session-peer.ts";
import type { ChatBoard, ThreadLabels } from "../src/shared/types.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

type World = {
  rows: Map<string, SessionSummary>; marks: Record<string, { entryId: string; timestamp: number }>; labels: Record<string, ThreadLabels>;
  chats: Set<string>; archived: Set<string>; boards: Map<string, ChatBoard>;
};
const START = Date.parse("2026-11-04T06:00:00Z");

/** A catalog over `world`, whose daemon lists `world.rows`; `roster` lays one roster update over its copy the way the daemon's stream does. */
function catalogOf(t: TestContext, world: World): { catalog: Catalog; roster: (update: RosterUpdate) => Promise<void> } {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: structuredClone(world.marks) }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: structuredClone(world.labels) }));
  const empty = { children: [], board: null, roots: [], messages: [] };
  const chats = { ids: async () => new Set(world.chats), checkIns: async () => new Map(), archivedIds: async () => new Set(world.archived),
    links: async (id: string) => world.chats.has(id) ? { ...empty, board: world.boards.get(id) ?? null } : empty };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string; all?: boolean }) => command.type !== "list" ? { success: true, data: { jobs: [] } }
    : { success: true, data: { sessions: [...world.rows.values()].filter(row => command.all || row.activeSessionId !== undefined) } });
  Object.defineProperty(catalog.client as unknown as Record<string, unknown>, "isConnected", { get: () => connected });
  const internals = catalog as unknown as { peer: { onRoster(update: RosterUpdate): void }; apply(): Promise<void> };
  return { catalog, roster: async update => { internals.peer.onRoster(update); await internals.apply(); } };
}

async function worldOf(t: TestContext, size: number): Promise<{ world: World; dir: string; row: (n: number, fields?: Partial<SessionSummary>) => SessionSummary }> {
  const dir = await mkdtemp(join(tmpdir(), "catalog-incremental-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = (n: number, fields: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionFile: join(dir, `s${n}.jsonl`), sessionName: `thread ${n}`,
    messageCount: 3, lastActivityAt: new Date(START - n * 1000).toISOString(), ...fields }) as SessionSummary;
  const world: World = { rows: new Map(), marks: {}, labels: {}, chats: new Set(), archived: new Set(), boards: new Map() };
  for (let n = 0; n < size; n++) { await writeFile(join(dir, `s${n}.jsonl`), ""); world.rows.set(`s${n}`, row(n)); }
  return { world, dir, row };
}

test("a roster update that changes one row looks at that row alone, not at every listed row", async (t: TestContext) => {
  const { world, row } = await worldOf(t, 300);
  world.rows.set("s5", row(5, { activeSessionId: "a-s5" }));
  const { catalog, roster } = catalogOf(t, world);
  await catalog.refresh();
  assert.equal((await catalog.event()).sessions.length, 300);
  // The row loop asks each row it looks at for its box: the count of those asks is the count of rows it walked.
  const hostOf = t.mock.method(catalog, "hostOf");
  const walked = async (): Promise<number> => {
    catalog.title("s0");
    const before = hostOf.mock.callCount();
    await catalog.event();
    return hostOf.mock.callCount() - before;
  };
  assert.ok(await walked() <= 1, "a projection with no change walks no row");
  await roster({ changed: [{ agentId: "s5", status: "running", summary: { ...row(5, { activeSessionId: "a-s5", sessionName: "renamed" }) } }] });
  const after = await walked();
  assert.ok(after <= 2, `a one-row change walked ${after} of 300 rows`);
  assert.equal((await catalog.event()).sessions.find(entry => entry.id === "s5")?.name, "renamed");
});

/** A small seeded generator, so a failing sequence repeats. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2 ** 31; return state / 2 ** 31; };
}

test("the kept rows come out exactly as a projection that builds every row, over a sequence of roster and input changes", async (t: TestContext) => {
  const { world, dir, row } = await worldOf(t, 120);
  world.chats.add("s3");
  world.chats.add("s40");
  const board = (rev: number, owners: number[]): ChatBoard => ({ v: 2, rev, updatedAt: new Date(START + rev).toISOString(), todos: [],
    plan: owners.map((owner, at) => ({ id: `p${at}`, text: "step", status: "doing", job: `thread ${owner}`, children: [] })) });
  world.boards.set("s3", board(1, [7, 9, 11]));
  world.boards.set("s40", board(1, [9, 50]));
  const incremental = catalogOf(t, world);
  const full = catalogOf(t, world);
  full.catalog.incremental = false;
  await incremental.catalog.refresh();
  await full.catalog.refresh();
  const pick = random(7);
  const any = (size: number) => Math.floor(pick() * size);
  let next = 120;
  let children = 0;
  let walkedIncremental = 0;
  let walkedFull = 0;
  for (let step = 0; step < 80; step++) {
    const top = [...world.rows.values()].filter(entry => !entry.parentSessionId);
    const target = top[any(top.length)]!;
    const n = Number(target.sessionId.slice(1));
    const kind = any(11);
    let update: RosterUpdate | undefined;
    const live = (fields: Partial<SessionSummary>): SessionSummary => ({ ...target, activeSessionId: `a-${target.sessionId}`, ...fields });
    if (kind === 0) update = { changed: [{ agentId: target.sessionId, summary: live({ sessionName: `renamed ${step}` }) }] };
    else if (kind === 1) update = { changed: [{ agentId: target.sessionId, status: "running", summary: live({ lastActivityAt: new Date(START + step * 5000).toISOString() }) }] };
    else if (kind === 2) update = { changed: [{ agentId: target.sessionId, status: "idle", summary: live({}) }] };
    else if (kind === 3) {
      const id = next++;
      await writeFile(join(dir, `s${id}.jsonl`), "");
      update = { changed: [{ agentId: `s${id}`, status: "idle", summary: row(id, { activeSessionId: `a-s${id}`, lastActivityAt: new Date(START - any(200) * 1000).toISOString() }) }] };
    } else if (kind === 4) {
      const child = `c${children++}`;
      const parentPath = target.sessionFile;
      update = { changed: [{ agentId: `${parentPath}#${child}`, status: pick() < 0.6 ? "running" : "idle", summary: { sessionId: `k-${child}`, cwd: "/tmp",
        sessionFile: join(dir, `k-${child}.jsonl`), sessionName: `job ${child}`, runtimeKind: "subagent", rlmChildId: child, parentSessionId: target.sessionId,
        parentSessionPath: parentPath, activeSessionId: `a-k-${child}`, messageCount: 2, usage: { cost: 0.1 + any(10) / 7 },
        lastActivityAt: new Date(START + step * 7000).toISOString() } as unknown as SessionSummary }] };
    } else if (kind === 5) world.marks[target.sessionId] = { entryId: `e${step}`, timestamp: START + any(100) * 1000 };
    else if (kind === 6) world.labels[target.sessionId] = { tags: [`tag${any(3)}`], priority: any(3) } as ThreadLabels;
    else if (kind === 7) { if (world.chats.has(target.sessionId)) world.chats.delete(target.sessionId); else world.chats.add(target.sessionId); }
    else if (kind === 8) { if (world.archived.has(target.sessionId)) world.archived.delete(target.sessionId); else world.archived.add(target.sessionId); }
    else if (kind === 9) world.boards.set("s3", board(step + 2, [any(next), any(next), n]));
    else { const held = pick() < 0.5 ? "archived" : "active"; for (const catalog of [incremental.catalog, full.catalog]) catalog.holdLifecycle(target.sessionId, held); }
    if (update) for (const entry of update.changed ?? []) world.rows.set(entry.summary.sessionId, { ...world.rows.get(entry.summary.sessionId), ...entry.summary } as SessionSummary);
    for (const side of [incremental, full]) { if (update) await side.roster(structuredClone(update)); else await (side.catalog as unknown as { apply(): Promise<void> }).apply(); }
    const left = (await incremental.catalog.event()).sessions;
    walkedIncremental += incremental.catalog.rowsWalked;
    const right = (await full.catalog.event()).sessions;
    walkedFull += full.catalog.rowsWalked;
    assert.deepEqual(left, right, `step ${step} (change ${kind} on ${target.sessionId})`);
  }
  assert.ok(walkedIncremental * 5 < walkedFull, `the kept rows walked ${walkedIncremental} rows against ${walkedFull}`);
});
