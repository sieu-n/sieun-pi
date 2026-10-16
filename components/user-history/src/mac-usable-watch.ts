import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { JOB_NOTICE_PREFIX } from "./shared/chat-feed.ts";
import type { AgentQueueReading } from "./shared/types.ts";

/**
 * The Mac usable watch: once a minute the chat service appends one line to `<dataDir>/mac-usable/<local date>.jsonl` with the Mac's usability
 * from ops guy's pressure feed (memory pressure level, swapouts a second, kernel_task CPU) and the harness numbers behind it: the Prime workers'
 * memory footprint and the top workers by it with their chat tree, the live, working and quietly "working" sessions (each one past
 * TARGET.idleMinutes by job, with the tool call it sits in), the finished jobs nobody deleted, and the Mac-wide turn queue. The owner (10-14
 * 09:15Z): "look it's you and ops guys responsibility that this machine is usable", so a minute is judged on the Mac being usable (`USABLE`), and the worker footprint is a detail with no target (c67, the VP's ask of 10-14 20:2xZ).
 * The hourly "Mac stays usable" duty (scripts/duties/mac-stays-usable.ts) reads these lines and judges each minute with `misses`.
 * A quiet session whose kernel moved (MOTION) since the last sample works and counts in `active`, not `idleOver`; one whose kernel stayed still
 * for HUNG_MINUTES is hung, and the watch tells its chat, then interrupts the call a sample later (`interruptHung`).
 */

const GB = 1024 ** 3;
const MINUTE = 60_000;
/** A working session with no activity for this long counts in `idle15`; the 18:00 KST findings of 10-14 counted 96 of 129 that way. */
export const QUIET_MS = 15 * MINUTE;

/**
 * The harness target. A minute is on target when every part holds; each number's evidence is in the commit that set it.
 * `idleMinutes`: pi-pool's lease_s of 1,800 s takes the slot of a run with no model call for that long, and the check-in stops counting a quiet job as working after 30 min.
 * `queueWaitS`: the 99th percentile of the 4,811 slot admits pi-pool logged on 10-14 from 08:06 to 18:24 KST waited 706 s.
 */
export const TARGET = { idleMinutes: 30, queueWaitS: 706 } as const;

/**
 * A kernel moved in a minute when its subtree's CPU changed by MOTION.cpuMs or more, a process in its subtree started or ended, or a socket of
 * its subtree moved bytes (nettop's per-socket counts). Six one-minute reads of about 30 kernels on 10-15 at 03:41 to 03:48Z: a still kernel
 * used 1.6 to 3.7 ms (5 ms over one 65 s read at 03:37Z), a kernel held in a socket read that never returns 1.6 to 2.7 ms, the smallest
 * reading of a kernel at work 17.5 ms, and wp-engage-crawl's paging pull (kernel 62440, a new TLS connection every 5 s, 167 to 456 KB in per
 * 10 s) 5.0 to 24.7 s. A reading older than `freshMs` (two skipped samples) is no baseline.
 */
export const MOTION = { cpuMs: 10, freshMs: 3 * MINUTE } as const;
/**
 * A session is hung when it has made no model call for over TARGET.idleMinutes and its kernel has not moved (MOTION) in any sample for
 * TARGET.idleMinutes. 30 min is past the p99.9 of ipython cells: 372,332 calls in the session files of 10-08 to 10-15 ran a median under 0.1 s,
 * p99 1.9 min and p99.9 19.1 min. Its chat is told when the service will interrupt the call, and the next sample interrupts it if the kernel
 * still has not moved: main dev thread acted on the watch's 02:56:58Z ask on 10-15 at 02:57:03Z, 5 s later.
 */
export const HUNG_MINUTES = TARGET.idleMinutes;

/**
 * A usable minute, from ops guy's feed: the kernel's pressure level under critical (4), swapouts under 6,000 a second, and kernel_task under
 * one core. 6,000 is pi-pool's governor threshold (components/pi-pool/pool/pressure.py SWAPOUTS_CRITICAL): 18 feed reads at 10:59-11:02Z on
 * 10-14 said warn while kernel_task paged at 168% to 256% of a core with 6,210 to 22,956 swapouts a second. The same reads set kernel_task's
 * line at one core; at 20:23Z on 10-14, with the Mac usable by the VP's read, it ran at 17.7%.
 */
export const USABLE = { pressureLevel: 4, swapoutsPerS: 6000, kernelTaskPct: 100 } as const;
/**
 * The Prime workers' footprint over which an unusable minute is the harness's: over the 721 watch minutes with a feed reading from 10-14 20:31Z
 * to 10-15 08:51Z, none of the 364 with the workers at 16 GB or less was unusable.
 */
export const HARNESS_GB = 16;
/** ops guy's machine-wide feed, schema v1, rewritten every 10 s. A reading older than FEED_FRESH_MS (three missed writes) is stale, the feed contract pi-pool's pool/pressure.py and the devbox textfile script keep. */
export const PRESSURE_FEED = join(homedir(), ".cache", "virev", "mac-pressure.json");
const FEED_FRESH_MS = 30_000;
/** One feed reading: the kernel's pressure level (1 normal, 2 warn, 4 critical), swapouts a second, and kernel_task CPU in % of a core. */
export interface UsableReading { pressureLevel: number; swapoutsPerS: number; kernelTaskPct: number;
  /** The feed's FEED_OWNERS largest owners by footprint, so a minute names the processes behind it; absent when the feed has none. */
  owners?: FeedOwner[] }
/** One feed owner: `chat:<root>`, `pm2:<app>`, `browser:<name>` or `other:<name>`, its label and its footprint. */
export interface FeedOwner { owner: string; label: string; gb: number }
/** Owners kept a minute: the feed lists about 50, and the largest 8 held 41 of its 57 GB at 08:52Z on 10-15. */
export const FEED_OWNERS = 8;
/** Owners on the harness side: chat trees, the Prime daemon and the chat service; every other owner is the apps' or the owner's own. */
export const isHarnessOwner = (owner: string): boolean => owner.startsWith("chat:") || owner === "other:prime-agent-daemon" || owner === "other:chat-service-cli.mjs";
export type UsableMiss = "pressure" | "swapouts" | "kernel_task";

/** The feed reading in `value`, or null when it is not schema v1, is older than FEED_FRESH_MS at `now`, or lacks a number. */
export function parseFeed(value: unknown, now: number): UsableReading | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.ts !== "string" || !(now - Date.parse(value.ts) < FEED_FRESH_MS)) return null;
  const { pressure_level: pressureLevel, swapouts_per_s: swapoutsPerS, kernel_task_cpu_pct: kernelTaskPct } = value;
  if (typeof pressureLevel !== "number" || typeof swapoutsPerS !== "number" || typeof kernelTaskPct !== "number") return null;
  const owners = Array.isArray(value.owners) ? value.owners.flatMap(item => isRecord(item) && typeof item.owner === "string" && typeof item.mem_gb === "number"
    ? [{ owner: item.owner, label: typeof item.label === "string" ? item.label : item.owner, gb: item.mem_gb }] : []).sort((a, b) => b.gb - a.gb).slice(0, FEED_OWNERS) : [];
  return { pressureLevel, swapoutsPerS, kernelTaskPct, ...owners.length ? { owners } : {} };
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

export type TargetPart = "usable" | "idle" | "queue";

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
  /** ops guy's feed this minute; null when it was stale or unreadable, absent on lines written before the watch read it. */
  usable?: UsableReading | null;
  workers: number; workerGb: number; top: WorkerLine[];
  /** The live chat roots; absent on lines written before it was counted. */
  chatsLive?: number;
  live: number; working: number; idle15: number;
  /** Working sessions with no activity for over TARGET.idleMinutes, and the trees that hold the most of them. */
  idleOver: number; idleTrees: TreeCount[];
  /** Each session counted in `idleOver`, by job and tree, with the tool call its last entry left open; absent on older lines. */
  quiet?: QuietLine[];
  /** Sessions with no model call for over TARGET.idleMinutes whose kernel moved (MOTION) since the last sample: they work, so `idleOver` leaves them out; absent on older lines. */
  active?: QuietLine[];
  /** Live sessions that ended their task (`taskState` needs_input) and sit idle, chats left out. */
  finished: number; finishedTrees: TreeCount[];
  queue: QueueLine | null;
  /** Background waiters in job kernels that board.wake would replace: gh run watch, ci-run-status --wait and long sleeps, and any bash() handle of a session in `idleOver` whose last entry is no open tool call (`quiet` names that call and its handle); absent on older lines. */
  waiters?: WaiterLine[];
  /** The chat trees with the largest footprint, kernel subtrees plus orphans, at most 5; absent on older lines. */
  trees?: TreeLine[];
  /** Processes the tree guard stopped this minute; absent when none. */
  stops?: StopLine[];
  /** Context only, from sysctl: swap in use and kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical). */
  mac: { swapGb: number | null; pressureLevel: number | null };
  /** CPU this sample cost: the service's own work plus the footprint helper's. */
  cpuMs: number;
}

/** The daemon row fields the watch reads, parsed at the boundary from the catalog's raw rows. */
interface Row { id: string; parent: string | undefined; name: string | undefined; live: boolean; hosted: boolean; working: boolean; lastAt: number; worker: number | undefined; ended: boolean;
  file: string | undefined }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseRow(value: unknown): Row | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  return { id: value.sessionId, parent: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
    name: typeof value.sessionName === "string" && value.sessionName ? value.sessionName : undefined, live: value.lifecycle === "live" && typeof value.activeSessionId === "string",
    hosted: value.lifecycle === "live" && typeof value.workerPid === "number",
    working: value.activity === "working", lastAt: typeof value.lastActivityAt === "string" ? Date.parse(value.lastActivityAt) : NaN,
    worker: typeof value.workerPid === "number" ? value.workerPid : undefined, ended: value.activity === "idle" && value.taskState === "needs_input",
    file: typeof value.sessionFile === "string" ? value.sessionFile : undefined };
}

/** What the footprint helper (src/worker-footprint.py) prints. */
export interface Footprints { workers: Record<string, { pids: number; bytes: number }>; waiters?: RawWaiter[]; handles?: RawWaiter[]; kernels?: RawKernel[]; orphans?: RawOrphan[];
  swap_used_bytes: number | null; pressure_level: number | null; cpu_s: number }
/** One process the helper names: its footprint, its start time in epoch seconds (null when unreadable) and its command's first 200 characters. */
export interface RawProcess { pid: number; bytes: number; started: number | null; command: string }
/**
 * A `python -m rlm.repl` kernel with the root and session its RLM_HARNESS_STATE_DIR names, its subtree, and its largest descendant that is no
 * Prime process; `cpu_ms` is the subtree's CPU since each process started and `members` its pids (absent from helpers before 10-15).
 */
export interface RawKernel { pid: number; root: string; session: string; pids: number; bytes: number; biggest: RawProcess | null; cpu_ms?: number; members?: number[] }
/** A process with RLM_HARNESS_STATE_DIR under no kernel and no Prime process (a deleted job's nohup'd runner), with the root and session the path names. */
export interface RawOrphan extends RawProcess { root: string; session: string }
/** A chat tree's footprint (its kernels' subtrees and its orphans) and its largest process that is no Prime process, `started` kept to catch pid reuse. */
export interface TreeLine { root: string; tree: string; gb: number; biggest: { pid: number; gb: number; started: number | null; command: string } | null }
/** A process the tree guard stopped (`guardTrees`), with the signal it sent first. */
export interface StopLine { root: string; tree: string; pid: number; gb: number; command: string; signal: "SIGTERM" }
/** A command that only waits on CI or a clock under a job's kernel (worker-footprint.py `WAITER`), or the command of a bash() handle (`HANDLE`), with the session its kernel serves. */
export interface RawWaiter { pid: number; kernel: number; session: string; command: string; age_s: number | null }
/** A waiter with the job and chat tree that own it; `quietMin`, set on a held bash() handle, is how long ago its session's turn ended. */
export interface WaiterLine { pid: number; kernel?: number; command: string; ageMin: number | null; session: string; job: string; root: string; tree: string; quietMin?: number }
/** A tool call a session's last entry left with no result: the call's id, its tool, when the model sent it, and its code's first line, cut to 200 characters as worker-footprint.py cuts a command. */
export interface OpenCall { id: string; tool: string; at: string; code: string }
/**
 * A session counted in `idleOver`: its id, job and chat tree, how long it has been quiet, the kernel that serves it (null when the helper named
 * none), the call its last entry left open (null when the last entry is no open tool call), and the command of a bash() handle its kernel holds.
 */
export interface QuietLine { session: string; job: string; root: string; tree: string; quietMin: number; kernel: number | null; call: OpenCall | null; handle?: string;
  /** How long the kernel has not moved (MOTION), by the watch's own samples; absent when the watch has no reading of it yet. */
  stillMin?: number }

/**
 * What the watch knows of a session's kernel at its last sample: the subtree's CPU in ms and pids, the socket counts nettop gave (null when it
 * was not read), whether it moved since the sample before (null with no fresh baseline), and since when it has not moved.
 */
export interface KernelMotion { kernel: number; at: number; cpuMs: number; members: number[]; net: string | null; moved: boolean | null; stillSince: number }
export type Motion = Record<string, KernelMotion>;

/** Each kernel's motion at `now` from the last sample's `prev`, its helper reading and its sockets (`nets`, by session, read only for quiet sessions). */
export function advanceMotion(prev: Readonly<Motion>, kernels: readonly RawKernel[], nets: ReadonlyMap<string, string>, now: number): Motion {
  const next: Motion = {};
  for (const kernel of kernels) {
    if (!kernel.session || kernel.cpu_ms === undefined) continue;
    const members = [...kernel.members ?? []].sort((a, b) => a - b);
    const net = nets.get(kernel.session) ?? null;
    const last = prev[kernel.session];
    const base = last && last.kernel === kernel.pid && now > last.at && now - last.at <= MOTION.freshMs ? last : null;
    const moved = base ? Math.abs(kernel.cpu_ms - base.cpuMs) >= MOTION.cpuMs || members.join(",") !== base.members.join(",") ||
      (net !== null && base.net !== null && net !== base.net) : null;
    next[kernel.session] = { kernel: kernel.pid, at: now, cpuMs: kernel.cpu_ms, members, net, moved, stillSince: base && moved === false ? base.stillSince : now };
  }
  return next;
}

/** Each pid's open sockets with their byte counts, one `tcp4 a<->b,in,out` line each, from one nettop read; an empty map when nettop fails. */
export function readSockets(pids: readonly number[]): Promise<Map<number, string[]>> {
  return new Promise(resolve => {
    execFile("/usr/bin/nettop", ["-L", "1", "-x", "-n", "-J", "bytes_in,bytes_out", ...pids.flatMap(pid => ["-p", String(pid)])], { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? new Map() : parseNettop(stdout)));
  });
}
/** nettop's logging output: a `<name>.<pid>,in,out,` line per process, then one line per socket. */
export function parseNettop(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^(tcp|udp)\d /.test(line)) { current?.push(line.replace(/,$/, "")); continue; }
    const owner = /^.+\.(\d+),\d+,\d+,$/.exec(line);
    if (owner) { current = []; found.set(Number(owner[1]), current); }
  }
  return found;
}

/** The tool call the last entry of a session file leaves open, read back from the file's end; null when the last entry is no assistant message with a tool call, or the file is unreadable. */
export async function openCall(file: string): Promise<OpenCall | null> {
  const last = await lastLine(file).catch(() => null);
  if (!last) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(last); } catch { return null; }
  const entry = isRecord(parsed) ? parsed : {};
  const message = entry.type === "message" && isRecord(entry.message) ? entry.message : null;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content) || typeof entry.timestamp !== "string") return null;
  const call = message.content.find((part): part is Record<string, unknown> => isRecord(part) && part.type === "toolCall" && typeof part.id === "string");
  if (!call) return null;
  const args = isRecord(call.arguments) ? call.arguments : {};
  const code = typeof args.code === "string" ? args.code : typeof args.command === "string" ? args.command : "";
  return { id: String(call.id), tool: typeof call.name === "string" ? call.name : "tool", at: entry.timestamp,
    code: (code.split("\n").find(text => text.trim()) ?? "").trim().slice(0, 200) };
}

/** The last non-empty line of a file, read back from its end a block at a time so a large session file costs only its tail. */
async function lastLine(file: string, block = 64 * 1024): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let end = size, tail = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - block);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      tail = Buffer.concat([chunk, tail]);
      end = start;
      const text = tail.toString("utf8").replace(/\n+$/, "");
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) return text.slice(cut + 1);
      if (end === 0) return text || null;
    }
    return null;
  } finally { await handle.close(); }
}

/** A live working session with no activity for over TARGET.idleMinutes at `now`, one that `idleOver` counts. */
const quietOver = (row: Row, now: number): boolean => row.live && row.working && now - row.lastAt > TARGET.idleMinutes * MINUTE;
/** The session file of each session `idleOver` counts at `now`, by session id. */
export function quietFiles(rows: readonly unknown[], now: number): Map<string, string> {
  return new Map(rows.map(parseRow).flatMap(row => row && quietOver(row, now) && row.file ? [[row.id, row.file] as const] : []));
}

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
  title: (id: string) => string | null; cpuMs: number; usable?: UsableReading | null; calls?: ReadonlyMap<string, OpenCall | null>; motion?: Readonly<Motion> }): WatchLine {
  const rows = input.rows.map(parseRow).filter((row): row is Row => row !== null);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tree = treeOf(byId, input.title);
  const live = rows.filter(row => row.live);
  const working = live.filter(row => row.working);
  const quiet = (ms: number) => working.filter(row => input.now - row.lastAt > ms);
  const moving = (row: Row): boolean => input.motion?.[row.id]?.moved === true;
  const idleOver = working.filter(row => quietOver(row, input.now) && !moving(row));
  const activeOver = working.filter(row => quietOver(row, input.now) && moving(row));
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
  const chatsLive = live.filter(row => input.chats.has(row.id)).length;
  const owner = (session: string, root: string): { root: string; tree: string } => {
    const row = byId.get(session) ?? byId.get(root);
    if (row) return tree(row);
    const id = root || session;
    return { root: id, tree: input.title(id) ?? id.slice(0, 8) };
  };
  const call = (id: string): OpenCall | null => input.calls?.get(id) ?? null;
  const quietIds = new Set(idleOver.filter(row => !call(row.id)).map(row => row.id));
  const waitKernels = new Set((input.footprints.waiters ?? []).map(waiter => waiter.kernel));
  const held = (input.footprints.handles ?? []).filter(handle => quietIds.has(handle.session) && !waitKernels.has(handle.kernel));
  const kernelOf = new Map((input.footprints.kernels ?? []).map(kernel => [kernel.session, kernel.pid]));
  const quietLine = (row: Row): QuietLine => {
    const left = call(row.id);
    const handle = left && (input.footprints.handles ?? []).find(item => item.session === row.id);
    const motion = input.motion?.[row.id];
    return { session: row.id, job: row.name ?? input.title(row.id) ?? row.id.slice(0, 8), ...tree(row), quietMin: Math.round((input.now - row.lastAt) / MINUTE),
      kernel: kernelOf.get(row.id) ?? null, call: left, ...handle ? { handle: handle.command } : {},
      ...motion ? { stillMin: Math.round((input.now - motion.stillSince) / MINUTE) } : {} };
  };
  return {
    at: new Date(input.now).toISOString(),
    usable: input.usable ?? null, chatsLive,
    workers: Object.keys(input.footprints.workers).length,
    workerGb: round(Object.values(input.footprints.workers).reduce((sum, worker) => sum + worker.bytes, 0) / GB),
    top, live: live.length, working: working.length, idle15: quiet(QUIET_MS).length,
    idleOver: idleOver.length, idleTrees: topTrees(idleOver, tree), quiet: idleOver.map(quietLine), active: activeOver.map(quietLine),
    finished: finished.length, finishedTrees: topTrees(finished, tree),
    queue,
    waiters: [...(input.footprints.waiters ?? []), ...held].map(waiter => {
      const row = byId.get(waiter.session);
      const owner = row ? tree(row) : { root: waiter.session, tree: input.title(waiter.session) ?? waiter.session.slice(0, 8) };
      const quietMin = row && held.includes(waiter) ? { quietMin: Math.round((input.now - row.lastAt) / MINUTE) } : {};
      return { pid: waiter.pid, kernel: waiter.kernel, command: waiter.command, ageMin: waiter.age_s === null ? null : Math.round(waiter.age_s / 60), session: waiter.session,
        job: row?.name ?? input.title(waiter.session) ?? waiter.session.slice(0, 8), root: owner.root, tree: owner.tree, ...quietMin };
    }),
    trees: treeLines(input.footprints, owner).slice(0, 5),
    mac: { swapGb: input.footprints.swap_used_bytes === null ? null : round(input.footprints.swap_used_bytes / GB, 1), pressureLevel: input.footprints.pressure_level },
    cpuMs: Math.round(input.cpuMs + input.footprints.cpu_s * 1000),
  };
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

/** The queue reading the watch needs; `governor` is pi-pool's memory governor record, absent from a pi-pool without one. */
export type QueueReading = Pick<AgentQueueReading, "working" | "queued"> & { governor?: { level: string; held: number } | null };
function queueLine(reading: QueueReading, now: number, treeName: (id: string) => string): QueueLine {
  const oldest = reading.queued.reduce<(typeof reading.queued)[number] | undefined>((first, entry) => !first || entry.since < first.since ? entry : first, undefined);
  return { working: reading.working.length, queued: reading.queued.length, held: reading.governor?.held ?? null, pressure: reading.governor?.level ?? null,
    oldestWaitS: oldest ? Math.max(0, Math.round((now - oldest.since) / 1000)) : 0, oldestTree: oldest ? treeName(oldest.tree) : null };
}

/** The target parts a line misses; empty when the minute is on target. A line without a feed reading misses no usable part, and one without a queue reading no queue part. */
export function misses(line: Pick<WatchLine, "usable" | "idleOver" | "queue">): TargetPart[] {
  const missed: TargetPart[] = [];
  if (line.usable && unusable(line.usable).length) missed.push("usable");
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
/** A process's start time in epoch seconds, or null when it is gone. */
export async function processStart(pid: number): Promise<number | null> {
  const answer = await runHelper(["--started", String(pid)], "");
  return typeof answer === "number" ? answer : null;
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
  /** The pressure feed's reading at `now`; absent, `readPressureFeed`. */
  feed?: (now: number) => Promise<UsableReading | null>;
  /** Sends a chat one notice line (the hub's notice, for a chat that is attached); absent, no chat is asked. */
  notify?: (chat: string, line: string) => Promise<void>;
  /** Sends a root that is not a chat (a plain thread) the line as a message through the daemon; absent, no thread is asked. */
  message?: (root: string, line: string) => Promise<void>;
  /** Where each sample writes `treeMemory` for pi-pool (TREE_MEMORY_FILE in the service); absent, nothing is written. */
  treeMemoryFile?: string;
  /** The Mac's RAM in bytes; absent, os.totalmem(). */
  ramBytes?: number;
  /** Signals a process (process.kill in the service); absent, the tree guard asks but stops nothing. */
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** A process's start time in epoch seconds, null when it is gone; absent, `processStart`. */
  processStart?: (pid: number) => Promise<number | null>;
  /** Runs `run` after `ms` without holding the minute timer; absent, an unref'd setTimeout. */
  later?: (run: () => void, ms: number) => void;
  /** Aborts a job session's turn, which interrupts its running cell, and starts a new turn with `line`; absent, no hung call is interrupted. */
  interrupt?: (session: string, line: string) => Promise<void>;
  /** Each pid's open sockets with byte counts; absent, `readSockets`. */
  sockets?: (pids: readonly number[]) => Promise<Map<number, string[]>>;
}

/** Ask keys whose ask failed and was logged, so a retry each minute logs nothing new. */
const failedAsks = new Set<string>();

/** The line that asks a chat or thread to move its job's background wait, or its held bash() handle, to board.wake. */
export function waiterLine(waiter: WaiterLine): string {
  const age = waiter.ageMin === null ? "" : ` for ${waiter.ageMin} min`;
  if (waiter.quietMin !== undefined) {
    return `${JOB_NOTICE_PREFIX}${waiter.job} (session ${waiter.session.slice(0, 8)}) ended its turn ${waiter.quietMin} min ago and still holds its kernel and worker in a bash() handle ` +
      `running \`${waiter.command}\` (pid ${waiter.pid})${age}. Tell it to run a command that outlives its turn detached (nohup <command> > <file> 2>&1 &) ` +
      "and set board.wake(at=<its end>), so the service wakes it and its worker can rest.";
  }
  return `${JOB_NOTICE_PREFIX}${waiter.job} (session ${waiter.session.slice(0, 8)}) holds its kernel and worker in \`${waiter.command}\` (pid ${waiter.pid})${age}. ` +
    "Tell it to end that wait and set board.wake for the CI run or time instead, so the service wakes it and its worker can rest.";
}

/** The line that asks a chat or thread to have a job run the tool call it has been quiet in for over TARGET.idleMinutes as a detached script with board.wake. */
export function openCallLine(quiet: QuietLine & { call: OpenCall }): string {
  const since = `${quiet.call.at.slice(11, 16)}Z`;
  const waits = quiet.handle ? ` The call waits on a bash() handle running \`${quiet.handle}\`.` : "";
  return `${JOB_NOTICE_PREFIX}${quiet.job} (session ${quiet.session.slice(0, 8)}) has been in one ${quiet.call.tool} call since ${since} with no model call for ${quiet.quietMin} min ` +
    `(\`${quiet.call.code}\`), so it counts as working and holds its kernel and worker.${waits} Do not interrupt the call. Tell the job to run a pull or wait this long ` +
    "as a detached script that writes its result to a file (nohup <command> > <file> 2>&1 &) and set board.wake(at=<its end>), so it ends its turn and its worker can rest.";
}

/** Whether a quiet session is hung: an open call, a kernel, and no motion (MOTION) for HUNG_MINUTES. */
export const isHung = (quiet: QuietLine): quiet is QuietLine & { call: OpenCall; kernel: number } =>
  quiet.call !== null && quiet.kernel !== null && (quiet.stillMin ?? 0) >= HUNG_MINUTES;

const clock = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`;

/** The line that tells a chat or thread its job's call is hung and when the service interrupts it: the next sample, one minute after the line's `at`. */
export function hungLine(quiet: QuietLine & { call: OpenCall; kernel: number }, at: number): string {
  return `${JOB_NOTICE_PREFIX}${quiet.job} (session ${quiet.session.slice(0, 8)}) has been in one ${quiet.call.tool} call since ${quiet.call.at.slice(11, 16)}Z ` +
    `(\`${quiet.call.code}\`) with no model call for ${quiet.quietMin} min, and its kernel (pid ${quiet.kernel}) has used no CPU, started or ended no process and ` +
    `moved no socket bytes for ${quiet.stillMin} min, so the call is hung. The service interrupts it at ${clock(at + MINUTE)} if the kernel still has not moved, ` +
    "and tells the job to rerun the work as a detached script with board.wake.";
}

/** The message the service sends a job whose hung call it interrupted. */
export function interruptLine(quiet: QuietLine & { call: OpenCall; kernel: number }): string {
  return `The chat service interrupted your ${quiet.call.tool} call from ${quiet.call.at.slice(11, 16)}Z (\`${quiet.call.code}\`): for ${quiet.stillMin} min your kernel ` +
    "used no CPU, started or ended no process and moved no socket bytes, so it was hung, most likely on a network read with no timeout. " +
    "Rerun that work as a detached script that writes its result to a file (nohup <command> > <file> 2>&1 &), with a timeout on every network call, " +
    "and set board.wake(at=<its end>), so your turn ends and your worker can rest while it runs.";
}

/** One line to send a tree's root once: `key` marks it asked in waiters-asked.json, `pid` names it in a failure log. */
export interface Ask { key: string; root: string; pid: number | null; line: string }

/**
 * The asks a watch line holds: each background waiter or held bash() handle once per kernel, and each tool call a quiet session left open once
 * per call (`call:<id>`) unless a waiter of the same session is asked already. A cell is keyed by its call, not its kernel, since the next long
 * cell in the same kernel is a new ask: wp-engage-crawl ran one cell from 00:55 to 01:27Z on 10-15 and sat in the next from 01:27:59Z on.
 */
export function asksOf(line: Pick<WatchLine, "waiters" | "quiet" | "active"> & { at?: string }): Ask[] {
  const waiters = line.waiters ?? [];
  const waiting = new Set(waiters.map(waiter => waiter.session));
  return [...waiters.map(waiter => ({ key: String(waiter.kernel ?? waiter.pid), root: waiter.root, pid: waiter.pid, line: waiterLine(waiter) })),
    ...[...line.quiet ?? [], ...line.active ?? []].flatMap((quiet): Ask[] => {
      if (!quiet.call || waiting.has(quiet.session)) return [];
      if (isHung(quiet)) return [{ key: `hung:${quiet.call.id}`, root: quiet.root, pid: quiet.kernel, line: hungLine(quiet, line.at ? Date.parse(line.at) : Date.now()) }];
      return [{ key: `call:${quiet.call.id}`, root: quiet.root, pid: quiet.kernel, line: openCallLine({ ...quiet, call: quiet.call }) }];
    })];
}

/** How long an asked key stays asked after its last sighting: a sleep loop starts a new pid each round and can miss a minute's sample. */
const ASKED_KEEP_MS = 60 * MINUTE;

/**
 * Sends each ask's root its line once (`<dataDir>/mac-usable/waiters-asked.json`, `{ [key]: { asked, seen } }`, kept ASKED_KEEP_MS past the
 * key's last sighting): a chat by a notice line (`notify`), a plain thread's root by a daemon message (`message`), since its job pins its worker
 * the same. An ask that fails is sent again next minute, and its failure is logged once.
 */
export async function askChats(source: Pick<WatchSource, "dataDir" | "notify" | "message" | "log">, asks: readonly Ask[], chats: ReadonlySet<string>, now: number): Promise<string[]> {
  if (!source.notify && !source.message) return [];
  const file = join(source.dataDir, "mac-usable", "waiters-asked.json");
  const read: unknown = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  const asked = new Map(Object.entries(typeof read === "object" && read !== null ? read : {}).flatMap(([key, value]): [string, { asked: number; seen: number }][] =>
    typeof value === "object" && value !== null && typeof value.asked === "number" && typeof value.seen === "number" ? [[key, { asked: value.asked, seen: value.seen }]] : []));
  const sent: string[] = [];
  for (const ask of asks) {
    const known = asked.get(ask.key);
    if (known) { known.seen = now; continue; }
    const send = chats.has(ask.root) ? source.notify : source.message;
    if (!send) continue;
    try {
      await send(ask.root, ask.line);
      asked.set(ask.key, { asked: now, seen: now });
      sent.push(ask.key);
    } catch (error) {
      if (!failedAsks.has(ask.key)) source.log(`mac usable watch: ask ${ask.root.slice(0, 8)} about ${ask.pid === null ? ask.key : `pid ${ask.pid}`}: ${error instanceof Error ? error.message : String(error)}`);
      failedAsks.add(ask.key);
    }
  }
  const kept = Object.fromEntries([...asked].filter(([, value]) => now - value.seen < ASKED_KEEP_MS));
  await writeFile(file + ".tmp", JSON.stringify(kept));
  await rename(file + ".tmp", file);
  return sent;
}

/**
 * Interrupts each hung call (`isHung`) whose `hung:<call id>` line went out in an earlier sample, once per call (`stop:<call id>` in
 * waiters-asked.json): `interrupt` aborts the job's turn, which sends its kernel an interrupt request, and starts a new turn with
 * `interruptLine`. A raw SIGINT does nothing here, since rlm.repl's handler drops a signal its worker did not request. A failed interrupt is
 * logged once and tried again next sample.
 */
export async function interruptHung(source: Pick<WatchSource, "dataDir" | "interrupt" | "log">, line: Pick<WatchLine, "at" | "quiet">): Promise<string[]> {
  if (!source.interrupt) return [];
  const file = join(source.dataDir, "mac-usable", "waiters-asked.json");
  const asked: Record<string, { asked: number; seen: number }> = await readFile(file, "utf8").then(text => JSON.parse(text) as Record<string, { asked: number; seen: number }>).catch(() => ({}));
  const at = Date.parse(line.at);
  const stopped: string[] = [];
  for (const quiet of line.quiet ?? []) {
    if (!isHung(quiet)) continue;
    const told = asked[`hung:${quiet.call.id}`];
    const key = `stop:${quiet.call.id}`;
    if (!told || told.asked >= at || asked[key]) continue;
    try {
      await source.interrupt(quiet.session, interruptLine(quiet));
      asked[key] = { asked: at, seen: at };
      stopped.push(quiet.session);
      source.log(`mac usable watch: interrupted ${quiet.job} (${quiet.session.slice(0, 8)}): its ${quiet.call.tool} call since ${quiet.call.at.slice(11, 16)}Z, kernel ${quiet.kernel} still ${quiet.stillMin} min`);
    } catch (error) {
      if (!failedAsks.has(key)) source.log(`mac usable watch: interrupt ${quiet.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      failedAsks.add(key);
    }
  }
  if (stopped.length) await writeAtomic(file, JSON.stringify(asked));
  return stopped;
}

/**
 * A chat tree may hold this share of the Mac's RAM (8 GiB of 32) before its root is asked to cut it and the stop rule counts its minutes. Of the
 * 1,600 per-worker footprints the watch logged from 10-14 19:30Z into 10-15, normal trees peaked at a median 1.3 GiB and a p90 of 2.2 GiB, the
 * highest normal ones at 5.76 (ops guy) and 5.58 (metal box owner), with one minute of land 36 item read-back at 8.14 and 0 swapouts. Both
 * thrash events sat above it: search visits grow SEO guy at 9.29 GiB with 11,824 swapouts a second (10-15 00:11Z), and VP of SEO at 16 to 25.5
 * GiB with 5,790 to 25,873 (00:37 to 00:53Z), where old_analysis.py (pid 77405) peaked at 30.26 GB. pi-pool reads the same share from TREE_MEMORY_FILE.
 */
export const TREE_SHARE = 0.25;
/**
 * The stop rule: a tree over TREE_SHARE in at least `hits` of its last `of` one-minute samples while the feed read USABLE.swapoutsPerS or more
 * swapouts. On the VP of SEO series of 10-15 it fires at 00:44Z (00:40, 00:41 and 00:44), 8 minutes before the manual stop at 00:52Z; on the
 * 09:11 KST series it never fires (1 of 5), and that script ended on its own. A SIGTERM gets `killAfterMs` before the SIGKILL.
 */
export const STOP_RULE = { hits: 3, of: 5, killAfterMs: 10_000 } as const;
/** The file pi-pool reads, rewritten each minute (`treeMemory`); a reader holds nothing once its `ts` is 180 s old, three missed writes. */
export const TREE_MEMORY_FILE = join(homedir(), ".cache", "virev", "tree-memory.json");

/** The tree-memory file's format, v1, set by the tree guard contract between the chat service and pi-pool. */
export interface TreeMemory { v: 1; ts: string; ram_gb: number; share: number; over: { root: string; tree: string; gb: number; pid: number | null; process_gb: number | null; command: string | null }[] }
/** The tree-memory file for a line: the trees over TREE_SHARE of `ramBytes` this minute, whatever the pressure; `over` is [] when none. */
export function treeMemory(line: Pick<WatchLine, "at" | "trees">, ramBytes: number): TreeMemory {
  return { v: 1, ts: line.at, ram_gb: round(ramBytes / GB, 1), share: TREE_SHARE,
    over: (line.trees ?? []).filter(tree => tree.gb * GB > TREE_SHARE * ramBytes).map(tree => ({ root: tree.root, tree: tree.tree, gb: tree.gb,
      pid: tree.biggest?.pid ?? null, process_gb: tree.biggest?.gb ?? null, command: tree.biggest?.command ?? null })) };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", text);
  await rename(file + ".tmp", file);
}

/** Prime's own processes, never stopped even if the helper named one: a kernel, a prime-agent binary (the daemon, a worker), pi-pool's token helper. */
const PRIME_PROCESS = /rlm\.repl|(^|\/)prime-agent( |$)|pi-pool-token/;
type GuardSource = Pick<WatchSource, "dataDir" | "notify" | "message" | "log" | "ramBytes" | "kill" | "processStart" | "later">;
interface GuardState { history: Record<string, { at: number; hit: boolean }[]>; asked: Record<string, { asked: number; seen: number }>; stopped: Record<string, number> }

function guardState(value: unknown): GuardState {
  const record = (key: string): Record<string, unknown> => isRecord(value) && isRecord(value[key]) ? value[key] : {};
  const history = Object.fromEntries(Object.entries(record("history")).flatMap(([root, samples]): [string, { at: number; hit: boolean }[]][] => Array.isArray(samples)
    ? [[root, samples.filter((entry): entry is { at: number; hit: boolean } => isRecord(entry) && typeof entry.at === "number" && typeof entry.hit === "boolean")]] : []));
  const asked = Object.fromEntries(Object.entries(record("asked")).flatMap(([key, entry]): [string, { asked: number; seen: number }][] =>
    isRecord(entry) && typeof entry.asked === "number" && typeof entry.seen === "number" ? [[key, { asked: entry.asked, seen: entry.seen }]] : []));
  const stopped = Object.fromEntries(Object.entries(record("stopped")).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  return { history, asked, stopped };
}

const gib = (gb: number): string => gb.toFixed(1);
/** The line that asks a tree's root to cut a tree over TREE_SHARE while the Mac is under pressure. */
export function treeAskLine(tree: TreeLine & { biggest: NonNullable<TreeLine["biggest"]> }, shareGb: number, reading: { level: number; swapoutsPerS: number }): string {
  return `${JOB_NOTICE_PREFIX}The ${tree.tree} tree holds ${gib(tree.gb)} GiB, over the ${gib(shareGb)} GiB a tree may hold (a quarter of the Mac's RAM), while the Mac is ` +
    `under memory pressure (level ${reading.level}, ${Math.round(reading.swapoutsPerS)} swapouts a second). Its biggest process is pid ${tree.biggest.pid} \`${tree.biggest.command}\` ` +
    `at ${gib(tree.biggest.gb)} GiB. Stop it or run it in chunks that fit the share; if the tree stays over while the Mac swaps, the service stops it.`;
}
/** The line that tells a tree's root which process the guard stopped. */
export function treeStopLine(tree: TreeLine & { biggest: NonNullable<TreeLine["biggest"]> }, shareGb: number): string {
  return `${JOB_NOTICE_PREFIX}The service stopped pid ${tree.biggest.pid} \`${tree.biggest.command}\` (${gib(tree.biggest.gb)} GiB) in the ${tree.tree} tree: the tree held ` +
    `${gib(tree.gb)} GiB, over its ${gib(shareGb)} GiB share, while the Mac swapped ${USABLE.swapoutsPerS} or more pages a second in ${STOP_RULE.hits} of the last ${STOP_RULE.of} minutes. ` +
    "A runner that started it may start more, so stop that runner or run the work in chunks.";
}

/** Tree keys whose ask or stop line failed and was logged, so a retry each minute logs nothing new. */
const failedTreeSends = new Set<string>();

/**
 * The per-tree memory guard, after each sample, with its state in `<dataDir>/mac-usable/tree-guard.json` so a service restart keeps it: each
 * tree's last STOP_RULE.of samples, the asks and the stops. A tree over TREE_SHARE while the feed reads high or critical (pressure level 2 or
 * more, or USABLE.swapoutsPerS swapouts) gets one line at its root per biggest process (`treeAskLine`). A tree that meets STOP_RULE has its
 * biggest process stopped once: SIGTERM, then SIGKILL after STOP_RULE.killAfterMs if it still runs, each only while the pid's start time
 * still matches; its root is told (`treeStopLine`) and the service log names it. A chat gets a notice (`notify`), a plain thread a message.
 */
export async function guardTrees(source: GuardSource, line: Pick<WatchLine, "trees" | "usable" | "mac">, chats: ReadonlySet<string>, now: number): Promise<StopLine[]> {
  const file = join(source.dataDir, "mac-usable", "tree-guard.json");
  const state = guardState(await readFile(file, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null));
  const shareBytes = TREE_SHARE * (source.ramBytes ?? totalmem());
  const swapouts = line.usable?.swapoutsPerS ?? 0;
  const level = line.usable?.pressureLevel ?? line.mac.pressureLevel ?? 0;
  const over = (line.trees ?? []).filter(tree => tree.gb * GB > shareBytes);
  const overRoots = new Set(over.map(tree => tree.root));
  for (const root of new Set([...Object.keys(state.history), ...overRoots])) {
    const kept = [...state.history[root] ?? [], { at: now, hit: overRoots.has(root) && swapouts >= USABLE.swapoutsPerS }]
      .filter(entry => now - entry.at < STOP_RULE.of * MINUTE).slice(-STOP_RULE.of);
    if (kept.some(entry => entry.hit)) state.history[root] = kept;
    else delete state.history[root];
  }
  const tell = async (key: string, root: string, text: string): Promise<boolean> => {
    const send = chats.has(root) ? source.notify : source.message;
    if (!send) return false;
    try { await send(root, text); failedTreeSends.delete(key); return true; } catch (error) {
      if (!failedTreeSends.has(key)) source.log(`mac usable watch: tell ${root.slice(0, 8)} about its tree: ${error instanceof Error ? error.message : String(error)}`);
      failedTreeSends.add(key);
      return false;
    }
  };
  const stops: StopLine[] = [];
  for (const tree of over) {
    const biggest = tree.biggest;
    if (!biggest) continue;
    const named = { ...tree, biggest };
    const key = `${tree.root}:${biggest.pid}`;
    const hits = (state.history[tree.root] ?? []).filter(entry => entry.hit).length;
    if (hits >= STOP_RULE.hits && source.kill && !(key in state.stopped)) {
      state.stopped[key] = now;
      if (await stopProcess(source, named)) {
        stops.push({ root: tree.root, tree: tree.tree, pid: biggest.pid, gb: biggest.gb, command: biggest.command, signal: "SIGTERM" });
        await tell(`stop ${key}`, tree.root, treeStopLine(named, shareBytes / GB));
      }
      continue;
    }
    const known = state.asked[key];
    if (known) { known.seen = now; continue; }
    if ((level >= 2 || swapouts >= USABLE.swapoutsPerS) && await tell(key, tree.root, treeAskLine(named, shareBytes / GB, { level, swapoutsPerS: swapouts }))) {
      state.asked[key] = { asked: now, seen: now };
    }
  }
  state.asked = Object.fromEntries(Object.entries(state.asked).filter(([, entry]) => now - entry.seen < ASKED_KEEP_MS));
  state.stopped = Object.fromEntries(Object.entries(state.stopped).filter(([, at]) => now - at < ASKED_KEEP_MS));
  await writeAtomic(file, JSON.stringify(state));
  return stops;
}

/** SIGTERM to a tree's biggest process if its start time still matches, then SIGKILL after STOP_RULE.killAfterMs if the same process still runs. */
async function stopProcess(source: GuardSource, tree: TreeLine & { biggest: NonNullable<TreeLine["biggest"]> }): Promise<boolean> {
  const { pid, started, command, gb } = tree.biggest;
  const kill = source.kill!;
  const startOf = source.processStart ?? processStart;
  const name = `pid ${pid} \`${command}\` (${gib(gb)} GiB) in the ${tree.tree} tree (${tree.root.slice(0, 8)}, ${gib(tree.gb)} GiB)`;
  if (started === null || pid <= 1 || pid === process.pid || PRIME_PROCESS.test(command)) { source.log(`mac usable watch: tree guard: not stopping ${name}: no start time or a Prime process`); return false; }
  try {
    if (await startOf(pid) !== started) { source.log(`mac usable watch: tree guard: ${name} ended or its pid was reused before the stop`); return false; }
    kill(pid, "SIGTERM");
  } catch (error) {
    source.log(`mac usable watch: tree guard: SIGTERM ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  source.log(`mac usable watch: tree guard: SIGTERM ${name}, over the share while the Mac swapped in ${STOP_RULE.hits} of ${STOP_RULE.of} minutes`);
  (source.later ?? ((run, ms) => { setTimeout(run, ms).unref(); }))(() => {
    void (async () => {
      if (await startOf(pid) !== started) { source.log(`mac usable watch: tree guard: ${name} ended after SIGTERM`); return; }
      kill(pid, "SIGKILL");
      source.log(`mac usable watch: tree guard: SIGKILL ${name}, still running ${STOP_RULE.killAfterMs / 1000} s after SIGTERM`);
    })().catch(error => source.log(`mac usable watch: tree guard: SIGKILL ${name}: ${error instanceof Error ? error.message : String(error)}`));
  }, STOP_RULE.killAfterMs);
  return true;
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
  const [footprints, queue, chats, usable, calls] = await Promise.all([(source.footprints ?? readFootprints)(pids), source.queue().catch(() => null), source.chats(),
    (source.feed ?? readPressureFeed)(at), Promise.all([...quietFiles(rows, at)].map(async ([id, file]) => [id, await openCall(file)] as const)).then(found => new Map(found))]);
  const motionFile = join(source.dataDir, "mac-usable", "kernel-motion.json");
  const quietKernels = (footprints.kernels ?? []).filter(kernel => calls.has(kernel.session) && kernel.members?.length);
  const sockets = quietKernels.length ? await (source.sockets ?? readSockets)(quietKernels.flatMap(kernel => kernel.members!)) : new Map<number, string[]>();
  const nets = new Map(quietKernels.map(kernel => [kernel.session, kernel.members!.flatMap(pid => sockets.get(pid) ?? []).sort().join("\n")]));
  const prev = await readFile(motionFile, "utf8").then(text => JSON.parse(text) as Motion).catch((): Motion => ({}));
  const motion = advanceMotion(isRecord(prev) ? prev : {}, footprints.kernels ?? [], nets, at);
  const resumed = process.cpuUsage();
  const line = watchLine({ now: at, rows, footprints, queue, chats, title: source.title, cpuMs: 0, usable, calls, motion });
  const after = process.cpuUsage(resumed);
  own = { user: own.user + after.user, system: own.system + after.system };
  const measured = { ...line, cpuMs: line.cpuMs + Math.round((own.user + own.system) / 1000) };
  const file = watchFile(source.dataDir, now());
  await mkdir(join(source.dataDir, "mac-usable"), { recursive: true });
  if (source.treeMemoryFile) {
    await writeAtomic(source.treeMemoryFile, JSON.stringify(treeMemory(measured, source.ramBytes ?? totalmem())))
      .catch(error => source.log(`mac usable watch: tree memory file: ${error instanceof Error ? error.message : String(error)}`));
  }
  const stops = await guardTrees(source, measured, chats, now()).catch(error => {
    source.log(`mac usable watch: tree guard: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const written = stops.length ? { ...measured, stops } : measured;
  await appendFile(file, JSON.stringify(written) + "\n");
  await writeAtomic(motionFile, JSON.stringify(motion)).catch(error => source.log(`mac usable watch: kernel motion file: ${error instanceof Error ? error.message : String(error)}`));
  await askChats(source, asksOf(written), chats, now());
  await interruptHung(source, written);
  return written;
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
