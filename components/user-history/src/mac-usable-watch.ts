import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FEED_FRESH_MS, PRESSURE_FEED, groupOf } from "../../prime-relay/host-stats.ts";
import type { AgentQueueReading, IdleEvictionMinutes, MemoryGroupId } from "./shared/types.ts";

/**
 * The Mac usable watch: once a minute the chat service appends one line to `<dataDir>/mac-usable/<local date>.jsonl` with the Mac's usability
 * from ops guy's pressure feed (memory pressure level, swapouts a second, kernel_task CPU) and the harness numbers behind it: the Prime workers'
 * memory footprint and the top workers by it with their chat tree, the chat trees by footprint, the live and working sessions, what idle
 * sessions still hold, and the Mac-wide turn queue. The owner (10-14 09:15Z): "look it's you and ops guys responsibility that this machine is
 * usable", so a minute is judged on the Mac being usable (`USABLE`), and the worker footprint is a detail with no target (c67, the VP's ask of
 * 10-14 20:2xZ). The Whole system duty (scripts/duties/whole-system.ts) reads these lines.
 */

const GB = 1024 ** 3;
const MINUTE = 60_000;
/**
 * A usable minute, from ops guy's feed: the kernel's pressure level under critical (4), swapouts under 6,000 a second, and kernel_task under
 * one core. 6,000 is the swapout rate at which 18 feed reads at 10:59-11:02Z on
 * 10-14 said warn while kernel_task paged at 168% to 256% of a core with 6,210 to 22,956 swapouts a second. The same reads set kernel_task's
 * line at one core; at 20:23Z on 10-14, with the Mac usable by the VP's read, it ran at 17.7%.
 * A kernel_task minute at 0 swapouts is the memory compressor (r 0.93 with compressions a second, 02:56-02:59Z on 10-18), and the owner feels it:
 * across 539 probes at 02:45-03:10Z on 10-18, a /usr/bin/true spawn took a median 10.6 ms (p90 52 ms) at kernel_task 100% or more against
 * 3.6 ms (p90 18 ms) under it.
 */
export const USABLE = { pressureLevel: 4, swapoutsPerS: 6000, kernelTaskPct: 100 } as const;
/** One feed reading: the kernel's pressure level (1 normal, 2 warn, 4 critical), swapouts a second, and kernel_task CPU in % of a core. */
export interface UsableReading { pressureLevel: number; swapoutsPerS: number; kernelTaskPct: number;
  /** The feed's FEED_OWNERS largest owners by footprint, so a minute names the processes behind it; absent when the feed has none. */
  owners?: FeedOwner[];
  /** Every feed owner summed by Settings > Hosts' groups (components/prime-relay/host-stats.ts), in GB; absent on lines written before 10-18 01:40Z. */
  groups?: Partial<Record<MemoryGroupId, number>> }
/** One feed owner: `chat:<root>`, `pm2:<app>`, `browser:<name>` or `other:<name>`, its label and its footprint. */
export interface FeedOwner { owner: string; label: string; gb: number }
/** Owners kept a minute: the feed lists about 50, and the largest 8 held 41 of its 57 GB at 08:52Z on 10-15. */
export const FEED_OWNERS = 8;
export type UsableMiss = "pressure" | "swapouts" | "kernel_task";

/** The feed reading in `value`, or null when it is not schema v1, is older than FEED_FRESH_MS at `now`, or lacks a number. */
export function parseFeed(value: unknown, now: number): UsableReading | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.ts !== "string" || !(now - Date.parse(value.ts) < FEED_FRESH_MS)) return null;
  const { pressure_level: pressureLevel, swapouts_per_s: swapoutsPerS, kernel_task_cpu_pct: kernelTaskPct } = value;
  if (typeof pressureLevel !== "number" || typeof swapoutsPerS !== "number" || typeof kernelTaskPct !== "number") return null;
  const all = Array.isArray(value.owners) ? value.owners.flatMap(item => isRecord(item) && typeof item.owner === "string" && typeof item.mem_gb === "number"
    ? [{ owner: item.owner, label: typeof item.label === "string" ? item.label : item.owner, gb: item.mem_gb }] : []).sort((a, b) => b.gb - a.gb) : [];
  const owners = all.slice(0, FEED_OWNERS);
  const groups: Partial<Record<MemoryGroupId, number>> = {};
  for (const owner of all) groups[groupOf(owner.owner)] = (groups[groupOf(owner.owner)] ?? 0) + owner.gb;
  const wired = isRecord(value.mem_gb) ? value.mem_gb.wired : undefined;
  if (typeof wired === "number") groups.system = (groups.system ?? 0) + wired;
  for (const id of Object.keys(groups) as MemoryGroupId[]) groups[id] = round(groups[id]!);
  return { pressureLevel, swapoutsPerS, kernelTaskPct, ...owners.length ? { owners } : {}, ...all.length ? { groups } : {} };
}
export const readPressureFeed = async (now: number, path = PRESSURE_FEED): Promise<UsableReading | null> =>
  parseFeed(await readFile(path, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null), now);

/** What makes a reading's minute unusable, in USABLE's order; empty when the Mac is usable. */
export function unusable(reading: UsableReading): UsableMiss[] {
  const missed: UsableMiss[] = [];
  if (reading.pressureLevel >= USABLE.pressureLevel) missed.push("pressure");
  if (reading.swapoutsPerS >= USABLE.swapoutsPerS) missed.push("swapouts");
  if (reading.kernelTaskPct >= USABLE.kernelTaskPct) missed.push("kernel_task");
  return missed;
}

/** One worker process tree: its pid, its footprint, and the chat tree with the most sessions on it, by root session id and name. */
export interface WorkerLine { pid: number; gb: number; sessions: number; root: string; tree: string }
/** A chat tree and how many of its sessions a count holds. */
export interface TreeCount { root: string; tree: string; count: number }
export interface QueueLine {
  working: number; queued: number;
  /** How long the oldest queued turn has waited, and its chat tree. */
  oldestWaitS: number; oldestTree: string | null;
}
export interface WatchLine {
  at: string;
  /** ops guy's feed this minute; null when it was stale or unreadable, absent on lines written before the watch read it. */
  usable?: UsableReading | null;
  workers: number; workerGb: number; top: WorkerLine[];
  /** The live chat roots; absent on lines written before it was counted. */
  chatsLive?: number;
  live: number; working: number;
  queue: QueueLine | null;
  /** The chat trees with the largest footprint, kernel subtrees plus orphans, at most 5; absent on older lines. */
  trees?: TreeLine[];
  /** What resident sessions idle past the idle window still hold (`sleepingLine`); absent on older lines and with idle eviction off. */
  sleeping?: SleepingLine;
  /** The chat service's own resident memory; absent on older lines. */
  serviceGb?: number;
  /** Context only, from sysctl: swap in use and kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical). */
  mac: { swapGb: number | null; pressureLevel: number | null };
  /** CPU this sample cost: the service's own work plus the footprint helper's. */
  cpuMs: number;
}

/**
 * The memory of resident sessions with no turn that sat quiet past the daemon's idleEvictionMinutes plus SLEEP_SLACK_MS: each worker tree whose
 * every resident session is such a session, and the kernel of such a session in a worker that still works, with the chat trees holding the most.
 * The idle unload stops these sessions, so the owner's c92 target for it is near 0; at 23:45Z on 10-17, 18 of 23 workers held only sleeping
 * sessions, 6.5 GB with their kernels.
 */
export interface SleepingLine { gb: number; workers: number; kernels: number; trees: { root: string; tree: string; gb: number }[] }
/** One minute for the unload's sweep and one for the catalog's list refresh, as the idle-unload clean room allows. */
export const SLEEP_SLACK_MS = 2 * MINUTE;

/** The daemon row fields the watch reads, parsed at the boundary from the catalog's raw rows. */
interface Row { id: string; parent: string | undefined; name: string | undefined; live: boolean; hosted: boolean; working: boolean; active: boolean; lastAt: number; worker: number | undefined }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseRow(value: unknown): Row | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  return { id: value.sessionId, parent: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
    name: typeof value.sessionName === "string" && value.sessionName ? value.sessionName : undefined, live: value.lifecycle === "live" && typeof value.activeSessionId === "string",
    hosted: value.lifecycle === "live" && typeof value.workerPid === "number",
    working: value.activity === "working", active: value.isSessionActive === true, lastAt: typeof value.lastActivityAt === "string" ? Date.parse(value.lastActivityAt) : NaN,
    worker: typeof value.workerPid === "number" ? value.workerPid : undefined };
}

/** What the footprint helper (src/worker-footprint.py) prints. */
export interface Footprints { workers: Record<string, { pids: number; bytes: number; own?: number }>; kernels?: RawKernel[]; orphans?: RawOrphan[];
  swap_used_bytes: number | null; pressure_level: number | null; cpu_s: number }
/** One process the helper names: its footprint, its start time in epoch seconds (null when unreadable) and its command's first 200 characters. */
export interface RawProcess { pid: number; bytes: number; started: number | null; command: string }
/** A `python -m rlm.repl` kernel with the root and session its RLM_HARNESS_STATE_DIR names, its subtree, and its largest descendant that is no Prime process. */
export interface RawKernel { pid: number; root: string; session: string; pids: number; bytes: number; biggest: RawProcess | null }
/** A process with RLM_HARNESS_STATE_DIR under no kernel and no Prime process (a deleted job's nohup'd runner), with the root and session the path names. */
export interface RawOrphan extends RawProcess { root: string; session: string }
/** A chat tree's footprint (its kernels' subtrees and its orphans) and its largest process that is no Prime process, `started` kept to catch pid reuse. */
export interface TreeLine { root: string; tree: string; gb: number; biggest: { pid: number; gb: number; started: number | null; command: string } | null }
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

/** Each row's chat tree: its top ancestor among the rows, by id and name (`title` first, then the row's name, then the short id). */
function treeOf(rows: ReadonlyMap<string, Row>, title: (id: string) => string | null): (row: Row) => { root: string; tree: string } {
  const memo = new Map<string, { root: string; tree: string }>();
  return function find(row: Row): { root: string; tree: string } {
    const known = memo.get(row.id);
    if (known) return known;
    const parent = row.parent !== undefined && row.parent !== row.id ? rows.get(row.parent) : undefined;
    memo.set(row.id, { root: row.id, tree: title(row.id) ?? row.name ?? row.id.slice(0, 8) });
    const found = parent ? find(parent) : memo.get(row.id)!;
    memo.set(row.id, found);
    return found;
  };
}

function topTrees(rows: readonly Row[], tree: (row: Row) => { root: string; tree: string }, limit = 3): TreeCount[] {
  const counts = new Map<string, TreeCount>();
  for (const row of rows) {
    const { root, tree: name } = tree(row);
    const entry = counts.get(root) ?? { root, tree: name, count: 0 };
    entry.count++;
    counts.set(root, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * One watch line from the daemon's rows, the footprint helper's answer and the queue. `chats` are the chat ids, left out of `finished`;
 * `title` names a chat tree's root.
 */
export function watchLine(input: { now: number; rows: readonly unknown[]; footprints: Footprints; queue: QueueReading | null; chats: ReadonlySet<string>;
  title: (id: string) => string | null; cpuMs: number; usable?: UsableReading | null; idleMs?: number | null }): WatchLine {
  const rows = input.rows.map(parseRow).filter((row): row is Row => row !== null);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tree = treeOf(byId, input.title);
  const live = rows.filter(row => row.live);
  const working = live.filter(row => row.working);
  const top = Object.entries(input.footprints.workers).map(([pid, tree_]) => ({ pid: Number(pid), bytes: tree_.bytes }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 5).map(({ pid, bytes }): WorkerLine => {
      const on = live.filter(row => row.worker === pid);
      const lead = topTrees(on, tree, 1)[0];
      return { pid, gb: round(bytes / GB), sessions: on.length, root: lead?.root ?? "", tree: lead?.tree ?? "" };
    });
  const queue = input.queue && queueLine(input.queue, input.now, id => {
    const row = byId.get(id);
    return row ? tree(row).tree : input.title(id) ?? id.slice(0, 8);
  });
  const chatsLive = live.filter(row => input.chats.has(row.id)).length;
  const owner = (session: string, root: string): { root: string; tree: string } => {
    const row = byId.get(session) ?? byId.get(root);
    if (row) return tree(row);
    const id = root || session;
    return { root: id, tree: input.title(id) ?? id.slice(0, 8) };
  };
  return {
    at: new Date(input.now).toISOString(),
    usable: input.usable ?? null, chatsLive,
    workers: Object.keys(input.footprints.workers).length,
    workerGb: round(Object.values(input.footprints.workers).reduce((sum, worker) => sum + worker.bytes, 0) / GB),
    top, live: live.length, working: working.length,
    queue,
    trees: treeLines(input.footprints, owner).slice(0, 5),
    ...typeof input.idleMs === "number" ? { sleeping: sleepingLine(live, byId, input.footprints, tree, input.now, input.idleMs) } : {},
    mac: { swapGb: input.footprints.swap_used_bytes === null ? null : round(input.footprints.swap_used_bytes / GB, 1), pressureLevel: input.footprints.pressure_level },
    cpuMs: Math.round(input.cpuMs + input.footprints.cpu_s * 1000),
  };
}

/**
 * A session with a session at work below it waits on that work, and the idle unload keeps it (src/idle-unload.ts `busyAncestors`), so it is
 * not counted as sleeping: from 03:49Z on 10-18 'us-metal02 setup', quiet 13 to 17 min while its job metal02-ci-slice worked, read as 0.04 GB
 * of the sleeping total that the unload could not stop.
 */
function waitingOnWork(live: readonly Row[], byId: ReadonlyMap<string, Row>): Set<string> {
  const waiting = new Set<string>();
  for (const row of live) {
    if (!row.working && !row.active) continue;
    for (let up = row.parent; up !== undefined && up !== row.id && !waiting.has(up); up = byId.get(up)?.parent) waiting.add(up);
  }
  return waiting;
}

function sleepingLine(live: readonly Row[], byId: ReadonlyMap<string, Row>, footprints: Footprints, tree: (row: Row) => { root: string; tree: string }, now: number, idleMs: number): SleepingLine {
  const waiting = waitingOnWork(live, byId);
  const asleep = new Map(live.filter(row => !row.working && !waiting.has(row.id) && now - row.lastAt > idleMs + SLEEP_SLACK_MS).map(row => [row.id, row] as const));
  const trees = new Map<string, { root: string; tree: string; bytes: number }>();
  const add = (row: Row, bytes: number) => {
    const found = tree(row);
    const entry = trees.get(found.root) ?? { ...found, bytes: 0 };
    entry.bytes += bytes;
    trees.set(found.root, entry);
  };
  let workers = 0, kernels = 0;
  const whole = new Set<number>();
  for (const [pid, worker] of Object.entries(footprints.workers)) {
    const on = live.filter(row => row.worker === Number(pid));
    if (!on.length || !on.every(row => asleep.has(row.id))) continue;
    whole.add(Number(pid));
    workers++;
    add(on[0]!, worker.bytes);
  }
  for (const kernel of footprints.kernels ?? []) {
    const row = asleep.get(kernel.session);
    if (!row || (row.worker !== undefined && whole.has(row.worker))) continue;
    kernels++;
    add(row, kernel.bytes);
  }
  const sorted = [...trees.values()].sort((a, b) => b.bytes - a.bytes);
  return { gb: round(sorted.reduce((sum, entry) => sum + entry.bytes, 0) / GB), workers, kernels,
    trees: sorted.slice(0, 3).map(({ root, tree: name, bytes }) => ({ root, tree: name, gb: round(bytes / GB) })) };
}

/** Each chat tree's footprint from the helper's kernels and orphans, largest first; `owner` maps a session and the root its env names to the chat tree. */
function treeLines(footprints: Footprints, owner: (session: string, root: string) => { root: string; tree: string }): TreeLine[] {
  const trees = new Map<string, { root: string; tree: string; bytes: number; biggest: RawProcess | null }>();
  const add = (session: string, root: string, bytes: number, biggest: RawProcess | null) => {
    const found = owner(session, root);
    const entry = trees.get(found.root) ?? { ...found, bytes: 0, biggest: null };
    entry.bytes += bytes;
    if (biggest && (!entry.biggest || biggest.bytes > entry.biggest.bytes)) entry.biggest = biggest;
    trees.set(found.root, entry);
  };
  for (const kernel of footprints.kernels ?? []) add(kernel.session, kernel.root, kernel.bytes, kernel.biggest);
  for (const orphan of footprints.orphans ?? []) add(orphan.session, orphan.root, orphan.bytes, orphan);
  return [...trees.values()].sort((a, b) => b.bytes - a.bytes).map(({ root, tree, bytes, biggest }) => ({ root, tree, gb: round(bytes / GB),
    biggest: biggest && { pid: biggest.pid, gb: round(biggest.bytes / GB), started: biggest.started, command: biggest.command } }));
}

/** The queue reading the watch needs. */
export type QueueReading = Pick<AgentQueueReading, "working" | "queued">;
function queueLine(reading: QueueReading, now: number, treeName: (id: string) => string): QueueLine {
  const oldest = reading.queued.reduce<(typeof reading.queued)[number] | undefined>((first, entry) => !first || entry.since < first.since ? entry : first, undefined);
  return { working: reading.working.length, queued: reading.queued.length,
    oldestWaitS: oldest ? Math.max(0, Math.round((now - oldest.since) / 1000)) : 0, oldestTree: oldest ? treeName(oldest.tree) : null };
}

const pad = (value: number): string => String(value).padStart(2, "0");
/** The watch file of the local day `at` falls in: one file per day, so a day's lines rotate out by name. */
export const watchFile = (dataDir: string, at: number): string => {
  const day = new Date(at);
  return join(dataDir, "mac-usable", `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.jsonl`);
};

/** Every watch line from `since` to `now`, oldest first, from the day files that cover the span; a missing file or a bad line is skipped. */
export async function readWatch(dataDir: string, since: number, now: number): Promise<WatchLine[]> {
  const files = new Set<string>();
  for (let at = since; at < now + 24 * 60 * MINUTE; at += 24 * 60 * MINUTE) files.add(watchFile(dataDir, Math.min(at, now)));
  const lines: WatchLine[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as WatchLine;
        const at = Date.parse(line.at);
        if (at >= since && at <= now) lines.push(line);
      } catch { continue; }
    }
  }
  return lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const HELPER = join(import.meta.dirname, "worker-footprint.py");
function runHelper(args: readonly string[], input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/python3", ["-B", HELPER, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as unknown); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(input);
  });
}
/** Runs the footprint helper with the worker pids on stdin. */
export const readFootprints = async (pids: readonly number[]): Promise<Footprints> => await runHelper([], pids.join("\n") + "\n") as Footprints;
export interface WatchSource {
  dataDir: string;
  /** The daemon's raw session rows the catalog holds now; none before its first full list. */
  rows: () => readonly unknown[];
  chats: () => Promise<ReadonlySet<string>>;
  title: (id: string) => string | null;
  /** The Mac-wide turn queue, from the service's shared pi-pool read. */
  queue: () => Promise<QueueReading>;
  log: (line: string) => void;
  footprints?: typeof readFootprints;
  now?: () => number;
  /** The pressure feed's reading at `now`; absent, `readPressureFeed`. */
  feed?: (now: number) => Promise<UsableReading | null>;
  /** The daemon's idleEvictionMinutes, for `sleeping`; absent, the line has none. */
  idleMinutes?: () => IdleEvictionMinutes;
}

/** Takes one sample and appends its line; null when the catalog holds no rows yet. */
export async function sample(source: WatchSource): Promise<WatchLine | null> {
  const now = source.now ?? Date.now;
  const started = process.cpuUsage();
  const rows = source.rows();
  if (!rows.length) return null;
  const pids = [...new Set(rows.map(parseRow).flatMap(row => row?.hosted && row.worker !== undefined ? [row.worker] : []))];
  let own = process.cpuUsage(started);
  const at = now();
  const [footprints, queue, chats, usable] = await Promise.all([(source.footprints ?? readFootprints)(pids), source.queue().catch(() => null), source.chats(),
    (source.feed ?? readPressureFeed)(at)]);
  const resumed = process.cpuUsage();
  const idle = source.idleMinutes?.();
  const line = { ...watchLine({ now: at, rows, footprints, queue, chats, title: source.title, cpuMs: 0, usable,
    ...idle === undefined ? {} : { idleMs: idle === "off" ? null : idle * MINUTE } }), serviceGb: round(process.memoryUsage().rss / GB) };
  const after = process.cpuUsage(resumed);
  own = { user: own.user + after.user, system: own.system + after.system };
  const measured = { ...line, cpuMs: line.cpuMs + Math.round((own.user + own.system) / 1000) };
  const file = watchFile(source.dataDir, now());
  await mkdir(join(source.dataDir, "mac-usable"), { recursive: true });
  await appendFile(file, JSON.stringify(measured) + "\n");
  return measured;
}

/** Samples at start, then every `firstMs` until the catalog holds rows and the first line lands, then once a minute until the returned stop is called; a sample still running when the next tick comes skips that tick. */
export function startMacUsableWatch(source: WatchSource, everyMs = MINUTE, firstMs = 5_000): () => void {
  let running = false;
  let landed = false;
  const tick = () => {
    if (running) return;
    running = true;
    void sample(source).then(line => { if (line) landed = true; })
      .catch(error => source.log(`mac usable watch: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  const timer = setInterval(tick, everyMs);
  const first = setInterval(() => { if (landed) clearInterval(first); else tick(); }, firstMs);
  timer.unref();
  first.unref();
  tick();
  return () => { clearInterval(timer); clearInterval(first); };
}
