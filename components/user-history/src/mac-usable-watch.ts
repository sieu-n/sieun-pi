import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CPU_SIDES, type CpuSides, FEED_FRESH_MS, PRESSURE_FEED, groupOf, linuxUsable, type LinuxUsable, type SchedstatMark, schedstatMark, seedSchedstat } from "../../prime-relay/host-stats.ts";
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
export type UsableMiss = "pressure" | "swapouts" | "kernel_task" | "cpu";

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

/**
 * A Linux box's usable minute, from its own kernel: memory full stall (avg10) under 70%, the mark at which Android lmkd's default
 * psi_complete_stall_ms (700 ms of a 1 s window) reads critical, as macOS's level 4 does (host-stats.ts parsePsi uses the same mark), and
 * under one runnable task a core on the CPUs the harness may run on over the sample window (host-stats.ts `runnablePerCore`), where those
 * CPUs are saturated by definition. The swap-out rate is kept as context with no mark: the Mac's 6,000 a second was measured in 16 KiB macOS
 * pages, and no Linux measurement backs a number yet.
 */
export const LINUX_USABLE = { memFullAvg10: 70, runnablePerCore: 1 } as const;
/** One box's reading: ops guy's feed on the Mac, the kernel's own numbers on Linux. */
export type HostUsable = UsableReading | LinuxUsable;
export const isLinuxReading = (reading: HostUsable): reading is LinuxUsable => (reading as { kind?: unknown }).kind === "linux";

/** What makes a reading's minute unusable, in USABLE's (or LINUX_USABLE's) order; empty when the box is usable. */
export function unusable(reading: HostUsable): UsableMiss[] {
  const missed: UsableMiss[] = [];
  if (isLinuxReading(reading)) {
    if (reading.memFullAvg10 >= LINUX_USABLE.memFullAvg10) missed.push("pressure");
    if (reading.runnablePerCore >= LINUX_USABLE.runnablePerCore) missed.push("cpu");
    return missed;
  }
  if (reading.pressureLevel >= USABLE.pressureLevel) missed.push("pressure");
  if (reading.swapoutsPerS >= USABLE.swapoutsPerS) missed.push("swapouts");
  if (reading.kernelTaskPct >= USABLE.kernelTaskPct) missed.push("kernel_task");
  return missed;
}

/** This box's reading now: ops guy's feed on macOS, the kernel's pressure, swap and load on Linux. */
export const readUsable = async (now: number): Promise<HostUsable | null> => process.platform === "darwin" ? await readPressureFeed(now) : await linuxUsable(now);

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/**
 * A Linux reading checked at the edge, from a relay's answer or a watch line on disk: every stall, rate and runnablePerCore a finite number of
 * 0 or more and allowedCpus a whole number above 0. Null otherwise, so the box reads unknown. A cpuCores without every side a count of 0 or
 * more is dropped, so that minute's cause reads unknown.
 */
export function parseLinuxReading(reading: unknown): LinuxUsable | null {
  if (!isRecord(reading) || reading.kind !== "linux") return null;
  const { memSomeAvg10, memFullAvg10, cpuSomeAvg10, swapoutsPerS, runnablePerCore, allowedCpus } = reading;
  if (!count(memSomeAvg10) || !count(memFullAvg10) || !count(cpuSomeAvg10) || !count(runnablePerCore) || !(Number.isInteger(allowedCpus) && (allowedCpus as number) > 0) ||
    (swapoutsPerS !== null && !count(swapoutsPerS))) return null;
  const sides = reading.cpuCores;
  const cpuCores = isRecord(sides) && CPU_SIDES.every(side => count(sides[side])) ? Object.fromEntries(CPU_SIDES.map(side => [side, sides[side]])) as CpuSides : undefined;
  return { kind: "linux", memSomeAvg10, memFullAvg10, cpuSomeAvg10, swapoutsPerS, runnablePerCore, allowedCpus: allowedCpus as number, ...cpuCores ? { cpuCores } : {} };
}

/** Another box's reading as its relay sent it (host-stats.ts `usableRaw`), checked at the edge; null when absent or malformed. */
export function parseUsableRaw(value: unknown, now: number): HostUsable | null {
  if (!isRecord(value)) return null;
  if (value.platform === "darwin") return parseFeed(value.feed, now);
  return value.platform === "linux" ? parseLinuxReading(value.reading) : null;
}

/**
 * One worker process tree: its pid, its footprint, and the chat tree with the most sessions on it, by root session id and name. `workGb` is the
 * part its sessions' work holds (`workBytes`); absent on lines written before 10-18 07:5xZ.
 */
export interface WorkerLine { pid: number; gb: number; sessions: number; root: string; tree: string; workGb?: number }
/** A chat tree and how many of its sessions a count holds. */
export interface TreeCount { root: string; tree: string; count: number }
export interface QueueLine {
  working: number; queued: number;
  /** How long the oldest queued turn has waited, and its chat tree. */
  oldestWaitS: number; oldestTree: string | null;
  /**
   * pi-pool's admission inputs, so d7 can tell a turn its tree's cap holds from one a free slot left waiting (`admit_pass` in pool/turns.py):
   * both limits as pi-pool merges its defaults and config.json, the turns that hold a slot of their own (every one but a borrow), and each
   * tree with a queued turn. Absent on lines written before 10-18 05:1xZ, when metal-management's turns at its 8 of 8 read as free-slot waits.
   */
  workingMax?: number; treeWorkingMax?: number; slots?: number; waiting?: WaitingTree[];
}
/** A chat tree with a queued turn: its longest wait and the slots its working turns hold against tree_working_max. */
export interface WaitingTree { tree: string; oldestWaitS: number; slots: number }
/**
 * Another box's numbers in a watch line, read through its relay (POST /v1/watch): its usability reading, its Prime workers and what its idle
 * sessions hold. From 04:20Z on 10-18 the chat ran on us-metal02, and its lines measured only the box, so the Mac's workers left d7's numbers.
 * `error` names a box whose relay did not answer; its numbers are then unknown, not zero.
 */
export interface HostWatchLine { name: string; usable: HostUsable | null; workers: number; workerGb: number; top: WorkerLine[]; live: number; working: number;
  sleeping?: SleepingLine; swapGb: number | null; error?: string }

export interface WatchLine {
  at: string;
  /** The box that wrote the line (hosts.json's name); absent on lines written before 10-18 04:5xZ, all of them on the Mac. */
  host?: string;
  /** This box's reading this minute: ops guy's feed on the Mac, the kernel's on Linux; null when it was stale or unreadable, absent on lines written before the watch read it. */
  usable?: HostUsable | null;
  /** Every other box in hosts.json; absent on older lines. */
  hosts?: HostWatchLine[];
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
/**
 * A `python -m rlm.repl` kernel with the root and session its RLM_HARNESS_STATE_DIR names, its subtree, the kernel process alone (`own`, absent
 * from a relay installed before 10-18 07:5xZ), and its largest descendant that is no Prime process.
 */
export interface RawKernel { pid: number; root: string; session: string; pids: number; bytes: number; own?: number; biggest: RawProcess | null }
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
  title: (id: string) => string | null; cpuMs: number; usable?: HostUsable | null; idleMs?: number | null }): WatchLine {
  const rows = input.rows.map(parseRow).filter((row): row is Row => row !== null);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tree = treeOf(byId, input.title);
  const live = rows.filter(row => row.live);
  const working = live.filter(row => row.working);
  const top = Object.entries(input.footprints.workers).map(([pid, tree_]) => ({ pid: Number(pid), bytes: tree_.bytes }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 5).map(({ pid, bytes }): WorkerLine => {
      const on = live.filter(row => row.worker === pid);
      const lead = topTrees(on, tree, 1)[0];
      return { pid, gb: round(bytes / GB), sessions: on.length, root: lead?.root ?? "", tree: lead?.tree ?? "", workGb: round(workBytes(input.footprints, byId, pid) / GB) };
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
    ...typeof input.idleMs === "number" ? { sleeping: sleepingLine(rows, live, byId, input.footprints, tree, input.now, input.idleMs) } : {},
    mac: { swapGb: input.footprints.swap_used_bytes === null ? null : round(input.footprints.swap_used_bytes / GB, 1), pressureLevel: input.footprints.pressure_level },
    cpuMs: Math.round(input.cpuMs + input.footprints.cpu_s * 1000),
  };
}

/**
 * Each session's tree clock: the latest activity of the session and of every session below it, stopped ones included, and Infinity for one
 * with a session at work below it. The idle unload keeps a session with work below it (src/idle-unload.ts `busyAncestors`), and a chat rests
 * its idle time from its jobs' last stir (chat-dormancy `childrenStirred`), so a session counts as sleeping only once its whole tree is quiet.
 * On 10-18 'us-metal02 setup', quiet 13 to 17 min from 03:49Z while its job metal02-ci-slice worked, read as 0.04 GB that the unload could
 * not stop, and the chat 'Douyin index gaps', quiet since 03:52Z, read as a whole 0.47 to 0.53 GB worker from 04:16Z while its job had
 * worked until 04:12:45Z, so its idle window ran to about 04:23Z.
 */
function treeClocks(rows: readonly Row[], byId: ReadonlyMap<string, Row>): Map<string, number> {
  const clock = new Map<string, number>();
  for (const row of rows) {
    const at = row.working || row.active ? Infinity : row.lastAt;
    if (Number.isNaN(at)) continue;
    const seen = new Set<string>();
    for (let id: string | undefined = row.id; id !== undefined && !seen.has(id); id = byId.get(id)?.parent) {
      seen.add(id);
      if ((clock.get(id) ?? -Infinity) < at) clock.set(id, at);
    }
  }
  return clock;
}

function sleepingLine(rows: readonly Row[], live: readonly Row[], byId: ReadonlyMap<string, Row>, footprints: Footprints, tree: (row: Row) => { root: string; tree: string }, now: number, idleMs: number): SleepingLine {
  const clocks = treeClocks(rows, byId);
  const asleep = new Map(live.filter(row => !row.working && now - (clocks.get(row.id) ?? row.lastAt) > idleMs + SLEEP_SLACK_MS).map(row => [row.id, row] as const));
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

/**
 * What the work of worker `pid`'s sessions holds in its tree: every command their kernels run (a kernel's subtree past the kernel process), and
 * the whole kernel of a session with a turn at work. The rest is Prime's own: the worker and the kernels of quiet sessions. At 07:30Z on 10-18
 * d7 flagged worker 852974 at 1.7 GB for one session, 1.19 GB of it the svelte-check of a release its quiet job had started with nohup, and
 * Mac worker 4111 at 3.91 GB for two, 3.6 GB of it the 'meta ads' job's kernel at work on a ClickHouse sample it held in seven copies.
 */
function workBytes(footprints: Footprints, rows: ReadonlyMap<string, Row>, pid: number): number {
  let bytes = 0;
  for (const kernel of footprints.kernels ?? []) {
    const row = rows.get(kernel.session);
    if (row?.worker !== pid) continue;
    bytes += row.working || row.active ? kernel.bytes : kernel.bytes - (kernel.own ?? kernel.bytes);
  }
  return bytes;
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
export type QueueReading = Pick<AgentQueueReading, "working" | "queued" | "workingMax" | "treeWorkingMax">;
function queueLine(reading: QueueReading, now: number, treeName: (id: string) => string): QueueLine {
  const waitS = (since: number): number => Math.max(0, Math.round((now - since) / 1000));
  const oldest = reading.queued.reduce<(typeof reading.queued)[number] | undefined>((first, entry) => !first || entry.since < first.since ? entry : first, undefined);
  const held = reading.working.filter(entry => entry.kind !== "borrow");
  const firstAsk = new Map<string, number>();
  for (const entry of reading.queued) firstAsk.set(entry.tree, Math.min(firstAsk.get(entry.tree) ?? Infinity, entry.since));
  const waiting = [...firstAsk].map(([tree, since]) => ({ tree: treeName(tree), oldestWaitS: waitS(since), slots: held.filter(entry => entry.tree === tree).length }))
    .sort((a, b) => b.oldestWaitS - a.oldestWaitS);
  return { working: reading.working.length, queued: reading.queued.length,
    oldestWaitS: oldest ? waitS(oldest.since) : 0, oldestTree: oldest ? treeName(oldest.tree) : null,
    workingMax: reading.workingMax, treeWorkingMax: reading.treeWorkingMax, slots: held.length, waiting };
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
  /** This box's reading at `now`; absent, `readUsable`. */
  feed?: (now: number) => Promise<HostUsable | null>;
  /** The daemon's idleEvictionMinutes, for `sleeping`; absent, the line has none. */
  idleMinutes?: () => IdleEvictionMinutes;
  /** This box's name in hosts.json, written on each line. */
  host?: string;
  /** Every other box: its name, the daemon rows the catalog holds for it, and a read of its relay's POST /v1/watch for those workers. */
  remotes?: () => readonly RemoteWatch[];
}
export interface RemoteWatch { name: string; rows: readonly unknown[]; read: (pids: readonly number[]) => Promise<{ usable: unknown; footprints: Footprints }> }

/** The pids of the workers that host the rows' sessions. */
const workerPids = (rows: readonly unknown[]): number[] => [...new Set(rows.map(parseRow).flatMap(row => row?.hosted && row.worker !== undefined ? [row.worker] : []))];

/** One other box's numbers from its relay, judged with this box's chat ids, titles and idle window; a failed read keeps the box with its error. */
export async function hostWatchLine(remote: RemoteWatch, input: { now: number; chats: ReadonlySet<string>; title: (id: string) => string | null; idleMs?: number | null }): Promise<HostWatchLine> {
  try {
    const answer = await remote.read(workerPids(remote.rows));
    const usable = parseUsableRaw(answer.usable, input.now);
    const line = watchLine({ now: input.now, rows: remote.rows, footprints: answer.footprints, queue: null, chats: input.chats, title: input.title, cpuMs: 0, usable,
      ...input.idleMs === undefined ? {} : { idleMs: input.idleMs } });
    return { name: remote.name, usable, workers: line.workers, workerGb: line.workerGb, top: line.top, live: line.live, working: line.working,
      ...line.sleeping ? { sleeping: line.sleeping } : {}, swapGb: line.mac.swapGb };
  } catch (error) {
    return { name: remote.name, usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
}

/** What a box's relay read says when the service stopped before it answered, or stopped with no read made. */
export const UNREAD_AT_STOP = "unread: the chat service stopped before the relay answered";
const unreadHost = (name: string): HostWatchLine => ({ name, usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, error: UNREAD_AT_STOP });

/**
 * Takes one sample and appends its line; null when the catalog holds no rows yet. Once `stopping` resolves, each relay read still out reads
 * unread and the line goes out with this box's own numbers, so a stop never drops a sample in flight. On 10-18 the Mac's relay timed out at
 * 35 s (hosts.ts relayWatch) while restarts at 10:46:55Z and 10:58:45Z stopped the service, and the 10:46:30Z and 10:58:30Z samples left no line.
 */
export async function sample(source: WatchSource, stopping?: Promise<void>): Promise<WatchLine | null> {
  const now = source.now ?? Date.now;
  const started = process.cpuUsage();
  const rows = source.rows();
  if (!rows.length) return null;
  const pids = workerPids(rows);
  let own = process.cpuUsage(started);
  const at = now();
  const idle = source.idleMinutes?.();
  const idleMs = idle === undefined ? undefined : idle === "off" ? null : idle * MINUTE;
  const chatIds = source.chats();
  const [footprints, queue, chats, usable, hosts] = await Promise.all([(source.footprints ?? readFootprints)(pids), source.queue().catch(() => null), chatIds,
    (source.feed ?? readUsable)(at),
    chatIds.then(ids => Promise.all((source.remotes?.() ?? []).map(remote => {
      const read = hostWatchLine(remote, { now: at, chats: ids, title: source.title, ...idleMs === undefined ? {} : { idleMs } });
      return stopping ? Promise.race([read, stopping.then(() => unreadHost(remote.name))]) : read;
    })))]);
  const resumed = process.cpuUsage();
  const line = { ...source.host ? { host: source.host } : {}, ...watchLine({ now: at, rows, footprints, queue, chats, title: source.title, cpuMs: 0, usable,
    ...idleMs === undefined ? {} : { idleMs } }), ...hosts.length ? { hosts } : {}, serviceGb: round(process.memoryUsage().rss / GB) };
  const after = process.cpuUsage(resumed);
  own = { user: own.user + after.user, system: own.system + after.system };
  const measured = { ...line, cpuMs: line.cpuMs + Math.round((own.user + own.system) / 1000) };
  const file = watchFile(source.dataDir, now());
  await mkdir(join(source.dataDir, "mac-usable"), { recursive: true });
  await appendFile(file, JSON.stringify(measured) + "\n");
  const mark: LastSample = { at, sched: source.feed ? null : schedstatMark() };
  const draft = `${lastSampleFile(source.dataDir)}.${process.pid}`;
  await writeFile(draft, JSON.stringify(mark) + "\n");
  await rename(draft, lastSampleFile(source.dataDir));
  return measured;
}

/** The last line this box wrote: its time, and on Linux the schedstat reading its window ended at, so the next process carries both on. */
interface LastSample { at: number; sched: SchedstatMark | null }
const lastSampleFile = (dataDir: string): string => join(dataDir, "mac-usable", "last-sample.json");
function readLastSample(dataDir: string): LastSample | null {
  try {
    const value = JSON.parse(readFileSync(lastSampleFile(dataDir), "utf8")) as Partial<LastSample>;
    return typeof value.at === "number" ? { at: value.at, sched: value.sched ?? null } : null;
  } catch { return null; }
}

/**
 * The first wall-clock half minute (hh:mm:30) after `at`. The Whole system duty counts each wall-clock minute by the line in it, so a line taken
 * at its middle still lands in it up to 29 s late. A once-a-minute interval drifted later with event-loop lag instead: across the 1,095 gaps of
 * the 10-17 and 10-18 files, 748 ran over 60 s, so the phase crept over minute marks, and the duty read 03:53Z on 10-18 as unwatched with lines
 * at 03:52:07.717Z and 03:53:08.347Z.
 */
export const nextSampleAt = (at: number): number => Math.floor((at - MINUTE / 2) / MINUTE) * MINUTE + MINUTE + MINUTE / 2;

/**
 * Samples at start, then every `firstMs` until the catalog holds rows and the first line lands, then at each `nextSampleAt` until the returned
 * stop is called; a sample still running when the next tick comes skips that tick. The start samples only fill a minute the last process left
 * without a line, and on Linux their window starts at that process's last reading (`seedSchedstat`). On 10-18 each restart line came about 10 s
 * after the service started, and its window held only the service's boot: 06:07:39Z read 1.48, 06:11:15Z 1.17, 06:15:49Z 1.43 and 06:21:27Z
 * 1.48 runnable a core against 0.6 to 0.9 for the lines around them, and 06:15:49Z was the last line of a minute whose 06:15:30Z line read 0.61.
 *
 * The stop writes the sample in flight with its relay reads still out marked unread (`sample`), then a sample of its own when the minute it
 * stops in has no line yet, so a restart leaves no wall-clock minute without a line. On 10-18 the service began to stop at about 06:00:28Z
 * and the next one listened at 06:01:28Z, so 06:00Z had none. Of the 29 minutes the 10-18 file had with no line, 27 sat within
 * 2 minutes of a service start.
 */
export function startMacUsableWatch(source: WatchSource, firstMs = 5_000): () => Promise<void> {
  const now = source.now ?? Date.now;
  const last = readLastSample(source.dataDir);
  if (last?.sched && !source.feed) seedSchedstat(last.sched);
  let lastAt = last?.at ?? null;
  let running: Promise<void> | null = null;
  let landed = false;
  let markStopping!: () => void;
  const stopping = new Promise<void>(resolve => { markStopping = resolve; });
  const written = () => lastAt !== null && Math.floor(lastAt / MINUTE) === Math.floor(now() / MINUTE);
  const startTick = () => {
    if (written() && source.rows().length) landed = true;
    else tick();
  };
  const run = () => sample(source, stopping).then(line => { if (line) { landed = true; lastAt = Date.parse(line.at); } })
    .catch(error => source.log(`mac usable watch: ${error instanceof Error ? error.message : String(error)}`));
  const tick = () => {
    if (running) return;
    running = run().finally(() => { running = null; });
  };
  let due = nextSampleAt(now());
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(() => { tick(); due = nextSampleAt(Math.max(now(), due)); arm(); }, Math.max(0, due - now()));
    timer.unref();
  };
  arm();
  const first = setInterval(() => { if (landed) clearInterval(first); else startTick(); }, firstMs);
  first.unref();
  startTick();
  return async () => {
    clearTimeout(timer);
    clearInterval(first);
    markStopping();
    await running;
    if (!written()) await run();
  };
}
