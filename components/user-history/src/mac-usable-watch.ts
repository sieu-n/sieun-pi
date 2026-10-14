import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentQueueReading } from "./shared/types.ts";

/**
 * The Mac usable watch: once a minute the chat service appends one line to `<dataDir>/mac-usable/<local date>.jsonl` with the harness numbers
 * that decide whether the Mac stays usable: the Prime workers' memory footprint and the top workers by it with their chat tree, the live, working
 * and quietly "working" sessions, the finished jobs nobody deleted, and the Mac-wide turn queue. The owner (10-14 09:16Z): "you -harness side of
 * bullshit, ops guy -app side of bullshit fixing monitoring", so the Mac's swap and memory pressure are context columns, never a target.
 * The hourly "Mac stays usable" duty (scripts/duties/mac-stays-usable.ts) reads these lines and judges each minute with `misses`.
 */

const GB = 1024 ** 3;
const MINUTE = 60_000;
/** A working session with no activity for this long counts in `idle15`; the 18:00 KST findings of 10-14 counted 96 of 129 that way. */
export const QUIET_MS = 15 * MINUTE;

/**
 * The harness target. A minute is on target when every part holds; each number's evidence is in the commit that set it.
 * `footprintGb`: 32 GB of RAM less the 26.2 GB footprint of everything that was not a Prime worker at 18:00 KST on 10-14.
 * `idleMinutes`: pi-pool's lease_s of 1,800 s takes the slot of a run with no model call for that long, and the check-in stops counting a quiet job as working after 30 min.
 * `queueWaitS`: the 99th percentile of the 4,811 slot admits pi-pool logged on 10-14 from 08:06 to 18:24 KST waited 706 s.
 */
export const TARGET = { footprintGb: 5.8, idleMinutes: 30, queueWaitS: 706 } as const;
export type TargetPart = "footprint" | "idle" | "queue";

/** One worker process tree: its pid, its footprint, and the chat tree with the most sessions on it, by root session id and name. */
export interface WorkerLine { pid: number; gb: number; sessions: number; root: string; tree: string }
/** A chat tree and how many of its sessions a count holds. */
export interface TreeCount { root: string; tree: string; count: number }
export interface QueueLine {
  working: number; queued: number;
  /** Turns the memory governor holds back, and its pressure level, when pi-pool's queue answer carries them. */
  held: number | null; pressure: string | null;
  /** How long the oldest queued turn has waited, and its chat tree. */
  oldestWaitS: number; oldestTree: string | null;
}
export interface WatchLine {
  at: string;
  workers: number; workerGb: number; top: WorkerLine[];
  live: number; working: number; idle15: number;
  /** Working sessions with no activity for over TARGET.idleMinutes, and the trees that hold the most of them. */
  idleOver: number; idleTrees: TreeCount[];
  /** Live sessions that ended their task (`taskState` needs_input) and sit idle, chats left out. */
  finished: number; finishedTrees: TreeCount[];
  queue: QueueLine | null;
  /** Context only, from sysctl: swap in use and kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical). */
  mac: { swapGb: number | null; pressureLevel: number | null };
  /** CPU this sample cost: the service's own work plus the footprint helper's. */
  cpuMs: number;
}

/** The daemon row fields the watch reads, parsed at the boundary from the catalog's raw rows. */
interface Row { id: string; parent: string | undefined; name: string | undefined; live: boolean; working: boolean; lastAt: number; worker: number | undefined; ended: boolean }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseRow(value: unknown): Row | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  return { id: value.sessionId, parent: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
    name: typeof value.sessionName === "string" && value.sessionName ? value.sessionName : undefined, live: value.lifecycle === "live",
    working: value.activity === "working", lastAt: typeof value.lastActivityAt === "string" ? Date.parse(value.lastActivityAt) : NaN,
    worker: typeof value.workerPid === "number" ? value.workerPid : undefined, ended: value.activity === "idle" && value.taskState === "needs_input" };
}

/** What the footprint helper (src/worker-footprint.py) prints. */
export interface Footprints { workers: Record<string, { pids: number; bytes: number }>; swap_used_bytes: number | null; pressure_level: number | null; cpu_s: number }

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
  title: (id: string) => string | null; cpuMs: number }): WatchLine {
  const rows = input.rows.map(parseRow).filter((row): row is Row => row !== null);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tree = treeOf(byId, input.title);
  const live = rows.filter(row => row.live);
  const working = live.filter(row => row.working);
  const quiet = (ms: number) => working.filter(row => input.now - row.lastAt > ms);
  const idleOver = quiet(TARGET.idleMinutes * MINUTE);
  const finished = live.filter(row => row.ended && !input.chats.has(row.id));
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
  return {
    at: new Date(input.now).toISOString(),
    workers: Object.keys(input.footprints.workers).length,
    workerGb: round(Object.values(input.footprints.workers).reduce((sum, worker) => sum + worker.bytes, 0) / GB),
    top, live: live.length, working: working.length, idle15: quiet(QUIET_MS).length,
    idleOver: idleOver.length, idleTrees: topTrees(idleOver, tree),
    finished: finished.length, finishedTrees: topTrees(finished, tree),
    queue,
    mac: { swapGb: input.footprints.swap_used_bytes === null ? null : round(input.footprints.swap_used_bytes / GB, 1), pressureLevel: input.footprints.pressure_level },
    cpuMs: Math.round(input.cpuMs + input.footprints.cpu_s * 1000),
  };
}

/** The queue reading the watch needs; `governor` is pi-pool's memory governor record, absent from a pi-pool without one. */
export type QueueReading = Pick<AgentQueueReading, "working" | "queued"> & { governor?: { level: string; held: number } | null };
function queueLine(reading: QueueReading, now: number, treeName: (id: string) => string): QueueLine {
  const oldest = reading.queued.reduce<(typeof reading.queued)[number] | undefined>((first, entry) => !first || entry.since < first.since ? entry : first, undefined);
  return { working: reading.working.length, queued: reading.queued.length, held: reading.governor?.held ?? null, pressure: reading.governor?.level ?? null,
    oldestWaitS: oldest ? Math.max(0, Math.round((now - oldest.since) / 1000)) : 0, oldestTree: oldest ? treeName(oldest.tree) : null };
}

/** The target parts a line misses, in TARGET's order; empty when the minute is on target. A line without a queue reading misses no queue part. */
export function misses(line: Pick<WatchLine, "workerGb" | "idleOver" | "queue">): TargetPart[] {
  const missed: TargetPart[] = [];
  if (line.workerGb > TARGET.footprintGb) missed.push("footprint");
  if (line.idleOver > 0) missed.push("idle");
  if (line.queue && line.queue.oldestWaitS > TARGET.queueWaitS) missed.push("queue");
  return missed;
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
/** Runs the footprint helper with the worker pids on stdin. */
export function readFootprints(pids: readonly number[]): Promise<Footprints> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/python3", ["-B", HELPER], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as Footprints); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(pids.join("\n") + "\n");
  });
}

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
}

/** Takes one sample and appends its line; null when the catalog holds no rows yet. */
export async function sample(source: WatchSource): Promise<WatchLine | null> {
  const now = source.now ?? Date.now;
  const started = process.cpuUsage();
  const rows = source.rows();
  if (!rows.length) return null;
  const pids = [...new Set(rows.map(parseRow).flatMap(row => row?.live && row.worker !== undefined ? [row.worker] : []))];
  let own = process.cpuUsage(started);
  const [footprints, queue, chats] = await Promise.all([(source.footprints ?? readFootprints)(pids), source.queue().catch(() => null), source.chats()]);
  const resumed = process.cpuUsage();
  const line = watchLine({ now: now(), rows, footprints, queue, chats, title: source.title, cpuMs: 0 });
  const after = process.cpuUsage(resumed);
  own = { user: own.user + after.user, system: own.system + after.system };
  const measured = { ...line, cpuMs: line.cpuMs + Math.round((own.user + own.system) / 1000) };
  const file = watchFile(source.dataDir, now());
  await mkdir(join(source.dataDir, "mac-usable"), { recursive: true });
  await appendFile(file, JSON.stringify(measured) + "\n");
  return measured;
}

/** Samples once a minute until the returned stop is called; a sample still running when the next minute comes skips that minute. */
export function startMacUsableWatch(source: WatchSource, everyMs = MINUTE): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sample(source).catch(error => source.log(`mac usable watch: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
