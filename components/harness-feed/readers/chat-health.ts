import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import type { AgentLine, HostUsable, HostWatchLine, TestBrowserLine, WaitingTree, WatchLine, WorkerLine } from "../../user-history/src/mac-usable-watch.ts";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import type { DaemonFault } from "../../user-history/src/daemon-faults.ts";
import { readReopenedSends, readServiceFaults, readSupervisorFaults } from "../../user-history/src/daemon-faults.ts";
import { harnessSlow, workerMisses } from "../../user-history/src/harness-slow.ts";
import { quietMinutes } from "../../user-history/src/quiet-minutes.ts";
import { stepOwner } from "../../user-history/src/checkin-steps.ts";
import { BUCKETS, bucketOf, inSidebar, sidebarSections } from "../../user-history/src/client/organize.ts";
import { readPulse, type PulseLevel } from "../../user-history/src/shared/pulse.ts";
import type { PlanItem, Pulse, SessionRow, ThreadSchedule } from "../../user-history/src/shared/types.ts";
import type { ThreadOrigin } from "../../user-history/src/thread-origin.ts";
import { copyIndex, sessionRows, type CopyRow } from "./session-copy.ts";

// The chat's responsiveness and its agents, from the files the live chat service writes on its box: the usable watch's minute lines
// (src/mac-usable-watch.ts), service.log, the supervisor's daemon logs, pi-pool.log, the catalog copies, unloaded.json and d7's last run.
// The minute math is the Whole system duty's (components/user-history/scripts/duties/whole-system.ts `measure`), ported because that file's
// import tree has TS parameter properties that plain node cannot strip. Every log is read from a saved offset, so a round reads only new bytes.

const MINUTE = 60_000;
const GIB = 1024 ** 3;
/** whole-system.ts WINDOW_MS, HOLD_MS, FREE_SLOTS, QUEUED_WAIT_S. */
const WINDOW_MS = 30 * MINUTE;
const HOLD_MS = 10 * MINUTE;
const FREE_SLOTS = 2;
const QUEUED_WAIT_S = 120;
/** whole-system.ts LOG_TAIL_BYTES and POOL_LOG_TAIL_BYTES: the first round's read, about 3 h of service.log and 14 h of pi-pool.log. */
const LOG_TAIL_BYTES = 6_000_000;
const POOL_LOG_TAIL_BYTES = 2_000_000;
/** How long service.log's wake and fleet budget lines and pi-pool's parked lines are kept: the span the precheck's tails cover. */
const HOLD_KEEP_MS = 3 * 60 * MINUTE;
const POOL_KEEP_MS = 14 * 60 * MINUTE;
/** How far back faults, polls and reopened sends are kept: the precheck's window plus 2 minutes, with a minute to spare. */
const FAULT_KEEP_MS = WINDOW_MS + 3 * MINUTE;
/** The span of the latency gauges for opens and worker starts. */
const LATENCY_MS = 5 * MINUTE;
/** mac-usable-watch.ts UNREAD_AT_STOP. */
const UNREAD_AT_STOP = "unread: the chat service stopped before the relay answered";
/** whole-system.ts UNNAMED_HOST: lines written before 10-18 04:5xZ name no box, and the Mac wrote every one of them. */
const UNNAMED_HOST = "mac";
/** host-stats.ts CPU_SIDES. */
const CPU_SIDES = ["harness", "apps", "owner", "ci", "system"] as const;
/** mac-usable-watch.ts USABLE and LINUX_USABLE. */
const USABLE = { pressureLevel: 4, swapoutsPerS: 6000, kernelTaskPct: 100 } as const;
const LINUX_USABLE = { memFullAvg10: 70, runnablePerCore: 1 } as const;

type Hold = { what: string; from: number; to: number };
type PoolHold = { session: string; from: number; to: number; room: readonly string[]; cell: boolean };
type HostView = { name: string; usable: HostUsable | null; workers: number; workerGb: number; top: readonly WorkerLine[]; serviceGb?: number; agents?: AgentLine;
  error?: string; offline?: true; testBrowsers?: readonly TestBrowserLine[] };
type MinuteSide = "harness" | "other" | "unknown";
type Tail = { offset: number; rest: Buffer };
type Stamped<T> = { at: number; value: T };

interface State {
  sidebar: SidebarState;
  watch: Map<string, Tail>;
  lines: WatchLine[];
  service?: Tail;
  serviceStamp: string;
  holdLines: Stamped<string>[];
  serviceFaults: DaemonFault[];
  reopened: number[];
  opens: Stamped<number>[];
  starts: Stamped<{ kind: string; s: number }>[];
  pool?: Tail;
  poolLines: Stamped<string>[];
  daemon: Map<string, Tail>;
  supervisorLines: Stamped<string>[];
  catalogs: Map<string, { mtimeMs: number; counts: Map<string, { thread: number; subagent: number }> }>;
  unloaded?: { mtimeMs: number; times: number[] };
  d7?: { runs: string; id: string; mtimeMs: number; at: number; metrics: Record<string, number>; cuts: { hold: Hold; open: boolean }[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The whole lines appended to `file` since `tail`, and the tail to keep. A first read starts `firstBytes` before the end and drops the line it
 * cuts; a file that shrank is read again from its start. A line still being written stays in `rest` until its newline lands.
 */
export async function readNew(file: string, tail: Tail | undefined, firstBytes: number): Promise<{ lines: string[]; tail: Tail } | null> {
  let handle;
  try { handle = await open(file, "r"); } catch { return null; }
  try {
    const { size } = await handle.stat();
    const from = tail && tail.offset <= size ? tail.offset : tail ? 0 : Math.max(0, size - firstBytes);
    const rest = tail && tail.offset <= size ? tail.rest : Buffer.alloc(0);
    const bytes = Buffer.alloc(size - from);
    if (bytes.length) await handle.read(bytes, 0, bytes.length, from);
    const all = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    const end = all.lastIndexOf(10);
    if (end < 0) return { lines: [], tail: { offset: size, rest: all } };
    const lines = all.subarray(0, end).toString("utf8").split("\n");
    if (!tail && from > 0) lines.shift();
    return { lines: lines.filter(line => line.length > 0), tail: { offset: size, rest: Buffer.from(all.subarray(end + 1)) } };
  } finally { await handle.close(); }
}

// ---- the watch lines (mac-usable-watch.ts) ----

const WATCH_FILE = /^\d{4}-\d\d-\d\d\.jsonl$/;
const LINE_AT = /"at":"([^"]+)"/;

/** Reads the new watch lines of every day file written within `keepMs`, and keeps the lines of that span, oldest first. */
async function readWatchLines(state: State, dir: string, now: number, keepMs: number): Promise<void> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => WATCH_FILE.test(name));
  for (const name of names) {
    const file = join(dir, name);
    const known = state.watch.get(file);
    if (!known) {
      const info = await stat(file).catch(() => null);
      if (!info || info.mtimeMs < now - keepMs) continue;
    }
    const read = await readNew(file, known ?? { offset: 0, rest: Buffer.alloc(0) }, 0);
    if (!read) { state.watch.delete(file); continue; }
    state.watch.set(file, read.tail);
    for (const raw of read.lines) {
      const at = Date.parse(LINE_AT.exec(raw.slice(0, 200))?.[1] ?? "");
      if (!(at >= now - keepMs)) continue;
      try { state.lines.push(JSON.parse(raw) as WatchLine); } catch { continue; }
    }
  }
  for (const file of state.watch.keys()) if (!names.includes(file.slice(dir.length + 1))) state.watch.delete(file);
  state.lines = state.lines.filter(line => Date.parse(line.at) >= now - keepMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const isLinuxReading = (reading: HostUsable): reading is LinuxUsable => (reading as { kind?: unknown }).kind === "linux";
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** mac-usable-watch.ts `parseLinuxReading`, as far as the minute math reads it: null for an old-format or invalid Linux reading. */
function linuxReadingOk(reading: LinuxUsable): boolean {
  const { memSomeAvg10, memFullAvg10, cpuSomeAvg10, swapoutsPerS, runnablePerCore, allowedCpus } = reading;
  return count(memSomeAvg10) && count(memFullAvg10) && count(cpuSomeAvg10) && count(runnablePerCore) && Number.isInteger(allowedCpus) && allowedCpus > 0 &&
    (swapoutsPerS === null || count(swapoutsPerS));
}
/** A Linux reading whose cpuCores lack a side reads no cpuCores, as `parseLinuxReading` drops them. */
function cleanLinux(reading: LinuxUsable): LinuxUsable {
  const sides = reading.cpuCores as Record<string, unknown> | undefined;
  return isRecord(sides) && CPU_SIDES.every(side => count(sides[side])) ? reading : { ...reading, cpuCores: undefined };
}

/** mac-usable-watch.ts `unusable`. */
export function unusable(reading: HostUsable): string[] {
  const missed: string[] = [];
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

const OLD_LINUX_READING = "an old-format or invalid Linux reading";
const checked = (usable: HostUsable | null | undefined): { usable: HostUsable | null; error?: string } =>
  !usable || !isLinuxReading(usable) ? { usable: usable ?? null } : linuxReadingOk(usable) ? { usable: cleanLinux(usable) } : { usable: null, error: OLD_LINUX_READING };

/** whole-system.ts `hostViews`: the boxes of a watch line, the writer first. */
export function hostViews(line: WatchLine): HostView[] {
  const own = checked(line.usable);
  return [
    { name: line.host ?? UNNAMED_HOST, usable: own.usable, workers: line.workers, workerGb: line.workerGb, top: line.top,
      ...line.serviceGb === undefined ? {} : { serviceGb: line.serviceGb }, ...line.agents ? { agents: line.agents } : {}, ...own.error ? { error: own.error } : {},
      ...line.testBrowsers ? { testBrowsers: line.testBrowsers } : {} },
    ...(line.hosts ?? []).map((host: HostWatchLine) => {
      const read = checked(host.usable);
      const error = host.error ?? read.error;
      return { name: host.name, usable: read.usable, workers: host.workers, workerGb: host.workerGb, top: host.top,
        ...host.agents ? { agents: host.agents } : {}, ...error ? { error } : {}, ...host.offline ? { offline: true as const } : {}, ...host.testBrowsers ? { testBrowsers: host.testBrowsers } : {} };
    }),
  ];
}

/** whole-system.ts `usableAround`. */
function usableAround(watch: readonly WatchLine[], box: string, from: number, to: number): boolean {
  const reads = (line: WatchLine | undefined): boolean => {
    const view = line && hostViews(line).find(candidate => candidate.name === box);
    return !!view?.usable && !unusable(view.usable).length;
  };
  return reads(watch.findLast(line => { const at = Date.parse(line.at); return at < from && at >= from - MINUTE; }))
    && reads(watch.find(line => { const at = Date.parse(line.at); return at >= to && at < to + MINUTE; }));
}

const feedGroups = (usable: HostUsable | null): Record<string, number> | undefined => usable && !isLinuxReading(usable) ? usable.groups as Record<string, number> | undefined : undefined;
/** whole-system.ts `memoryShares` and `leads`. */
function memoryShares(view: HostView): Map<string, number> {
  const shares = new Map<string, number>(Object.entries(feedGroups(view.usable) ?? {}));
  shares.set("agents", Math.max((shares.get("agents") ?? 0) + (shares.get("services") ?? 0), view.workerGb + (view.serviceGb ?? 0)));
  shares.delete("services");
  return shares;
}
const leads = (shares: ReadonlyMap<string, number>): boolean => {
  const agents = shares.get("agents") ?? 0;
  return agents > 0 && [...shares].every(([id, gb]) => id === "agents" || gb < agents);
};
/** whole-system.ts `minuteSide`. */
function minuteSide(view: HostView, previous?: { view: HostView; gapMs: number }): MinuteSide {
  const usable = view.usable;
  if (usable && isLinuxReading(usable)) {
    if (!usable.cpuCores || !unusable(usable).includes("cpu")) return "unknown";
    const { harness, ...rest } = usable.cpuCores;
    return harness > 0 && Object.values(rest).every(cores => cores <= harness) ? "harness" : "other";
  }
  if (!feedGroups(usable)) return "unknown";
  const now = memoryShares(view);
  if (leads(now)) return "harness";
  if (!previous || !feedGroups(previous.view.usable) || previous.gapMs > 2 * MINUTE) return "other";
  const before = memoryShares(previous.view);
  const growth = new Map([...now].map(([id, gb]) => [id, gb - (before.get(id) ?? 0)] as const));
  return (growth.get("agents") ?? 0) > 0 && leads(growth) ? "harness" : "other";
}
/** whole-system.ts `sideOf`. */
function sideOf(lines: readonly WatchLine[]): (line: WatchLine, view: HostView) => MinuteSide {
  const previous = new Map(lines.map((line, at) => [line, lines[at - 1]] as const));
  return (line, view) => {
    const before = previous.get(line);
    const same = before && hostViews(before).find(candidate => candidate.name === view.name);
    return minuteSide(view, same ? { view: same, gapMs: Date.parse(line.at) - Date.parse(before.at) } : undefined);
  };
}

/** whole-system.ts `freeSlotWait`. */
function freeSlotWait(line: WatchLine): WaitingTree | undefined {
  const queue = line.queue;
  if (!queue?.waiting || queue.workingMax === undefined || queue.treeWorkingMax === undefined || queue.slots === undefined) return undefined;
  if (queue.slots > queue.workingMax - FREE_SLOTS) return undefined;
  return queue.waiting.find(tree => tree.oldestWaitS >= QUEUED_WAIT_S && tree.slots <= queue.treeWorkingMax! - FREE_SLOTS);
}

/** whole-system.ts `quietAgents`: each box minute in [from, to) past the quiet window, with that minute's Agent sessions GB. */
export function quietAgents(lines: readonly WatchLine[], from: number, to: number, quietMs: number): { host: string; at: number; gb: number }[] {
  const since = new Map<string, number | null>();
  const last = new Map<string, number>();
  const found: { host: string; at: number; gb: number }[] = [];
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!(at < to)) continue;
    for (const view of hostViews(line)) {
      const agents = view.agents;
      const before = last.get(view.name);
      last.set(view.name, at);
      if (!agents || agents.gb === null || agents.working > 0) { since.set(view.name, null); continue; }
      const start = before !== undefined && at - before <= 2 * MINUTE ? since.get(view.name) ?? at : at;
      since.set(view.name, start);
      if (at >= from && at - start >= quietMs) found.push({ host: view.name, at, gb: agents.gb });
    }
  }
  return found;
}

// ---- service.log, pi-pool.log and the supervisor's logs ----

const TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const WAKE_HELD = /^wakes: wake ([\w-]+) for .*; tried again next tick$/;
const RUN_UNREADABLE = /^wakes: run (\d+): /;
const STARTED_AFTER = /^fleet budget: (\S+) (.+) starts after (\d+) s$/;
const HOLD_GAP_MS = 5 * MINUTE;
const OPEN_LINE = /^open [0-9a-f]{8}(?: on [\w.-]+)? (?:live|saved) \d+ messages: .*, total (\d+)ms$/;
const START_LINE = /^daemon (create|resume|reload) .+?: answered in ([\d.]+) s/;

/** whole-system.ts `readServiceLog`, holds only. */
export function readServiceHolds(lines: readonly string[]): Hold[] {
  const wakes = new Map<string, Hold>();
  const runs = new Map<string, Hold>();
  const holds: Hold[] = [];
  const extend = (openHolds: Map<string, Hold>, key: string, what: string, at: number) => {
    const hold = openHolds.get(key);
    if (hold && at - hold.to <= HOLD_GAP_MS) hold.to = at;
    else { const fresh = { what, from: at, to: at }; openHolds.set(key, fresh); holds.push(fresh); }
  };
  let at = NaN;
  for (const raw of lines) {
    const match = TIME.exec(raw);
    if (match) at = Date.parse(match[1]!);
    if (!Number.isFinite(at)) continue;
    const text = match ? match[2]! : raw;
    let found: RegExpExecArray | null;
    if ((found = WAKE_HELD.exec(text))) extend(wakes, found[1]!, `wake of ${found[1]}`, at);
    else if ((found = RUN_UNREADABLE.exec(text))) extend(runs, found[1]!, `wake on unreadable run ${found[1]}`, at);
    else if ((found = STARTED_AFTER.exec(text))) holds.push({ what: `${found[1]} ${found[2]}`, from: at - Number(found[3]) * 1000, to: at });
  }
  return holds;
}

/** whole-system.ts `readPoolLog`: the trees pi-pool refused while accounts took their class. */
export function readPoolLog(lines: readonly string[], now: number): PoolHold[] {
  const openHolds = new Map<string, PoolHold>();
  const holds: PoolHold[] = [];
  for (const line of lines) {
    if (!line.includes('"parked"') && !line.includes('"unparked"')) continue;
    let entry: { event?: unknown; session?: unknown; at?: unknown; slot_at?: unknown; room?: unknown; backoff?: unknown };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (typeof entry.session !== "string" || typeof entry.at !== "number") continue;
    const at = entry.at * 1000;
    const hold = openHolds.get(entry.session);
    const room = entry.event === "parked" && Array.isArray(entry.room) ? entry.room.filter((name): name is string => typeof name === "string") : [];
    const until = typeof entry.slot_at === "number" ? Math.max(at, entry.slot_at * 1000) : at;
    const cell = entry.backoff !== true;
    if (room.length) {
      if (hold) { hold.to = Math.max(hold.to, until); hold.cell &&= cell; continue; }
      const fresh = { session: entry.session, from: at, to: until, room, cell };
      openHolds.set(entry.session, fresh);
      holds.push(fresh);
    } else if (hold) {
      hold.to = Math.min(hold.to, at);
      openHolds.delete(entry.session);
    }
  }
  for (const hold of holds) hold.to = Math.min(hold.to, now);
  return holds;
}

/** Reads service.log's new lines: the wake and fleet budget lines for holds, the daemon faults and reopened sends, the opens and worker starts. */
async function readService(state: State, file: string, box: string, now: number): Promise<void> {
  const read = await readNew(file, state.service, LOG_TAIL_BYTES);
  if (!read) return;
  state.service = read.tail;
  // A line written to stderr carries no stamp and takes the last stamped line's time, so each kept line carries its stamp.
  const stamped: string[] = [];
  for (const raw of read.lines) {
    const match = TIME.exec(raw);
    if (match) state.serviceStamp = match[1]!;
    if (!state.serviceStamp) continue;
    const line = match ? raw : `${state.serviceStamp} ${raw}`;
    stamped.push(line);
    const at = Date.parse(state.serviceStamp);
    const text = match ? match[2]! : raw;
    if (text.startsWith("wakes: ") || text.startsWith("fleet budget: ")) state.holdLines.push({ at, value: line });
    let found: RegExpExecArray | null;
    if ((found = OPEN_LINE.exec(text))) state.opens.push({ at, value: Number(found[1]) / 1000 });
    else if ((found = START_LINE.exec(text))) state.starts.push({ at: at + Number(found[2]) * 1000, value: { kind: found[1]!, s: Number(found[2]) } });
  }
  state.serviceFaults.push(...readServiceFaults(stamped, box));
  state.reopened.push(...readReopenedSends(stamped));
  state.holdLines = state.holdLines.filter(line => line.at >= now - HOLD_KEEP_MS);
  state.serviceFaults = state.serviceFaults.filter(fault => fault.at >= now - FAULT_KEEP_MS);
  state.reopened = state.reopened.filter(at => at >= now - FAULT_KEEP_MS);
  state.opens = state.opens.filter(entry => entry.at >= now - LATENCY_MS);
  state.starts = state.starts.filter(entry => entry.at >= now - LATENCY_MS);
}

const POOL_AT = /"at": ?([\d.]+)/;
async function readPool(state: State, file: string, now: number): Promise<void> {
  const read = await readNew(file, state.pool, POOL_LOG_TAIL_BYTES);
  if (!read) return;
  state.pool = read.tail;
  for (const line of read.lines) {
    if (!line.includes('"parked"') && !line.includes('"unparked"')) continue;
    const at = Number(POOL_AT.exec(line)?.[1]) * 1000;
    if (Number.isFinite(at)) state.poolLines.push({ at, value: line });
  }
  state.poolLines = state.poolLines.filter(line => line.at >= now - POOL_KEEP_MS);
}

const SUPERVISOR_AT = /^\[(\S+Z)\] supervisor: /;
/** Reads the new supervisor lines of every daemon.sock log, as the precheck's `daemonLogs` lists them; a log untouched in the window is skipped. */
async function readDaemonLogs(state: State, dir: string, now: number): Promise<void> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.startsWith("daemon.sock.") && name.includes(".log"));
  await Promise.all(names.map(async name => {
    const file = join(dir, name);
    const known = state.daemon.get(file);
    const info = await stat(file).catch(() => null);
    if (!info) return;
    if (!known && info.mtimeMs < now - FAULT_KEEP_MS) { state.daemon.set(file, { offset: info.size, rest: Buffer.alloc(0) }); return; }
    if (known && known.offset === info.size) return;
    const read = await readNew(file, known ?? { offset: 0, rest: Buffer.alloc(0) }, 0);
    if (!read) return;
    state.daemon.set(file, read.tail);
    for (const line of read.lines) {
      const at = Date.parse(SUPERVISOR_AT.exec(line)?.[1] ?? "");
      if (at >= now - FAULT_KEEP_MS) state.supervisorLines.push({ at, value: line });
    }
  }));
  state.supervisorLines = state.supervisorLines.filter(line => line.at >= now - FAULT_KEEP_MS).sort((a, b) => a.at - b.at);
}

// ---- the catalog copies, unloaded.json and d7's last run ----

const RUNNING = Buffer.from('"rosterStatus":"running"');
/**
 * The sessions running a turn in one catalog copy (session-copy.json, or a box's `<host>.sessions.json`), as the sidebar's Agents line counts
 * them (client/active-agents.ts `activeAgents`): a top-level row's own turn, unless it is archived, and every subagent row whose rosterStatus is
 * running. The copy is streamed a row at a time (`sessionRows`), and only rows whose bytes name a running roster status are parsed.
 */
export async function runningRows(file: string): Promise<{ thread: number; subagent: number }> {
  const counts = { thread: 0, subagent: 0 };
  for await (const row of sessionRows(file, raw => raw.includes(RUNNING))) {
    if (row.rosterStatus !== "running") continue;
    if (row.rlmDepth === 0 || row.runtimeKind === "top-level") { if (row.lifecycle !== "archived") counts.thread++; }
    else counts.subagent++;
  }
  return counts;
}

/** Each box's running sessions from its catalog copy, read again only when the copy changed. */
async function readCatalogs(state: State, dataDir: string, mirror: string, box: string): Promise<void> {
  const files = [[box, join(dataDir, "session-copy.json")] as const,
    ...(await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json")).map(name => [name.slice(0, -".sessions.json".length), join(mirror, name)] as const)];
  for (const [host, file] of files) {
    const info = await stat(file).catch(() => null);
    if (!info) { state.catalogs.delete(file); continue; }
    if (state.catalogs.get(file)?.mtimeMs === info.mtimeMs) continue;
    const running = await runningRows(file).catch(() => null);
    if (!running) continue;
    state.catalogs.set(file, { mtimeMs: info.mtimeMs, counts: new Map([[host, running]]) });
  }
}

/** held-turns.ts RESUME_PENDING_FRESH_MS: two job sweeps (chat-checkin.ts JOB_CLEANUP_EVERY_MS, 10 min) and a minute. */
const RESUME_PENDING_FRESH_MS = 2 * 10 * MINUTE + MINUTE;

/** held-turns.ts `readHeldTurns`: the cut step owners the last resume pass holds for a continue, by reason; null when the list is stale or absent. */
async function readResumePending(file: string, now: number): Promise<Map<string, number> | null> {
  const value = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;
  if (!isRecord(value) || typeof value.at !== "number" || now - value.at > RESUME_PENDING_FRESH_MS || !Array.isArray(value.runs)) return null;
  const reasons = new Map<string, number>();
  for (const run of value.runs) if (isRecord(run) && typeof run.session === "string") {
    const reason = typeof run.reason === "string" ? run.reason : "cut";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return reasons;
}

async function readUnloaded(state: State, file: string): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (!info) { state.unloaded = undefined; return; }
  if (state.unloaded?.mtimeMs === info.mtimeMs) return;
  const value = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as unknown;
  const times = isRecord(value) ? Object.values(value).flatMap(at => typeof at === "string" && Number.isFinite(Date.parse(at)) ? [Date.parse(at)] : []) : [];
  state.unloaded = { mtimeMs: info.mtimeMs, times };
}

const HOLD_SPAN = /waited \d+ min(?: or more \([^)]*\))?, (\d\d):(\d\d)Z to (\d\d):(\d\d)Z\./;
/** The UTC time `hh:mm` names at or before `at`. */
const clockBefore = (at: number, hours: number, minutes: number): number => {
  const day = new Date(at);
  let value = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes);
  if (value > at + MINUTE) value -= 24 * 60 * MINUTE;
  return value;
};

/**
 * The cut job holds of d7's last run and its metrics. The precheck finds cut jobs by walking every live chat's job folders, which took
 * 43 s and 18 CPU s on 10-19, so the feed takes them from the run's queue_hold slices: a cut job still in a cut_job slice was not
 * resumed, and holds on to now.
 */
export function d7Cuts(detail: unknown, runAt: number): { hold: Hold; open: boolean }[] {
  if (!isRecord(detail) || !Array.isArray(detail.flagged)) return [];
  const slices = detail.flagged.filter(isRecord);
  const cut = new Set(slices.filter(slice => slice.kind === "cut_job" && typeof slice.item === "string").map(slice => slice.item as string));
  return slices.flatMap(slice => {
    if (slice.kind !== "queue_hold" || typeof slice.item !== "string" || !slice.item.startsWith("cut job ") || typeof slice.excerpt !== "string") return [];
    const span = HOLD_SPAN.exec(slice.excerpt);
    if (!span) return [];
    const session = /\(([0-9a-f-]{36})\)$/.exec(slice.item)?.[1];
    const to = clockBefore(runAt, Number(span[3]), Number(span[4]));
    const from = Math.min(clockBefore(runAt, Number(span[1]), Number(span[2])), to);
    return [{ hold: { what: slice.item, from, to }, open: session !== undefined && cut.has(session) }];
  });
}

/** The Whole system duty's chat folder: the chat whose duties.json holds an active duty whose precheck runs whole-system.ts. */
async function findD7(dutiesDir: string): Promise<{ dir: string; id: string } | null> {
  for (const name of (await readdir(dutiesDir).catch(() => [] as string[])).filter(entry => /^[0-9a-f-]{36}\.json$/.test(entry))) {
    const value = JSON.parse(await readFile(join(dutiesDir, name), "utf8").catch(() => "null")) as unknown;
    const duties = isRecord(value) && Array.isArray(value.duties) ? value.duties.filter(isRecord) : [];
    const duty = duties.find(entry => entry.status === "active" && isRecord(entry.precheck) && Array.isArray(entry.precheck.command) &&
      entry.precheck.command.some(part => typeof part === "string" && part.endsWith("whole-system.ts")));
    if (duty && typeof duty.id === "string") return { dir: join(dutiesDir, name.slice(0, -".json".length)), id: duty.id };
  }
  return null;
}

/** How much of the chat's runs.jsonl end is read for d7's newest run: the duties of that chat wrote 1.5 MB by 10-19, about 1 KB a run. */
const RUNS_TAIL_BYTES = 256 * 1024;

async function readD7(state: State, dutiesDir: string): Promise<void> {
  if (!state.d7) {
    const found = await findD7(dutiesDir);
    if (!found) return;
    state.d7 = { runs: `${found.dir}.runs.jsonl`, id: found.id, mtimeMs: 0, at: 0, metrics: {}, cuts: [] };
  }
  const d7 = state.d7;
  const info = await stat(d7.runs).catch(() => null);
  if (!info || info.mtimeMs === d7.mtimeMs) return;
  const read = await readNew(d7.runs, undefined, RUNS_TAIL_BYTES);
  d7.mtimeMs = info.mtimeMs;
  const newest = (read?.lines ?? []).filter(line => line.includes(`"duty":"${d7.id}"`)).reverse().map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }).find((run): run is Record<string, unknown> => isRecord(run) && typeof run.at === "number" && typeof run.detail === "string");
  if (!newest || newest.at === d7.at) return;
  const detail = JSON.parse(await readFile(newest.detail as string, "utf8").catch(() => "null")) as unknown;
  if (!isRecord(detail) || !isRecord(detail.metrics)) return;
  const at = newest.at as number;
  state.d7 = { ...d7, at, cuts: d7Cuts(detail, at),
    metrics: Object.fromEntries(Object.entries(detail.metrics).filter((entry): entry is [string, number] => typeof entry[1] === "number")) };
}

// ---- d7's minute math (whole-system.ts `measure`) ----

export interface Minutes {
  clean: number; unknown: number; unwatched: number; held: number; freeSlot: number; cellWait: number; daemonFail: number; cpuBusy: number;
  harness: number; other: number; unattributed: number; offline: number; usable: number;
  perHost: Map<string, { usable: number; unusable: number; unknown: number; offline: number }>;
  queueHolds: number; cellHolds: number;
}

/** The last 30 whole minutes before `now`'s, judged as whole-system.ts `measure` judges them, from the inputs the feed keeps. */
export function judgeMinutes(input: { now: number; watch: readonly WatchLine[]; holds: readonly Hold[]; pool: readonly PoolHold[]; faults: readonly DaemonFault[];
  misses: readonly number[] }): Minutes {
  const { now } = input;
  const start = Math.floor(now / MINUTE) * MINUTE - WINDOW_MS;
  const queueHolds = input.holds.filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const poolHeld = input.pool.filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const poolAt = (from: number, to: number, cell: boolean) => poolHeld.find(hold => hold.cell === cell && hold.from + HOLD_MS < to && hold.to >= from);
  const heldAt = (at: number) => queueHolds.some(hold => hold.from + HOLD_MS <= at && hold.to >= at - MINUTE);
  const side = sideOf(input.watch);
  const out: Minutes = { clean: 0, unknown: 0, unwatched: 0, held: 0, freeSlot: 0, cellWait: 0, daemonFail: 0, cpuBusy: 0, harness: 0, other: 0, unattributed: 0,
    offline: 0, usable: 0, perHost: new Map(), queueHolds: queueHolds.length + poolHeld.filter(hold => !hold.cell).length, cellHolds: poolHeld.filter(hold => hold.cell).length };
  const hostCount = (name: string) => { const known = out.perHost.get(name) ?? { usable: 0, unusable: 0, unknown: 0, offline: 0 }; out.perHost.set(name, known); return known; };
  for (let minute = 0; minute < 30; minute++) {
    const from = start + minute * MINUTE, to = from + MINUTE;
    const line = input.watch.findLast(entry => { const at = Date.parse(entry.at); return at >= from && at < to; });
    let dirty = false, unknown = false;
    const sides = new Set<MinuteSide>();
    const offline = new Set<string>();
    if (!line) { out.unwatched++; unknown = true; }
    else for (const view of hostViews(line)) {
      const tally = hostCount(view.name);
      if (view.offline) { tally.offline++; offline.add(view.name); continue; }
      if (!view.usable && view.error === UNREAD_AT_STOP && usableAround(input.watch, view.name, from, to)) { tally.usable++; continue; }
      if (!view.usable) { tally.unknown++; unknown = true; continue; }
      const found = unusable(view.usable);
      const own = view.name === (line.host ?? UNNAMED_HOST);
      const slow = found.includes("cpu") ? harnessSlow({ box: view.name, own, latency: line.chat, from, to, misses: input.misses, faults: input.faults }) : [];
      const miss = found.filter(kind => kind !== "cpu" || slow.length > 0);
      if (found.includes("cpu") && !slow.length) out.cpuBusy++;
      if (!miss.length) { tally.usable++; continue; }
      tally.unusable++;
      dirty = true;
      sides.add(side(line, view));
    }
    if (line && !unknown && !sides.size) out.usable++;
    if (sides.has("harness")) out.harness++;
    else if (sides.has("unknown")) out.unattributed++;
    else if (sides.size) out.other++;
    if (heldAt(to)) { out.held++; dirty = true; }
    const waited = line && freeSlotWait(line);
    if (waited || poolAt(from, to, false)) { out.freeSlot++; dirty = true; }
    if (poolAt(from, to, true)) out.cellWait++;
    if (offline.size) out.offline++;
    if (input.faults.some(fault => fault.at >= from && fault.at < to && !offline.has(fault.host))) { out.daemonFail++; dirty = true; }
    if (dirty) continue;
    if (unknown) out.unknown++;
    else out.clean++;
  }
  return out;
}

// ---- the sidebar, each chat's agents and the tool calls (chat-catalog.ts `project`, client/organize.ts, chat-agents.ts, shared/turns.ts) ----

/** A thread the sidebar lists, with the fields client/organize.ts sorts and groups it by. */
type SidebarRow = Pick<SessionRow, "id" | "name" | "working" | "unread" | "archived" | "origin" | "priority" | "lastActivityAt" | "created" | "status" | "subagentsRunning"> & {
  chat?: true; schedule?: ThreadSchedule; pulse?: Pulse; failure?: string };
/** Small JSON files the chat service writes, read again only when their mtime or size changes. */
type JsonCache = Map<string, { key: string; value: unknown }>;
/** One live session file read from a saved offset: its open run, its tool calls still waiting for a result, and the line still being written. */
interface RunTail { offset: number; rest: Buffer; settled: boolean; runStart: number; open: Map<string, { tool: string; at: number }>; mtimeMs: number }
/** A tool call that got its result, at the result's time, with its run time in seconds when the result or its call names one. */
type ToolEvent = { at: number; tool: string; error: boolean; s: number | null };
interface SidebarState {
  json: JsonCache;
  /** fileOrigin's final answers by session file, and the not yet final ones with the row's write key then (thread-origin.ts `ThreadOrigins`). */
  origins: Map<string, ThreadOrigin>;
  undecided: Map<string, { key: string; origin: ThreadOrigin }>;
  listed: WeakMap<CopyRow, boolean>;
  byRow: WeakMap<CopyRow, ThreadOrigin>;
  /** Each row object's name and times as the sidebar shows them, built once: an unchanged copy keeps its row objects. */
  fixed: WeakMap<CopyRow, Pick<SidebarRow, "name" | "lastActivityAt" | "created">>;
  /** The merged rows and trees of the copies, kept until one of the copies' row lists changes. */
  merged?: { lists: readonly (readonly CopyRow[])[]; rows: ReturnType<typeof mergeCopies>; trees: ReturnType<typeof treesOf> };
  schedules: Map<string, { mtimeMs: number; schedule: ThreadSchedule | null }>;
  tails: Map<string, RunTail>;
  tools: ToolEvent[];
}

async function cachedJson(cache: JsonCache, file: string): Promise<unknown> {
  const info = await stat(file).catch(() => null);
  if (!info) { cache.delete(file); return null; }
  const key = `${info.size}:${info.mtimeMs}`;
  const known = cache.get(file);
  if (known?.key === key) return known.value;
  const value = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;
  cache.set(file, { key, value });
  return value;
}
const idsOf = (value: unknown): Set<string> => new Set(isRecord(value) && Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === "string") : []);

/** chat-catalog.ts `nativeStatus`. */
const nativeStatus = (row: CopyRow): string => row.roster ?? (!row.live ? "inactive" : row.activity === "working" || row.sessionActive ? "running" : "idle");
/** chat-catalog.ts `settledOnFailure` and `daemonSaysFailed`. */
const settledOnFailure = (row: CopyRow): boolean => row.taskState === "error" && Boolean(row.summary);
const daemonSaysFailed = (row: CopyRow): boolean => row.statusLabel === "failed" || row.workerState === "failed" || settledOnFailure(row);

/**
 * The catalog's rows (chat-catalog.ts `index`): the top-level rows of this box's copy and the other boxes' copies, one per session id, the one a
 * daemon runs over a saved one and this box's when both or neither do; every other row is a subagent row. `remote` holds the rows another box lists.
 */
export function mergeCopies(own: readonly CopyRow[], others: readonly (readonly CopyRow[])[]): { top: CopyRow[]; children: CopyRow[]; remote: Set<CopyRow> } {
  const ownIds = new Set(own.map(row => row.id));
  const top = new Map<string, CopyRow>();
  const children: CopyRow[] = [];
  const remote = new Set<CopyRow>();
  for (const [index, rows] of [own, ...others].entries()) for (const row of rows) {
    if (index > 0 && !ownIds.has(row.id)) remote.add(row);
    if (!row.topLevel) { children.push(row); continue; }
    const existing = top.get(row.id);
    if (!existing || (row.live && !existing.live)) top.set(row.id, row);
  }
  return { top: [...top.values()], children, remote };
}

/** chat-catalog.ts `childrenByParent` (one row per session id, a live one over a saved one) and `runningByParent`. */
function treesOf(children: readonly CopyRow[]): { all: Map<string, CopyRow[]>; running: Map<string, CopyRow[]> } {
  const byId = new Map<string, CopyRow>();
  for (const row of children) { const existing = byId.get(row.id); if (!existing || (!existing.live && row.live)) byId.set(row.id, row); }
  const all = new Map<string, CopyRow[]>(), running = new Map<string, CopyRow[]>();
  const add = (map: Map<string, CopyRow[]>, row: CopyRow) => { const list = map.get(row.parent!) ?? []; list.push(row); map.set(row.parent!, list); };
  for (const row of byId.values()) if (row.parent) add(all, row);
  for (const row of children) if (row.parent && nativeStatus(row) === "running") add(running, row);
  return { all, running };
}

/** chat-catalog.ts `subtreeOf`: running subagents at any depth and every subagent listed below the row. */
function subtreeOf(row: CopyRow, children: ReadonlyMap<string, CopyRow[]>): { running: number; total: number } {
  let running = 0, total = 0;
  const seen = new Set([row.id]);
  const pending = [...children.get(row.id) ?? []];
  for (let child = pending.pop(); child; child = pending.pop()) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    total++;
    if (nativeStatus(child) === "running") running++;
    pending.push(...children.get(child.id) ?? []);
  }
  return { running, total };
}

/**
 * chat-catalog.ts `pulseOf`: the row's freshness, its activity the latest of its own and of any running subagent below it. The catalog copy on
 * disk is written every few minutes (261 s old at 19:57Z on 10-19), so `written` adds the last write of a loaded session's file on this box.
 */
function pulseOf(row: CopyRow, running: ReadonlyMap<string, CopyRow[]>, written: (row: CopyRow) => number = () => 0): Pulse {
  let at = Math.max(row.activityAt, written(row));
  const seen = new Set([row.id]);
  const pending = [...running.get(row.id) ?? []];
  for (let child = pending.pop(); child; child = pending.pop()) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    at = Math.max(at, child.activityAt, written(child));
    pending.push(...running.get(child.id) ?? []);
  }
  return { streaming: row.streaming, tools: row.tools, bash: row.bash, children: row.runningChildren, ...at > 0 ? { activityAt: new Date(at).toISOString() } : {},
    ...row.summary ? { summary: row.summary } : {}, ...row.taskState !== null ? { summaryCurrent: true as const } : {}, ...row.heardAt ? { silentSince: row.heardAt } : {},
    ...row.statusLabel === "failed" || row.workerState === "failed" ? { failed: true } : {} };
}

/** chat-catalog.ts `parseSchedules` over one session's scheduled-jobs.json, the store the daemon's cron_list reads: active before paused, then the next run. */
export function scheduleOf(value: unknown): ThreadSchedule | null {
  let best: ThreadSchedule | null = null;
  for (const job of isRecord(value) && Array.isArray(value.jobs) ? value.jobs : []) {
    if (!isRecord(job) || (job.status !== "active" && job.status !== "paused")) continue;
    const schedule: ThreadSchedule = { kind: job.source === "heartbeat" || job.source === "rlm_heartbeat" ? "heartbeat" : "cron", status: job.status,
      expression: isRecord(job.schedule) && typeof job.schedule.expression === "string" ? job.schedule.expression : "", ...typeof job.nextRunAt === "string" ? { nextRunAt: job.nextRunAt } : {} };
    if (!best || (schedule.status === "active" && best.status === "paused") || (schedule.status === best.status && (schedule.nextRunAt ?? "~") < (best.nextRunAt ?? "~"))) best = schedule;
  }
  return best;
}

/** The schedule of each of this box's loaded top-level sessions: cron_list asks only the loaded workers of this box's daemon. */
async function readSchedules(state: SidebarState, artifacts: string, rows: readonly CopyRow[]): Promise<Map<string, ThreadSchedule>> {
  const out = new Map<string, ThreadSchedule>();
  const seen = new Set<string>();
  await Promise.all(rows.map(async row => {
    const file = join(artifacts, row.id, "scheduled-jobs.json");
    seen.add(file);
    const info = await stat(file).catch(() => null);
    if (!info) { state.schedules.delete(file); return; }
    let known = state.schedules.get(file);
    if (known?.mtimeMs !== info.mtimeMs) {
      known = { mtimeMs: info.mtimeMs, schedule: scheduleOf(JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown) };
      state.schedules.set(file, known);
    }
    if (known.schedule) out.set(row.id, known.schedule);
  }));
  for (const file of state.schedules.keys()) if (!seen.has(file)) state.schedules.delete(file);
  return out;
}

/**
 * thread-origin.ts `fileOrigin`, copied because thread-origin.ts has TS parameter properties: a session whose file names it (`session_info`)
 * before its first `session_state` or message was created named, by an agent's rlm.create_session. `final` is false while the head has neither.
 */
function fileOrigin(sessionFile: string): { origin: ThreadOrigin; final: boolean } {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch { return { origin: "user", final: false }; }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = "", offset = 0, named = false;
    while (offset < 4 * 1024 * 1024) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      offset += read;
      pending += chunk.toString("utf8", 0, read);
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const type = /^\{"type":"([a-z_]+)"/.exec(pending.slice(0, newline))?.[1];
        pending = pending.slice(newline + 1);
        if (type === "session_info") named = true;
        else if (type === "session_state" || type === "message") return { origin: named ? "agent" : "user", final: true };
      }
    }
    return { origin: named ? "agent" : "user", final: false };
  } finally { closeSync(fd); }
}

/** thread-origin.ts `ThreadOrigins.resolver`: a clean-room chat is an agent's, a thread the chat created or a chat is the person's, else its file's head decides. */
function originOf(state: SidebarState, row: CopyRow, created: ReadonlySet<string>, cleanRoom: ReadonlySet<string>, chats: ReadonlySet<string>): ThreadOrigin {
  if (cleanRoom.has(row.id)) return "agent";
  if (created.has(row.id) || chats.has(row.id) || !row.file) return "user";
  const read = state.byRow.get(row);
  if (read) return read;
  const origin = fileDecides(state, row, row.file);
  state.byRow.set(row, origin);
  return origin;
}
/** What the file said for each row object, so an unchanged row is not looked up by path again (thread-origin.ts `byRow` and `fileDecides`). */
function fileDecides(state: SidebarState, row: CopyRow, file: string): ThreadOrigin {
  const known = state.origins.get(file);
  if (known) return known;
  const key = `${row.activityAt}|${row.messages}`;
  const pending = state.undecided.get(file);
  if (pending?.key === key) return pending.origin;
  const { origin, final } = fileOrigin(file);
  if (final) { state.origins.set(file, origin); state.undecided.delete(file); }
  else state.undecided.set(file, { key, origin });
  return origin;
}

/** chat-catalog.ts `isListed`: another box's rows by its daemon's word, this box's saved rows only while their file is on disk. */
function listed(state: SidebarState, row: CopyRow, remote: boolean): boolean {
  if (row.live) return true;
  if (row.messages === 0 && !row.name?.trim()) return false;
  if (remote) return true;
  let known = state.listed.get(row);
  if (known === undefined) { known = row.file !== null && existsSync(row.file); state.listed.set(row, known); }
  return known;
}

// The session file's run and tool calls (shared/turns.ts: a user prompt or a waking custom message opens a run; an assistant reply that stops
// for anything but a tool call ends it; chat-projection.ts takes a tool's run time from its result's `details.durationMs`).
const PROMPT_TYPES = new Set(["agent_message", "heartbeat_prompt", "async_bash_completion", "goal_context", "rlm_child_terminal_notice", "rlm_child_failure", "prime-agent.update_restart"]);
const ASSISTANT = Buffer.from('"role":"assistant"');
const STOP = /"stopReason":"(\w+)"/;

/** Folds one session file line into its tail, and a tool result into `events`. */
export function foldRunLine(tail: RunTail, line: string, events: ToolEvent[]): void {
  const role = line.includes('"role":"toolResult"') ? "toolResult" : line.includes('"role":"assistant"') ? "assistant" : line.includes('"role":"user"') ? "user"
    : line.startsWith('{"type":"custom_message"') ? "custom" : null;
  if (!role) return;
  let entry: { type?: unknown; customType?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
  try { entry = JSON.parse(line) as typeof entry; } catch { return; }
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  const message = isRecord(entry.message) ? entry.message : null;
  if (role === "custom") {
    if (entry.type === "custom_message" && typeof entry.customType === "string" && PROMPT_TYPES.has(entry.customType) && tail.settled && Number.isFinite(at)) { tail.settled = false; tail.runStart = at; }
    return;
  }
  if (entry.type !== "message" || !message || message.role !== role) return;
  if (role === "user") { if (tail.settled && Number.isFinite(at)) { tail.settled = false; tail.runStart = at; } return; }
  if (role === "assistant") {
    for (const part of Array.isArray(message.content) ? message.content : [])
      if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") tail.open.set(part.id, { tool: typeof part.name === "string" ? part.name : "unknown", at });
    if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") { tail.settled = true; tail.open.clear(); }
    return;
  }
  const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
  const call = tail.open.get(id);
  tail.open.delete(id);
  const end = typeof message.timestamp === "number" ? message.timestamp : at;
  const ms = isRecord(message.details) && typeof message.details.durationMs === "number" ? message.details.durationMs : call && Number.isFinite(call.at) ? end - call.at : null;
  if (Number.isFinite(end)) events.push({ at: end, tool: typeof message.toolName === "string" ? message.toolName : call?.tool ?? "unknown", error: message.isError === true,
    s: ms === null || !Number.isFinite(ms) ? null : Math.max(0, ms) / 1000 });
}

/**
 * The tail of a session file first seen: its lines are read back from the end, 1 MiB at a time, to the last assistant reply that ended a run,
 * so the read covers only the open run and a settled file costs one chunk. The lines then fold forward, and later rounds read from the end.
 */
export async function firstRunTail(file: string, events: ToolEvent[]): Promise<RunTail | null> {
  let handle;
  try { handle = await open(file, "r"); } catch { return null; }
  try {
    const { size } = await handle.stat();
    const { mtimeMs } = await handle.stat();
    const tail: RunTail = { offset: size, rest: Buffer.alloc(0), settled: true, runStart: 0, open: new Map(), mtimeMs };
    const lines: Buffer[] = [];
    let end = size, carry = Buffer.alloc(0), first = true, found = false;
    while (end > 0 && !found) {
      const from = Math.max(0, end - (1 << 20));
      const chunk = Buffer.alloc(end - from);
      await handle.read(chunk, 0, chunk.length, from);
      let bytes = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      if (first) {
        const last = bytes.lastIndexOf(10);
        tail.rest = Buffer.from(bytes.subarray(last + 1));
        bytes = bytes.subarray(0, last + 1);
        first = false;
      }
      let stop = bytes.length;
      // Buffer.lastIndexOf counts a negative offset from the end, so a line that starts the buffer is looked for only while 2 bytes remain.
      for (;;) {
        const newline = stop >= 2 ? bytes.lastIndexOf(10, stop - 2) : -1;
        if (newline < 0 && from > 0) { carry = Buffer.from(bytes.subarray(0, stop)); break; }
        const line = bytes.subarray(newline + 1, stop);
        stop = newline + 1;
        if (line.length > 1) {
          lines.push(line);
          if (line.includes(ASSISTANT)) {
            const reason = STOP.exec(line.subarray(line.lastIndexOf('"stopReason":"')).toString("utf8"))?.[1];
            if (reason && reason !== "toolUse") { found = true; break; }
          }
        }
        if (newline < 0) break;
      }
      end = from;
    }
    for (const line of lines.reverse()) foldRunLine(tail, line.toString("utf8").trimEnd(), events);
    return tail;
  } finally { await handle.close(); }
}

/** Reads the new lines of every live session file on this box, and drops the tails of sessions that are no longer loaded. */
async function readRuns(state: SidebarState, rows: readonly CopyRow[], now: number): Promise<void> {
  const files = new Set<string>();
  await Promise.all(rows.map(async row => {
    if (!row.file || files.has(row.file)) return;
    files.add(row.file);
    const known = state.tails.get(row.file);
    if (!known) { const tail = await firstRunTail(row.file, state.tools); if (tail) state.tails.set(row.file, tail); return; }
    const info = await stat(row.file).catch(() => null);
    if (!info) { state.tails.delete(row.file); return; }
    known.mtimeMs = info.mtimeMs;
    if (info.size === known.offset) return;
    const read = await readNew(row.file, { offset: known.offset, rest: known.rest }, 0);
    if (!read) { state.tails.delete(row.file); return; }
    if (read.tail.offset < known.offset) { known.settled = true; known.open.clear(); }
    known.offset = read.tail.offset;
    known.rest = read.tail.rest;
    for (const line of read.lines) foldRunLine(known, line, state.tools);
  }));
  for (const file of state.tails.keys()) if (!files.has(file)) state.tails.delete(file);
  state.tools = state.tools.filter(event => event.at >= now - WINDOW_MS);
}

/** chat-agents.ts `Shown`, as far as the feed reads it: whether the agent works or failed, whether it ended, and its last activity. */
type AgentShown = { working: boolean; failed: boolean; ended: boolean; at: number };
const OPEN_STEP = new Set(["todo", "doing", "blocked"]);

/**
 * chat-agents.ts `chatAgents` for one chat, from the files: its subagent sessions (one per RLM child id), the roots the job registry lists under
 * it, and the owners of its open plan steps. The hub's child snapshots and the chat's transcript (roots it named only there, and the threads it
 * messaged) are the chat service's memory, so they are left out.
 */
export function chatAgentsOf(input: { self: CopyRow; name: string; children: readonly CopyRow[]; tree: ReadonlyMap<string, CopyRow[]>; roots: readonly string[];
  plan: readonly PlanItem[]; rowOf: (who: string) => SidebarRow | undefined }): AgentShown[] {
  const agents: AgentShown[] = [];
  const sessions = new Set<string>();
  const childIds = new Set<string>();
  for (const row of input.children) {
    if (row.childId && childIds.has(row.childId)) continue;
    if (row.childId) childIds.add(row.childId);
    sessions.add(row.id);
    const running = nativeStatus(row) === "running";
    agents.push({ working: running || subtreeOf(row, input.tree).running > 0 || row.runningChildren, failed: !running && daemonSaysFailed(row), ended: !running, at: row.activityAt });
  }
  const thread = (row: SidebarRow | undefined) => {
    if (!row || row.id === input.self.id || sessions.has(row.id)) return;
    sessions.add(row.id);
    agents.push({ working: row.working || row.subagentsRunning > 0, failed: !row.working && Boolean(row.failure), ended: false, at: Date.parse(row.lastActivityAt ?? row.created ?? "") || 0 });
  };
  for (const root of input.roots) thread(input.rowOf(root));
  const walk = (items: readonly PlanItem[]) => { for (const item of items) {
    const owners = OPEN_STEP.has(item.status) ? [item.sessionId, stepOwner(item)].filter((who): who is string => who !== undefined) : [];
    if (owners.length && !owners.some(who => who === input.self.id || who === input.name)) thread(owners.map(input.rowOf).find(Boolean));
    walk(item.children ?? []);
  } };
  walk(input.plan);
  return agents;
}

const PULSE_LEVEL: Record<PulseLevel, number> = { live: 1, quiet: 2, stalled: 3, failed: 4 };

/** The sidebar's sections and pulses, each chat's subagents, agents and open turn, and the tool calls of every live session on this box. */
async function sidebarSamples(ctx: Context, state: SidebarState, dataDir: string, mirror: string): Promise<Sample[]> {
  const { now } = ctx;
  const others = (await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json"));
  const [own, ...rest] = await Promise.all([copyIndex(join(dataDir, "session-copy.json")), ...others.map(name => copyIndex(join(mirror, name)))]);
  if (!own!.length && !rest.some(rows => rows.length)) return [];
  const json = (name: string) => cachedJson(state.json, join(dataDir, name));
  const [chatsValue, threadsValue, cleanValue, archivedValue, readValue, jobsValue] = await Promise.all(
    ["chats.json", "threads.json", "clean-room-chats.json", "archived-chats.json", "read-state.json", "chat-jobs.json"].map(json));
  const chats = idsOf(chatsValue), created = idsOf(threadsValue), cleanRoom = idsOf(cleanValue), archivedByOwner = idsOf(archivedValue);
  const baseline = isRecord(readValue) && typeof readValue.baseline === "number" ? readValue.baseline : 0;
  const marks = isRecord(readValue) && isRecord(readValue.sessions) ? readValue.sessions : {};
  const lists = [own!, ...rest];
  if (!state.merged || state.merged.lists.length !== lists.length || state.merged.lists.some((list, index) => list !== lists[index])) {
    const rows = mergeCopies(own!, rest);
    state.merged = { lists, rows, trees: treesOf(rows.children) };
  }
  const { rows: { top, remote }, trees } = state.merged;
  const ownLive = own!.filter(row => row.live);
  const [schedules] = await Promise.all([readSchedules(state, join(ctx.home, ".prime/agent/session-artifacts"), ownLive.filter(row => row.topLevel)), readRuns(state, ownLive, now)]);
  const written = (row: CopyRow): number => row.file && !remote.has(row) ? state.tails.get(row.file)?.mtimeMs ?? 0 : 0;

  const rows: SidebarRow[] = [];
  const copyOf = new Map<string, CopyRow>();
  for (const row of top) {
    if (!listed(state, row, remote.has(row))) continue;
    const subtree = subtreeOf(row, trees.all);
    const running = nativeStatus(row) === "running";
    const working = row.live && (running || row.runningChildren || subtree.running > 0);
    const chat = chats.has(row.id);
    const mark = isRecord(marks[row.id]) && typeof (marks[row.id] as Record<string, unknown>).timestamp === "number" ? (marks[row.id] as { timestamp: number }).timestamp : 0;
    const schedule = remote.has(row) ? undefined : schedules.get(row.id);
    let fixed = state.fixed.get(row);
    if (!fixed) {
      fixed = { name: row.name?.replace(/\s+/g, " ").trim() || row.id.slice(0, 8), ...row.activityAt ? { lastActivityAt: new Date(row.activityAt).toISOString() } : {},
        ...row.created ? { created: new Date(row.created).toISOString() } : {} };
      state.fixed.set(row, fixed);
    }
    rows.push({ id: row.id, ...fixed, working, archived: row.lifecycle === "archived" || archivedByOwner.has(row.id),
      unread: (chat || !working) && row.messages > 0 && row.activityAt > Math.max(baseline, mark), origin: originOf(state, row, created, cleanRoom, chats), priority: 0,
      status: !row.live ? "saved" : running ? "running" : "idle", subagentsRunning: Math.max(subtree.running, row.runningChildren ? 1 : 0),
      ...chat ? { chat: true as const } : {}, ...schedule ? { schedule } : {}, ...working ? { pulse: pulseOf(row, trees.running, written) } : {},
      ...!running && settledOnFailure(row) ? { failure: row.summary! } : {} });
    copyOf.set(row.id, row);
  }
  rows.sort((left, right) => copyOf.get(right.id)!.activityAt - copyOf.get(left.id)!.activityAt);
  const out: Sample[] = [];
  const shown = rows.filter(row => inSidebar(row as SessionRow, { archived: false, agentCreated: false })) as SessionRow[];
  const sections = sidebarSections(shown, "current", "grouped");
  const help = "Threads the sidebar lists by section (chats, heartbeats, other threads) and bucket (needs response, working, idle), archived and agent-created ones hidden (client/organize.ts).";
  for (const [section, list] of [["chats", sections.chats], ["heartbeats", sections.beats], ["threads", sections.groups.flatMap(group => group.rows)]] as const)
    for (const bucket of BUCKETS) out.push(gauge("harness.chat.sidebar_rows", help, list.filter(row => bucketOf(row) === bucket).length, { section, bucket }));
  const levels = new Map<PulseLevel, number>([["live", 0], ["quiet", 0], ["stalled", 0], ["failed", 0]]);
  for (const row of shown) if (row.working && row.pulse) { const level = readPulse(row.pulse, now).level; levels.set(level, levels.get(level)! + 1); }
  for (const [level, value] of levels) out.push(gauge("harness.chat.pulse_rows", "Working threads in the sidebar by their pulse: live, quiet after 1 min, stalled after 5 min or a silent worker, or failed (shared/pulse.ts).", value, { level }));

  // Each listed chat: its pulse, subagents, agents and open turn.
  const byId = new Map<string, SidebarRow>(), byName = new Map<string, SidebarRow>();
  for (const row of rows) { if (!byId.has(row.id)) byId.set(row.id, row); if (!byName.has(row.name)) byName.set(row.name, row); }
  const rowOf = (who: string) => byId.get(who) ?? byName.get(who);
  const jobs = isRecord(jobsValue) && isRecord(jobsValue.jobs) ? Object.entries(jobsValue.jobs).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) : [];
  let longestTurn = 0;
  for (const tail of state.tails.values()) if (!tail.settled && tail.runStart) longestTurn = Math.max(longestTurn, now - tail.runStart);
  for (const chat of sections.chats) {
    const copy = copyOf.get(chat.id)!;
    const labels = { chat: chat.name };
    const reading = chat.working && chat.pulse ? readPulse(chat.pulse, now) : null;
    out.push(gauge("harness.chat.chat_pulse", "The chat's pulse in the sidebar: 0 not working, 1 live, 2 quiet, 3 stalled, 4 failed (shared/pulse.ts readPulse).", reading ? PULSE_LEVEL[reading.level] : 0, labels));
    if (reading) out.push(gauge("harness.chat.chat_quiet", "How long a working chat and its running subagents have gone without activity (shared/pulse.ts quietMs).", reading.quietMs / 1000, labels, "s"));
    const direct = (trees.all.get(chat.id) ?? []).filter(row => row.childId);
    const status = { running: 0, failed: 0, done: 0 };
    let longestRun = 0;
    for (const row of direct) {
      const running = nativeStatus(row) === "running";
      status[running ? "running" : daemonSaysFailed(row) ? "failed" : "done"]++;
      if (running && row.created) longestRun = Math.max(longestRun, now - row.created);
    }
    for (const [key, value] of Object.entries(status)) out.push(gauge("harness.chat.chat_subagents", "The chat's own subagents by state, as its Subagents list groups them: running, failed or done (chat-catalog.ts rosterChildren).", value, { ...labels, status: key }));
    out.push(gauge("harness.chat.chat_subagent_run_longest", "How long the chat's longest running subagent has run since it was created.", longestRun / 1000, labels, "s"));
    const subtree = subtreeOf(copy, trees.all);
    out.push(gauge("harness.chat.chat_subtree", "Subagents at any depth below the chat, running and listed in all, as the sidebar and the thread header count them (chat-catalog.ts subtreeOf).", subtree.running, { ...labels, kind: "running" }),
      gauge("harness.chat.chat_subtree", "Subagents at any depth below the chat, running and listed in all, as the sidebar and the thread header count them (chat-catalog.ts subtreeOf).", subtree.total, { ...labels, kind: "total" }));
    const board = await cachedJson(state.json, join(dataDir, "boards", `${chat.id}.json`));
    const agents = chatAgentsOf({ self: copy, name: chat.name, children: trees.all.get(chat.id) ?? [], tree: trees.all,
      roots: jobs.filter(([, entry]) => entry.chat === chat.name || entry.chat === chat.id || entry.chatId === chat.id).map(([key]) => key),
      plan: isRecord(board) && Array.isArray(board.plan) ? board.plan as PlanItem[] : [], rowOf });
    const states = { working: 0, failed: 0, done: 0, idle: 0 };
    for (const agent of agents) states[agent.working ? "working" : agent.failed ? "failed" : agent.ended ? "done" : "idle"]++;
    for (const [key, value] of Object.entries(states)) out.push(gauge("harness.chat.chat_agents", "The chat's agents on its board's Agents card and under its sidebar row, by state: its subagents, the roots it started and its open steps' owners (chat-agents.ts).", value, { ...labels, state: key }));
    const ages = agents.filter(agent => agent.at > 0).map(agent => ({ working: agent.working, age: Math.max(0, now - agent.at) / 1000 }));
    if (ages.length) out.push(gauge("harness.chat.chat_agent_age", "Seconds since the chat's most recent agent activity (newest), and since the quietest working agent's (quietest_working), as the sidebar ages its jobs.", Math.min(...ages.map(age => age.age)), { ...labels, kind: "newest" }, "s"));
    const working = ages.filter(age => age.working);
    if (working.length) out.push(gauge("harness.chat.chat_agent_age", "Seconds since the chat's most recent agent activity (newest), and since the quietest working agent's (quietest_working), as the sidebar ages its jobs.", Math.max(...working.map(age => age.age)), { ...labels, kind: "quietest_working" }, "s"));
    const tail = copy.file && !remote.has(copy) ? state.tails.get(copy.file) : undefined;
    out.push(gauge("harness.chat.turn_run", "How long the chat's own open run has gone since the prompt or message that started it; 0 when it is not running (shared/turns.ts).",
      tail && !tail.settled && tail.runStart ? (now - tail.runStart) / 1000 : 0, labels, "s"));
  }
  out.push(gauge("harness.chat.turn_run_longest", "The longest open run of any loaded session on the chat's box, since the prompt or message that started it.", longestTurn / 1000, undefined, "s"));

  // Tool calls of the last 30 minutes and the ones running now, by tool.
  const byTool = new Map<string, { calls: number; errors: number; seconds: number; slowest: number; running: number; longest: number }>();
  const toolOf = (tool: string) => { let known = byTool.get(tool); if (!known) { known = { calls: 0, errors: 0, seconds: 0, slowest: 0, running: 0, longest: 0 }; byTool.set(tool, known); } return known; };
  for (const event of state.tools) {
    if (event.at < now - WINDOW_MS) continue;
    const tool = toolOf(event.tool);
    tool.calls++;
    if (event.error) tool.errors++;
    if (event.s !== null) { tool.seconds += event.s; tool.slowest = Math.max(tool.slowest, event.s); }
  }
  for (const tail of state.tails.values()) for (const call of tail.open.values()) {
    const tool = toolOf(call.tool);
    tool.running++;
    if (Number.isFinite(call.at)) tool.longest = Math.max(tool.longest, (now - call.at) / 1000);
  }
  for (const [tool, value] of byTool) {
    const labels = { tool };
    out.push(gauge("harness.chat.tool_calls_30", "Tool calls of the loaded sessions on the chat's box that returned in the last 30 minutes, by tool.", value.calls, labels),
      gauge("harness.chat.tool_errors_30", "Tool calls that returned an error in the last 30 minutes, by tool (the work row's red mark).", value.errors, labels),
      gauge("harness.chat.tool_time_30", "Seconds the tool calls of the last 30 minutes ran in all, by tool, so time over calls is the mean (shared/turns.ts toolDurationMs).", value.seconds, labels, "s"),
      gauge("harness.chat.tool_slowest_30", "The slowest tool call of the last 30 minutes, by tool.", value.slowest, labels, "s"),
      gauge("harness.chat.tools_running", "Tool calls running now in the loaded sessions on the chat's box, by tool.", value.running, labels),
      gauge("harness.chat.tool_running_longest", "How long the longest tool call running now has run, by tool.", value.longest, labels, "s"));
  }
  return out;
}

// ---- samples ----

const gauge = (name: string, help: string, value: number, labels?: Record<string, string>, unit?: Sample["unit"]): Sample =>
  ({ name, kind: "gauge", help, value, ...unit ? { unit } : {}, ...labels ? { labels } : {} });

/** The newest watch line's numbers for each box: Settings > Hosts' Agent sessions and their states, the usable reading and the worker footprint. */
export function boxSamples(line: WatchLine): Sample[] {
  const out: Sample[] = [];
  const views = hostViews(line);
  const sessions = [{ name: line.host ?? UNNAMED_HOST, live: line.live, working: line.working }, ...(line.hosts ?? []).filter(host => !host.error).map(host => ({ name: host.name, live: host.live, working: host.working }))];
  for (const view of views) {
    const host = { host: view.name };
    const agents = view.agents;
    if (agents) {
      for (const state of ["working", "children", "retry", "idle", "hung"] as const)
        out.push(gauge("harness.chat.agents", "Loaded Prime sessions on the box by state, as Settings > Hosts counts them (agent-states.ts).", agents[state] ?? 0, { ...host, state }));
      if (agents.gb !== null) out.push(gauge("harness.chat.agent_memory", "What Settings > Hosts shows as Agent sessions on the box, in RAM or swap.", agents.gb * GIB, host, "By"));
      if (agents.swapGb !== undefined) out.push(gauge("harness.chat.agent_swap", "The part of the box's Agent sessions memory that sits in swap.", agents.swapGb * GIB, host, "By"));
      if (agents.cacheGb !== undefined) out.push(gauge("harness.chat.file_cache", "The box's file cache beside its Agent sessions, as Settings > Hosts shows it.", agents.cacheGb * GIB, host, "By"));
    }
    if (!view.error) {
      out.push(gauge("harness.chat.workers", "Prime worker processes on the box.", view.workers, host),
        gauge("harness.chat.worker_memory", "The Prime workers' footprint on the box, their sessions' kernels included.", view.workerGb * GIB, host, "By"));
    }
    if (view.offline) out.push(gauge("harness.chat.box_offline", "1 when Tailscale read the box offline in the watch's last minute.", 1, host));
    const usable = view.usable;
    if (usable) {
      out.push(gauge("harness.chat.box_usable", "1 when the box read usable in the watch's last minute by d7's rule, 0 when it did not.", unusable(usable).length ? 0 : 1, host));
      const kinds: [string, number | null | undefined][] = isLinuxReading(usable)
        ? [["mem_full_avg10", usable.memFullAvg10], ["mem_some_avg10", usable.memSomeAvg10], ["cpu_some_avg10", usable.cpuSomeAvg10], ["runnable_per_core", usable.runnablePerCore], ["swapouts_per_s", usable.swapoutsPerS]]
        : [["pressure_level", usable.pressureLevel], ["swapouts_per_s", usable.swapoutsPerS], ["kernel_task_pct", usable.kernelTaskPct]];
      for (const [kind, value] of kinds) if (typeof value === "number") out.push(gauge("harness.chat.usable_reading", "The box's usable reading in the watch's last minute: Linux memory and CPU stall and runnable tasks a core, or the Mac's pressure feed.", value, { ...host, kind }));
    }
    if (view.testBrowsers) out.push(gauge("harness.chat.test_browsers", "Playwright or Puppeteer browsers agents ran on the box in the watch's last minute.", view.testBrowsers.length, host));
  }
  for (const box of sessions) {
    out.push(gauge("harness.chat.sessions", "Live Prime sessions on the box and those the daemon reads working, from the watch's last minute.", box.live, { host: box.name, kind: "live" }),
      gauge("harness.chat.sessions", "Live Prime sessions on the box and those the daemon reads working, from the watch's last minute.", box.working, { host: box.name, kind: "working" }));
  }
  (line.trees ?? []).forEach((tree, index) => out.push(gauge("harness.chat.tree_memory", "The 5 chat trees with the largest footprint on the chat's box, their kernels and orphans, by rank.", tree.gb * GIB,
    { rank: String(index + 1), chat: tree.tree }, "By")));
  if (line.serviceGb !== undefined) out.push(gauge("harness.chat.service_memory", "The chat service's own resident memory.", line.serviceGb * GIB, undefined, "By"));
  if (line.chat) out.push(gauge("harness.chat.read_max", "The slowest page or API read the chat service answered in the watch's last minute (chat-latency.ts).", line.chat.readMs / 1000, undefined, "s"),
    gauge("harness.chat.loop_stall_max", "The chat service's longest event loop stall in the watch's last minute (chat-latency.ts).", line.chat.loopMs / 1000, undefined, "s"));
  out.push(gauge("harness.chat.watch_cpu", "CPU the usable watch's last sample cost the chat service and its footprint helper.", line.cpuMs / 1000, undefined, "s"));
  return out;
}

export async function read(ctx: Context): Promise<Sample[]> {
  if (!ctx.chatHost) return [];
  const state = (ctx.state.get("chat-health") ?? { sidebar: { json: new Map(), origins: new Map(), undecided: new Map(), listed: new WeakMap(), byRow: new WeakMap(), fixed: new WeakMap(), schedules: new Map(), tails: new Map(), tools: [] },
    watch: new Map(), lines: [], serviceStamp: "", holdLines: [], serviceFaults: [], reopened: [], opens: [], starts: [],
    poolLines: [], daemon: new Map(), supervisorLines: [], catalogs: new Map() }) as State;
  ctx.state.set("chat-health", state);
  const { now } = ctx;
  const dataDir = join(ctx.home, ".prime/agent/browser-chat");
  const quietMs = quietMinutes(dataDir) * MINUTE;
  await readWatchLines(state, join(dataDir, "mac-usable"), now, Math.max(2 * WINDOW_MS, WINDOW_MS + quietMs + 2 * MINUTE));
  const latest = state.lines.at(-1);
  const box = latest?.host ?? ctx.host;
  const [pending, sidebar] = await Promise.all([
    readResumePending(join(dataDir, "resume-pending.json"), now),
    sidebarSamples(ctx, state.sidebar, dataDir, join(ctx.home, ".cache/sieun-pi/hosts")),
    readService(state, join(dataDir, "service.log"), box, now),
    readPool(state, join(process.env.PI_POOL_DIR || join(ctx.home, ".config", "pi-pool"), "pi-pool.log"), now),
    readDaemonLogs(state, join(ctx.home, ".prime/agent/logs"), now),
    readCatalogs(state, dataDir, join(ctx.home, ".cache/sieun-pi/hosts"), box),
    readUnloaded(state, join(dataDir, "unloaded.json")),
    readD7(state, join(dataDir, "duties")),
  ]);
  const since = now - WINDOW_MS - 2 * MINUTE;
  const supervisor = state.supervisorLines.map(line => line.value);
  const faults = [...state.serviceFaults, ...readSupervisorFaults(supervisor, box, state.reopened)].filter(fault => fault.at >= since);
  const misses = workerMisses(supervisor).filter(at => at >= since);
  const cuts = (state.d7?.cuts ?? []).map(({ hold, open }) => open ? { ...hold, to: Math.max(hold.to, now) } : hold);
  const minutes = judgeMinutes({ now, watch: state.lines, holds: [...readServiceHolds(state.holdLines.map(line => line.value)), ...cuts],
    pool: readPoolLog(state.poolLines.map(line => line.value), now), faults, misses });

  const help30 = "Minutes of the last 30 by d7's Whole system rule (whole-system.ts measure): clean, dirty for each cause, unknown, unwatched and offline.";
  const out: Sample[] = [...sidebar];
  const kinds: [string, number][] = [["clean", minutes.clean], ["unknown", minutes.unknown], ["unwatched", minutes.unwatched], ["usable", minutes.usable], ["held", minutes.held],
    ["free_slot", minutes.freeSlot], ["cell_wait", minutes.cellWait], ["daemon_fail", minutes.daemonFail], ["cpu_busy", minutes.cpuBusy], ["harness_unusable", minutes.harness],
    ["other_unusable", minutes.other], ["unattributed_unusable", minutes.unattributed], ["offline", minutes.offline]];
  for (const [kind, value] of kinds) out.push(gauge("harness.chat.minutes_30", help30, value, { kind }));
  for (const [host, tally] of minutes.perHost) for (const [state_, value] of Object.entries(tally))
    out.push(gauge("harness.chat.box_minutes_30", "Minutes of the last 30 each box read usable, unusable, unknown or offline in the watch.", value, { host, state: state_ }));
  const start = Math.floor(now / MINUTE) * MINUTE - WINDOW_MS;
  out.push(gauge("harness.chat.queue_holds_30", "Starts, wakes, cut jobs and pi-pool refusals that waited over 10 minutes and touched the last 30 (d7 queue_holds_30).", minutes.queueHolds),
    gauge("harness.chat.cell_holds_30", "Trees that waited over 10 minutes for a pi-pool cell at R4's pace in the last 30 (d7 cell_holds_30).", minutes.cellHolds),
    gauge("harness.chat.cut_jobs_held", "Cut jobs held over 10 minutes with no input since, from d7's last run.", cuts.filter(hold => hold.to >= now && now - hold.from > HOLD_MS).length),
    gauge("harness.chat.daemon_faults_30", "Opens, status reads, sends and worker starts that failed or ran over 30 s in the last 30 minutes (daemon-faults.ts).",
      faults.filter(fault => fault.at >= start).length),
    gauge("harness.chat.worker_poll_misses_30", "Supervisor polls of a Prime worker that went unanswered in the last 30 minutes (harness-slow.ts workerMisses).", misses.filter(at => at >= start).length));
  const quiet = quietAgents(state.lines, start, start + WINDOW_MS + MINUTE, quietMs);
  const hosts = new Set(latest ? hostViews(latest).map(view => view.name) : []);
  for (const host of hosts) {
    const own = quiet.filter(minute => minute.host === host);
    out.push(gauge("harness.chat.quiet_minutes_30", "Box minutes of the last 30 that sat past the quiet window with no session working (d7 quiet_agents).", own.length, { host }));
    // A box with no quiet minute sends 0, so the headline panel has a value for every box.
    out.push(gauge("harness.chat.quiet_agent_memory", "The most Agent sessions memory the box held in a minute past the quiet window with nobody working (d7 quiet_agent_gb); 0 when no minute was quiet.",
      Math.max(0, ...own.map(minute => minute.gb)) * GIB, { host }, "By"));
  }
  out.push(gauge("harness.chat.quiet_window", "The quiet window after which Agent sessions should drop under 5 GB (quiet-minutes.ts).", quietMs / 1000, undefined, "s"));
  if (latest) {
    out.push(gauge("harness.chat.watch_age", "Seconds since the usable watch's newest line.", (now - Date.parse(latest.at)) / 1000, undefined, "s"), ...boxSamples(latest));
    const judged = state.lines.findLast(line => Date.parse(line.at) >= start && line.agents?.hung !== undefined);
    if (judged) out.push(gauge("harness.chat.hung_calls", "Tool calls that wrote nothing for an hour with no progress, or a kernel burning CPU, in the newest judged watch line (d7 hung_calls).", judged.hung?.length ?? 0));
    const window = state.lines.filter(line => Date.parse(line.at) >= start);
    out.push(gauge("harness.chat.slow_minutes_30", "Watch minutes of the last 30 where the chat answered a read, or its event loop stalled, over 1 s (harness-slow.ts SLOW_READ_MS).",
      window.filter(line => (line.chat?.readMs ?? 0) > 1000).length, { kind: "read" }),
    gauge("harness.chat.slow_minutes_30", "Watch minutes of the last 30 where the chat answered a read, or its event loop stalled, over 1 s (harness-slow.ts SLOW_READ_MS).",
      window.filter(line => (line.chat?.loopMs ?? 0) > 1000).length, { kind: "loop" }));
  }
  for (const { counts } of state.catalogs.values()) for (const [host, running] of counts) for (const kind of ["thread", "subagent"] as const)
    out.push(gauge("harness.chat.active_agents", "Sessions running a turn, as the sidebar's Agents line counts them (active-agents.ts): threads and subagents at any depth.", running[kind], { host, kind }));
  if (state.unloaded) out.push(gauge("harness.chat.unloaded_30", "Sessions the idle unload stopped in the last 30 minutes (unloaded.json).", state.unloaded.times.filter(at => at >= now - WINDOW_MS).length));
  for (const [reason, value] of pending ?? []) out.push(gauge("harness.chat.resume_pending", "Cut step owners the chat's last resume pass holds for a continue, by why they stopped (held-turns.ts).", value, { reason }));
  const opens = state.opens.filter(entry => entry.at >= now - LATENCY_MS);
  out.push(gauge("harness.chat.opens_5m", "Chat opens the service logged in the last 5 minutes.", opens.length));
  if (opens.length) out.push(gauge("harness.chat.open_slowest", "The slowest chat open (attach and first page) the service logged in the last 5 minutes.", Math.max(...opens.map(entry => entry.value)), undefined, "s"));
  for (const kind of ["create", "resume", "reload"]) {
    const starts = state.starts.filter(entry => entry.value.kind === kind && entry.at >= now - LATENCY_MS);
    out.push(gauge("harness.chat.worker_starts_5m", "Daemon creates, resumes and reloads the service saw answered in the last 5 minutes.", starts.length, { kind }));
    if (starts.length) out.push(gauge("harness.chat.worker_start_slowest", "The slowest daemon create, resume or reload answered in the last 5 minutes.", Math.max(...starts.map(entry => entry.value.s)), { kind }, "s"));
  }
  if (state.d7?.at) {
    out.push(gauge("harness.chat.d7_age", "Seconds since the Whole system duty's (d7) last precheck run.", (now - state.d7.at) / 1000, undefined, "s"));
    for (const key of ["clean_min_30", "queue_holds_30", "cell_holds_30", "hung_calls", "quiet_agent_gb", "cut_jobs_held", "mac_test_browsers", "oversized_procs", "slot_wait_timeouts_30", "stray_servers_30"])
      if (key in state.d7.metrics) out.push(gauge("harness.chat.d7_metric", "The Whole system duty's (d7) own numbers from its last precheck run, to check the feed's live ones against.", state.d7.metrics[key]!, { key }));
  }
  return out;
}
