import { hostExecFile } from "./spawn-host.ts";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessSplit, RigLine } from "../../../../components/prime-relay/rig-cpu.ts";
import { type ChatLatency, takeLatency } from "./chat-latency.ts";
import { type PeerReach, seenAgo } from "./host-reach.ts";
import { listOrphanServices, type OrphanServiceLine } from "./orphan-services.ts";
import { bounded } from "../../../../components/prime-relay/kernel-read.ts";
import { CPU_SIDES, type CpuSides, FEED_FRESH_MS, PRESSURE_FEED, groupOf, linuxUsable, type LinuxUsable, type MemoryGroup, memoryByGroup, type SchedstatMark, schedstatMark, seedSchedstat } from "../../../../components/prime-relay/host-stats.ts";
import { type AgentCounts, agentCounts, agentState } from "./agent-states.ts";
import { busyAncestors, type UnloadRow } from "./idle-unload.ts";
import { QUIET_MINUTES } from "./quiet-minutes.ts";
import { type CallMark, callMarks, CallWatch, type HungCall, PROGRESS_WINDOW_MS } from "./hung-calls.ts";
import type { CallHandle, CallStopper, StoppedCall } from "./hung-stop.ts";
import type { AgentQueueReading, MemoryGroupId } from "./shared/types.ts";
import { readUplinkDark } from "./uplink-dark.ts";

/**
 * The Mac usable watch: once a minute the chat service appends one line to `<dataDir>/mac-usable/<local date>.jsonl` with the Mac's usability
 * from ops guy's pressure feed (memory pressure level, swapouts a second, kernel_task CPU) and the harness numbers behind it: the Prime workers'
 * memory footprint and the top workers by it with their chat tree, the chat trees by footprint, the live and working sessions, the Agent
 * sessions memory Settings > Hosts shows with the sessions by state (`agents`), and the Mac-wide turn queue. The owner (10-14 09:15Z): "look it's you and ops guys responsibility that this machine is
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
/** This box's reading now, by `cut` (kernel-read.ts `bounded`), with each read the cut passed named in `unread`. */
export const readUsable = async (now: number, cut?: Promise<unknown>, unread?: string[]): Promise<HostUsable | null> => process.platform === "darwin"
  ? await bounded("feed", () => readPressureFeed(now), cut, unread) ?? null : await linuxUsable(now, cut, unread);

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
  const split = parseHarnessSplit(reading.harnessSplit);
  return { kind: "linux", memSomeAvg10, memFullAvg10, cpuSomeAvg10, swapoutsPerS, runnablePerCore, allowedCpus: allowedCpus as number, ...cpuCores ? { cpuCores } : {},
    ...split ? { harnessSplit: split } : {} };
}

/** A harnessSplit (rig-cpu.ts) whose own and rigs cores are counts and whose top lines each name an owner, a count and a command; else undefined. */
export function parseHarnessSplit(value: unknown): HarnessSplit | undefined {
  if (!isRecord(value) || !count(value.own) || !count(value.rigs) || !Array.isArray(value.top)) return undefined;
  const top = value.top.filter((line): line is RigLine => isRecord(line) && typeof line.owner === "string" && count(line.cores) && typeof line.command === "string")
    .map(line => ({ owner: line.owner, cores: line.cores, command: line.command }));
  return { own: value.own, rigs: value.rigs, top };
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
/**
 * Every Prime worker with its footprint, its lead chat tree (`root`, `tree` cut to 60 characters), its live sessions and how many of them
 * work (src/agent-states.ts: streaming, a tool call or a compaction; a retry or pool wait, a wait on a subagent and a hung call are no work).
 * Prime runs a chat and all its jobs in one worker, so d7's quiet_agent_gb sums the workers whose sessions have not worked for the quiet window
 * (whole-system.ts `quietTrees`). `top` names only the 5 largest: at 17:52Z on 10-19 us-metal02 ran 71 workers with 119 sessions working and
 * no box had gone 15 min with none since 14:29Z, so the box-wide reading never came. Absent on lines written before 10-20.
 */
export interface WorkerTree { pid: number; gb: number; root: string; tree: string; sessions: number; working: number }
/**
 * A session a worker still holds loaded (`activeSessionId` set) that read idle with no client but a chat's service attach for over LINGER_MS,
 * and with no session below it at work, which the idle unload (src/idle-unload.ts) should have stopped by then on any box: its session, name,
 * chat tree, worker and idle minutes. The unload keeps a session with a busy session below it (`busyAncestors`), since the daemon's guard refuses
 * to close it: at 06:34Z on 10-28 d7 named SEO guy, 01a17f05 and dm-extension, idle 19 to 22 min, while review-caption-length under SEO
 * guy's authority studies and dm-ext-core under dm-extension worked.
 * Only a row with `activeSessionId` is resident. Prime's list also names each tree's finished subagents from the spawn ledger, with no runtime
 * and no kernel, stamped with the tree worker's pid (daemon-mode.ts `buildSessionListWithPassiveRlmSubagents`, daemon-supervisor.ts
 * `publicSummary`), and every archived row is one of them, since a resident session always reads live or draft (`activeLifecycleForSession`).
 * At 23:36Z on 10-27 a count of the Mac's archived rows with a `workerPid` read 56 sessions "still sat in workers"; none had an
 * `activeSessionId`, and at 03:20Z on 10-28 the Mac's 64 kernels matched its 68 loaded rows while 22 archived rows had none.
 */
export interface LingerLine { session: string; name: string; tree: string; worker: number; idleMin: number }
/** The quiet window plus two 60 s unload sweeps. */
export const LINGER_MS = (QUIET_MINUTES + 2) * MINUTE;

/** Every loaded idle session past LINGER_MS (`LingerLine`), the longest idle first. */
export function lingerLines(rows: readonly unknown[], now: number, chats: ReadonlySet<string>, tree: (id: string) => string): LingerLine[] {
  const busy = busyAncestors(rows.filter((raw): raw is UnloadRow => isRecord(raw) && typeof raw.sessionId === "string"));
  return rows.flatMap((raw): LingerLine[] => {
    if (agentState(raw) !== "idle" || !isRecord(raw) || typeof raw.sessionId !== "string" || typeof raw.workerPid !== "number" || busy.has(raw.sessionId)) return [];
    const idleMs = now - (typeof raw.lastActivityAt === "string" ? Date.parse(raw.lastActivityAt) : NaN);
    const clients = typeof raw.attachedClients === "number" ? raw.attachedClients : 0;
    if (!(idleMs > LINGER_MS) || clients > (chats.has(raw.sessionId) ? 1 : 0) || raw.hasRegisteredHeartbeat === true || raw.hasRegisteredCronJob === true) return [];
    return [{ session: raw.sessionId, name: typeof raw.sessionName === "string" ? raw.sessionName : "", tree: tree(raw.sessionId), worker: raw.workerPid, idleMin: Math.round(idleMs / MINUTE) }];
  }).sort((a, b) => b.idleMin - a.idleMin);
}
/** A chat tree and how many of its sessions a count holds. */
export interface TreeCount { root: string; tree: string; count: number }
export interface QueueLine {
  working: number; queued: number;
  /** How long the oldest queued turn has waited, and its chat tree. */
  oldestWaitS: number; oldestTree: string | null;
  /**
   * pi-pool's admission inputs, so d7 can tell a turn its tree's cap holds from one a free slot left waiting (`admit_pass` in pool/turns.py):
   * both limits as pi-pool merges its defaults and config.json, the working turns, each of which holds a slot, and each
   * tree with a queued turn that is not parked. Absent on lines written before 10-18 05:1xZ, when metal-management's turns at its 8 of 8 read
   * as free-slot waits. A parked turn has no process to take a slot: pi-pool wakes it and holds the slot for it, or skips it until its session
   * asks again, after a wake Prime cancelled. From 21:13Z to 22:02Z on 10-27, the turn d7 named in each of its 6 free-slot minutes was parked,
   * in the AI harness VP's tree or the wiki dream tree, and Prime cancelled its resume on each wake (p1184).
   */
  workingMax?: number; treeWorkingMax?: number; slots?: number; waiting?: WaitingTree[];
}
/** A chat tree with a queued turn: its longest wait and the slots its working turns hold against tree_working_max. */
export interface WaitingTree { tree: string; oldestWaitS: number; slots: number }
/**
 * Another box's numbers in a watch line, read through its relay (POST /v1/watch): its usability reading, its Prime workers and what its idle
 * sessions hold. From 04:20Z on 10-18 the chat ran on us-metal02, and its lines measured only the box, so the Mac's workers left d7's numbers.
 * `error` names a box whose relay did not answer, or whose footprint helper failed while `usable` still holds its reading; its worker numbers are
 * then unknown, not zero.
 */
export interface HostWatchLine { name: string; usable: HostUsable | null; workers: number; workerGb: number; top: WorkerLine[]; live: number; working: number;
  /** Every worker of the box (`WorkerTree`); absent on lines written before 10-20 and when its relay or footprint helper did not answer. */
  byWorker?: WorkerTree[];
  /** The box's Agent sessions as Settings > Hosts reads them (`agentLine`); absent on lines written before 10-19 and when its relay did not answer. */
  agents?: AgentLine; swapGb: number | null; error?: string;
  /** Tailscale read the box offline, so its relay was not asked (src/host-reach.ts); absent on lines written before 10-18 16:xxZ. */
  offline?: true;
  /** The box's agent test browsers (`TestBrowserLine`); absent when there are none. */
  testBrowsers?: TestBrowserLine[];
  /** The stray stdio MCP servers the box's footprint read stopped this minute (`StrayServerLine`); absent when there were none. */
  strayServers?: StrayServerLine[];
  /** The box's idle or relative-home pm2 God Daemons (`IdlePm2Line`); absent when there are none. */
  idlePm2?: IdlePm2Line[];
  /** The box's loaded sessions idle past the unload window (`LingerLine`); absent when there are none. */
  lingering?: LingerLine[];
  /** The Mac's open Aside tabs and the agents' share of them (`AsideTabs`); absent off macOS, when Aside did not answer and on lines written before 10-29. */
  asideTabs?: AsideTabs;
  /** The box's chat trees by footprint with each one's largest process (`TreeLine`), at most 5; absent on lines written before 10-28 10:xxZ and when
   * none holds a kernel or orphan. On 10-28 the Mac's 09:15:30Z swap minute left d1 no process to name, because remote lines dropped them. */
  trees?: TreeLine[] }

export interface WatchLine {
  at: string;
  /** The box that wrote the line (hosts.json's name); absent on lines written before 10-18 04:5xZ, all of them on the Mac. */
  host?: string;
  /** This box's reading this minute: ops guy's feed on the Mac, the kernel's on Linux; null when it was stale or unreadable, absent on lines written before the watch read it. */
  usable?: HostUsable | null;
  /** Every other box in hosts.json; absent on older lines. */
  hosts?: HostWatchLine[];
  workers: number; workerGb: number; top: WorkerLine[];
  /** Every worker of this box (`WorkerTree`); absent on lines written before 10-20. */
  byWorker?: WorkerTree[];
  /** The live chat roots; absent on lines written before it was counted. */
  chatsLive?: number;
  live: number; working: number;
  queue: QueueLine | null;
  /** The chat trees with the largest footprint, kernel subtrees plus orphans, at most 5; absent on older lines. */
  trees?: TreeLine[];
  /** This box's Agent sessions as Settings > Hosts reads them (`agentLine`); absent on lines written before 10-19. */
  agents?: AgentLine;
  /** The chat service's own resident memory; absent on older lines. */
  serviceGb?: number;
  /** Context only, from sysctl: swap in use and kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical). */
  mac: { swapGb: number | null; pressureLevel: number | null };
  /** CPU this sample cost: the service's own work plus the footprint helper's. */
  cpuMs: number;
  /** Both of this box's gateways were down (src/uplink-dark.ts), so it reached no other box and nobody reached it; absent otherwise. */
  uplinkDark?: true;
  /** How slow the chat service on this box was to the owner since the last line (src/chat-latency.ts); absent on lines written before it. */
  chat?: ChatLatency;
  /** This box's sessions in a tool call silent long enough to be judged soon (src/hung-calls.ts `callMarks`); absent when none. */
  calls?: CallMark[];
  /** This box's reads that had not answered by the end of the line's minute (`sample`), such as "cgroups" or "footprints"; absent when none. */
  unread?: string[];
  /** This box's hung tool calls this minute (`hungCalls`), which `agents` counts as hung instead of working; absent when none. */
  hung?: HungCall[];
  /** The hung calls whose bash() commands or cell the watch stopped this minute (src/hung-stop.ts), left out of `hung`; absent when none. */
  stopped?: StoppedCall[];
  /** The services sessions handed off before their kernels were freed (`orphan-services.ts`), the first 5 named; absent when there are none. */
  services?: ServicesLine;
  /** This box's agent test browsers (`TestBrowserLine`); absent when there are none. */
  testBrowsers?: TestBrowserLine[];
  /** The stray stdio MCP servers this box's footprint read stopped this minute (`StrayServerLine`); absent when there were none. */
  strayServers?: StrayServerLine[];
  /** This box's idle or relative-home pm2 God Daemons (`IdlePm2Line`); absent when there are none. */
  idlePm2?: IdlePm2Line[];
  /** This box's loaded sessions idle past the unload window (`LingerLine`); absent when there are none. */
  lingering?: LingerLine[];
}
/** How many handed-off services the records name, how many of them still run, and the first 5. */
export interface ServicesLine { count: number; live: number; top: { session: string; unit: string; pid: number; live: boolean }[] }
export function servicesLine(services: readonly OrphanServiceLine[]): ServicesLine | null {
  if (!services.length) return null;
  return { count: services.length, live: services.filter(service => service.live).length,
    top: services.slice(0, 5).map(service => ({ session: service.session, unit: service.unit, pid: service.pid, live: service.live })) };
}

/**
 * A box's "Agent sessions" this minute as Settings > Hosts shows it, from the same reading (host-stats.ts `memoryByGroup`): `gb` is what the
 * agents group holds that the box cannot take back, in RAM or swap, `swapGb` the part in swap and `cacheGb` the box's file cache beside it,
 * with its loaded sessions by state (src/agent-states.ts). `gb` is null when the box's groups could not be read. The Whole system duty's
 * quiet_agent_gb reads `gb` in the minutes no session `working`. `servicesGb` is the Agent services group beside it (host-stats.ts
 * `leafHolder`: the chat service, the relay, pi-pool and the Prime supervisor), which `gb` leaves out since 10-21. Since 10-28 `gb` also leaves
 * out the tests, builds, servers and browsers jobs start in the daemon's cgroup, which read Jobs (`processHolder`), and holds the workers and
 * kernels alone.
 */
export interface AgentLine extends AgentCounts { gb: number | null; swapGb?: number; cacheGb?: number; servicesGb?: number;
  /** The group that held the most of the box's memory that minute, which the Whole system duty books a memory stall to (whole-system.ts `minuteSide`). */
  largest?: MemoryGroupId }

/** The agents group of a memory reading and the session counts of `rows`, as one AgentLine. */
export function agentLine(memory: { groups: readonly MemoryGroup[] | null; cacheBytes?: number | null } | null, rows: readonly unknown[], hung?: ReadonlySet<string>): AgentLine {
  const group = memory?.groups ? memory.groups.find(entry => entry.id === "agents") ?? { bytes: 0, swapBytes: 0 } : null;
  const services = memory?.groups?.find(entry => entry.id === "services");
  const largest = memory?.groups && memory.groups.length > 1 ? memory.groups.reduce((most, entry) => entry.bytes > most.bytes ? entry : most) : null;
  return { gb: group ? round(group.bytes / GB) : null, ...group?.swapBytes !== undefined ? { swapGb: round(group.swapBytes / GB) } : {},
    ...services ? { servicesGb: round(services.bytes / GB) } : {},
    ...typeof memory?.cacheBytes === "number" ? { cacheGb: round(memory.cacheBytes / GB) } : {}, ...largest ? { largest: largest.id } : {}, ...agentCounts(rows, hung) };
}

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
  /** The Mac's Chrome for Testing and chrome-headless-shell main processes, with the session whose RLM_HARNESS_STATE_DIR they carry; absent from a helper older than 10-19 17:xxZ. */
  test_browsers?: RawOrphan[];
  /** The stdio MCP servers whose kernel was gone, which the helper signalled in this read; absent from a helper older than 10-28. */
  stray_servers?: RawStray[];
  /** The box's pm2 God Daemons (`RawPm2`); absent from a helper older than 10-28. */
  pm2_daemons?: RawPm2[];
  /** The Mac's open Aside tabs and how many of them agent sessions opened (`AsideTabs`); null when Aside did not answer, absent off macOS and from a helper older than 10-29. */
  aside_tabs?: AsideTabs | null;
  swap_used_bytes: number | null; pressure_level: number | null; cpu_s: number }
/** The owner's open Aside tabs (`all`) and how many of them agent sessions opened through aside_browser (`agent`), from worker-footprint.py `aside_tabs`. */
export interface AsideTabs { agent: number; all: number }
const tabCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
/** A helper's `aside_tabs` checked at the edge: two whole counts with `agent` at most `all` and at least one tab open, else null. */
export function parseAsideTabs(value: unknown): AsideTabs | null {
  if (!isRecord(value) || !tabCount(value.agent) || !tabCount(value.all) || value.all < 1 || value.agent > value.all) return null;
  return { agent: value.agent, all: value.all };
}
/** One process the helper names: its footprint, its start time in epoch seconds (null when unreadable) and its command's first 200 characters. */
export interface RawProcess { pid: number; bytes: number; started: number | null; command: string }
/**
 * A `python -m rlm.repl` kernel with the root and session its RLM_HARNESS_STATE_DIR names, its subtree, the kernel process alone (`own`, absent
 * from a relay installed before 10-18 07:5xZ), and its largest descendant that is no Prime process.
 */
export interface RawKernel { pid: number; root: string; session: string; pids: number; bytes: number; own?: number; biggest: RawProcess | null;
  /** The kernel's own CPU seconds and its commands' (descendants and reaped children), Linux only (src/hung-calls.ts). */
  cpu_s?: number; work_cpu_s?: number }
/** A process with RLM_HARNESS_STATE_DIR under no kernel and no Prime process (a deleted job's nohup'd runner), with the root and session the path names. */
export interface RawOrphan extends RawProcess { root: string; session: string }
/** A pm2 God Daemon: the home its title names, as given (relative when its starter set a relative PM2_HOME), and how many processes it runs. */
export interface RawPm2 extends RawOrphan { home: string; apps: number }
/**
 * A pm2 God Daemon that runs no process, or whose home is relative and so depends on its starter's cwd: its pid, start, home, process count
 * and the chat tree and session whose env it carries ("" when none).
 */
export interface IdlePm2Line { pid: number; started: number | null; home: string; apps: number; mb: number; root: string; tree: string; session: string }
/** The God Daemons that run no process or have a relative home (`IdlePm2Line`), from the footprint helper's `pm2_daemons`. */
export const strayPm2 = (daemons: readonly RawPm2[]): RawPm2[] => daemons.filter(daemon => daemon.apps === 0 || !daemon.home.startsWith("/"));
/** A stdio MCP server (`aside mcp`, cua-guard.ts) init or the user's systemd adopted once its kernel exited, and the signal that ended it (null when it was gone first). */
export interface RawStray extends RawProcess { ppid: number; signal: "SIGTERM" | "SIGKILL" | null }
/** A stray stdio MCP server the box's footprint read stopped (`RawStray`), with its footprint in MB. */
export interface StrayServerLine { pid: number; started: number | null; mb: number; signal: "SIGTERM" | "SIGKILL" | null; command: string }
const strayLines = (footprints: Footprints): StrayServerLine[] => (footprints.stray_servers ?? []).map(stray => ({ pid: stray.pid, started: stray.started,
  mb: Math.round(stray.bytes / 2 ** 20), signal: stray.signal, command: stray.command }));
/**
 * A Playwright or Puppeteer browser running on the Mac, where no agent browser may run (skills/aside-browser/SKILL.md, c103): its pid, start, the
 * chat tree and session that started it ("" when its env names none, as for a duty walk over ssh) and its command's first 200 characters.
 */
export interface TestBrowserLine { pid: number; started: number | null; root: string; tree: string; session: string; command: string }
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
  title: (id: string) => string | null; cpuMs: number; usable?: HostUsable | null;
  /** The box's memory by group (host-stats.ts `memoryByGroup`), for `agents`; absent, the line has none. */
  memory?: { groups: readonly MemoryGroup[] | null; cacheBytes?: number | null } | null;
  /** The hung calls' sessions, which `agents` counts as hung. */
  hung?: ReadonlySet<string> }): WatchLine {
  const rows = input.rows.map(parseRow).filter((row): row is Row => row !== null);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tree = treeOf(byId, input.title);
  const live = rows.filter(row => row.live);
  const working = live.filter(row => row.working);
  const sized = Object.entries(input.footprints.workers).map(([pid, tree_]) => ({ pid: Number(pid), bytes: tree_.bytes })).sort((a, b) => b.bytes - a.bytes);
  const top = sized.slice(0, 5).map(({ pid, bytes }): WorkerLine => {
    const on = live.filter(row => row.worker === pid);
    const lead = topTrees(on, tree, 1)[0];
    return { pid, gb: round(bytes / GB), sessions: on.length, root: lead?.root ?? "", tree: lead?.tree ?? "", workGb: round(workBytes(input.footprints, byId, pid) / GB) };
  });
  const atWork = new Map<number, number>();
  for (const raw of input.rows) {
    if (agentState(raw, input.hung) !== "working" || !isRecord(raw) || typeof raw.workerPid !== "number") continue;
    atWork.set(raw.workerPid, (atWork.get(raw.workerPid) ?? 0) + 1);
  }
  const byWorker = sized.map(({ pid, bytes }): WorkerTree => {
    const on = live.filter(row => row.worker === pid);
    const lead = topTrees(on, tree, 1)[0];
    return { pid, gb: round(bytes / GB), root: lead?.root ?? "", tree: (lead?.tree ?? "").slice(0, 60), sessions: on.length, working: atWork.get(pid) ?? 0 };
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
  const lingering = lingerLines(input.rows, input.now, input.chats, id => {
    const row = byId.get(id);
    return row ? tree(row).tree : id.slice(0, 8);
  });
  const idlePm2 = strayPm2(input.footprints.pm2_daemons ?? []).map((daemon): IdlePm2Line => ({ pid: daemon.pid, started: daemon.started, home: daemon.home,
    apps: daemon.apps, mb: Math.round(daemon.bytes / 2 ** 20), ...daemon.root || daemon.session ? owner(daemon.session, daemon.root) : { root: "", tree: "" }, session: daemon.session }));
  return {
    at: new Date(input.now).toISOString(),
    usable: input.usable ?? null, chatsLive,
    workers: Object.keys(input.footprints.workers).length,
    workerGb: round(Object.values(input.footprints.workers).reduce((sum, worker) => sum + worker.bytes, 0) / GB),
    top, byWorker, live: live.length, working: working.length,
    queue,
    trees: treeLines(input.footprints, owner).slice(0, 5),
    ...input.footprints.test_browsers?.length ? { testBrowsers: input.footprints.test_browsers.map(browser => ({ pid: browser.pid, started: browser.started,
      ...browser.root || browser.session ? owner(browser.session, browser.root) : { root: "", tree: "" }, session: browser.session, command: browser.command })) } : {},
    ...input.footprints.stray_servers?.length ? { strayServers: strayLines(input.footprints) } : {},
    ...idlePm2.length ? { idlePm2 } : {},
    ...lingering.length ? { lingering } : {},
    ...input.memory !== undefined ? { agents: agentLine(input.memory, input.rows, input.hung) } : {},
    mac: { swapGb: input.footprints.swap_used_bytes === null ? null : round(input.footprints.swap_used_bytes / GB, 1), pressureLevel: input.footprints.pressure_level },
    cpuMs: Math.round(input.cpuMs + input.footprints.cpu_s * 1000),
  };
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
  const held = reading.working;
  const firstAsk = new Map<string, number>();
  for (const entry of reading.queued) if (!entry.parked) firstAsk.set(entry.tree, Math.min(firstAsk.get(entry.tree) ?? Infinity, entry.since));
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

/**
 * Every watch line from `since` to `now`, oldest first, from the day files that cover the span; a missing file or a bad line is skipped. The
 * files also take the day before and after, since the writer names each by its own local day: on 10-18 the chat ran with TZ=Asia/Seoul, so
 * from 15:00Z its lines went to 2026-10-19.jsonl, and a precheck run from a UTC shell at 16:46Z read only 2026-10-18.jsonl and found 30
 * minutes with no watch line.
 */
export async function readWatch(dataDir: string, since: number, now: number): Promise<WatchLine[]> {
  const files = new Set<string>();
  const day = 24 * 60 * MINUTE;
  for (let at = since - day; at < now + 2 * day; at += day) files.add(watchFile(dataDir, Math.min(at, now + day)));
  const lines: WatchLine[] = [];
  for (const file of files) {
    const text = await tailSince(file, since);
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

/**
 * How long after its `at` a line can land: `at` is its sample's start and the sample's reads are cut at the next tick (`sample`), so a line
 * lands within a minute of it, and a line older than `since` by LATE_MS has every line from `since` on after it in the file.
 */
const LATE_MS = 2 * MINUTE;
/** About 23 lines of the 10-25 file, which held 13.8 MB in 1,250 lines by 11:33Z. */
const TAIL_CHUNK = 256 * 1024;
/** A line's `at` from its first 200 bytes, where the writer puts it after `host`; NaN when they hold none. */
const headAt = (head: Buffer): number => Date.parse(/"at":"([^"]+)"/.exec(head.toString("latin1"))?.[1] ?? "");

/**
 * The lines of `file` from the first one older than `since` by LATE_MS, read back from its end; "" when it is missing. The watch's start reads
 * the last 30 minutes for its call marks, and parsing every line of the day files held the main thread 0.6 s at the release-1ca77d6 start
 * at 11:14:42Z on 10-25 (its CPU profile, two blocks between 1.6 and 2.4 s after the start), while the first reads waited.
 */
export async function tailSince(file: string, since: number): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const chunks: Buffer[] = [];
    let at = (await handle.stat()).size;
    let from = 0;
    while (at > 0) {
      const size = Math.min(TAIL_CHUNK, at);
      at -= size;
      const chunk = Buffer.alloc(size);
      for (let got = 0; got < size;) {
        const { bytesRead } = await handle.read(chunk, got, size - got, at + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      chunks.unshift(chunk);
      const start = chunk.indexOf(10);
      if (start < 0) continue;
      const head = Buffer.concat([chunk.subarray(start + 1, start + 201), chunks[1]?.subarray(0, 200) ?? Buffer.alloc(0)]);
      if (headAt(head) < since - LATE_MS) { from = start + 1; break; }
    }
    return Buffer.concat(chunks).subarray(from).toString("utf8");
  } finally {
    await handle.close();
  }
}

const HELPER = join(import.meta.dirname, "worker-footprint.py");
function runHelper(args: readonly string[], input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = hostExecFile("/usr/bin/python3", ["-B", HELPER, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as unknown); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(input);
  });
}
/** Runs the footprint helper with the worker pids on stdin. */
export const readFootprints = async (pids: readonly number[]): Promise<Footprints> => await runHelper([], pids.join("\n") + "\n") as Footprints;
/** The bash() handles each kernel started since the given second (worker-footprint.py `--handles`), for src/hung-stop.ts. */
export const readCallHandles = async (wanted: readonly { kernel: number; since: number }[]): Promise<CallHandle[]> =>
  (await runHelper(["--handles"], wanted.map(entry => `${entry.kernel} ${entry.since}`).join("\n") + "\n") as { handles: CallHandle[] }).handles;
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
  feed?: (now: number, cut?: Promise<unknown>, unread?: string[]) => Promise<HostUsable | null>;
  /** This box's memory by group; absent, `memoryByGroup`, the reading Settings > Hosts draws. */
  memory?: typeof memoryByGroup;
  /** This box's name in hosts.json, else its short hostname, written on each line. */
  host?: string;
  /** Every other box: its name, the daemon rows the catalog holds for it, and a read of its relay's POST /v1/watch for those workers. */
  remotes?: () => readonly RemoteWatch[];
  /** This box's tool call marks and hung calls (src/hung-calls.ts), shared with Settings > Hosts; absent, no call is judged. */
  calls?: CallWatch;
  /** Stops the commands of the hung calls `calls` judges (src/hung-stop.ts); absent, no call is stopped. */
  stop?: CallStopper;
  /** The handed-off services on this box; absent, `listOrphanServices`. */
  services?: () => Promise<readonly OrphanServiceLine[]>;
  /** Whether this box was cut off its network at `now` (src/uplink-dark.ts); absent, `readUplinkDark`. */
  uplink?: (now: number) => Promise<boolean>;
}
/** A relay's answer (hosts.ts `relayWatch`): the box's reading, and its workers' footprints or why they are missing. */
export interface RemoteWatch { name: string; rows: readonly unknown[];
  read: (pids: readonly number[]) => Promise<{ usable: unknown; footprints: Footprints; error?: undefined } | { usable: unknown; footprints: null; error: string }>;
  /** Whether Tailscale reads the box up; a box it reads offline is written offline, and its relay is not asked. */
  reach?: () => Promise<PeerReach> }

/** The pids of the workers that host the rows' sessions. */
const workerPids = (rows: readonly unknown[]): number[] => [...new Set(rows.map(parseRow).flatMap(row => row?.hosted && row.worker !== undefined ? [row.worker] : []))];

/**
 * One other box's numbers from its relay, judged with this box's chat ids and titles. A failed read keeps the box with its error; a read with a
 * reading and no footprints keeps the reading, and its worker numbers are unknown. Its `agents` come from the Mac pressure feed's groups, the
 * reading its Hosts card draws (host-stats.ts `memoryGroups`); a Linux box's relay sends no groups, so its `gb` is null.
 */
export async function hostWatchLine(remote: RemoteWatch, input: { now: number; chats: ReadonlySet<string>; title: (id: string) => string | null }): Promise<HostWatchLine> {
  try {
    const reach = await remote.reach?.().catch(() => null);
    if (reach && !reach.online)
      return { name: remote.name, usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, offline: true, error: `offline, Tailscale last seen ${seenAgo(input.now, reach.lastSeen)}` };
    const answer = await remote.read(workerPids(remote.rows));
    const usable = parseUsableRaw(answer.usable, input.now);
    const agents = agentLine(usable && !isLinuxReading(usable) && usable.groups ? { groups: [{ id: "agents", label: "", bytes: (usable.groups.agents ?? 0) * GB, top: [] },
      ...usable.groups.services !== undefined ? [{ id: "services" as const, label: "", bytes: usable.groups.services * GB, top: [] }] : []] } : null, remote.rows);
    if (answer.footprints === null) return { name: remote.name, usable, workers: 0, workerGb: 0, top: [], live: 0, working: 0, agents, swapGb: null, error: answer.error.slice(0, 200) };
    const line = watchLine({ now: input.now, rows: remote.rows, footprints: answer.footprints, queue: null, chats: input.chats, title: input.title, cpuMs: 0, usable });
    const asideTabs = parseAsideTabs(answer.footprints.aside_tabs);
    return { name: remote.name, usable, workers: line.workers, workerGb: line.workerGb, top: line.top, ...line.byWorker ? { byWorker: line.byWorker } : {}, live: line.live,
      working: line.working, agents, swapGb: line.mac.swapGb,
      ...line.testBrowsers ? { testBrowsers: line.testBrowsers } : {}, ...line.strayServers ? { strayServers: line.strayServers } : {}, ...line.idlePm2 ? { idlePm2: line.idlePm2 } : {},
      ...line.lingering ? { lingering: line.lingering } : {}, ...line.trees?.length ? { trees: line.trees } : {}, ...asideTabs ? { asideTabs } : {} };
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
 *
 * Each of this box's own reads answers by the next tick (`nextSampleAt`, kernel-read.ts `bounded`), and one that did not is
 * named in the line's `unread`, so the minute keeps its line, stamped at the sample's start, and the Whole system duty judges it from what was
 * read. A cut at the minute's end was too short for a sample that starts late in it: release-5ebd524's start sample at 14:11:59.900Z on 10-20
 * was cut 100 ms later with its /proc reads unread and replaced the 14:11:30Z line of that minute. A stop leaves these reads to that cut, which
 * comes within the service's 90 s stop timeout: release-d142c21 cut them at the stop too, and the stop lines at 14:30:03Z and 14:33:00Z read
 * nothing of this box. On 10-20 a hung cgroup
 * read held the sample, every tick until 13:08:29Z found it running and skipped, and d7's 13:08Z run read 30 of 30 minutes with no line. A
 * minute's next read of a kind still out joins it, so a hung helper or file is not started again each minute. With no footprints the minute
 * judges no call, since each kernel would be missing from them. The relay reads keep their own
 * 35 s bound, because the Mac's relay answered in 34 to 37 s at load 440 on 10-18.
 */
export async function sample(source: WatchSource, stopping?: Promise<void>): Promise<WatchLine | null> {
  const now = source.now ?? Date.now;
  const started = process.cpuUsage();
  const rows = source.rows();
  if (!rows.length) return null;
  const pids = workerPids(rows);
  let own = process.cpuUsage(started);
  const at = now();
  let minuteEnd: NodeJS.Timeout | undefined;
  const cut = new Promise<void>(resolve => { minuteEnd = setTimeout(resolve, Math.max(0, nextSampleAt(at) - now())); });
  const unread: string[] = [];
  const read = <T>(kind: string, value: () => Promise<T>): Promise<T | undefined> => bounded(kind, value, cut, unread);
  const chatIds = source.chats();
  const [read_, queue, chats, usable, memory, hosts, services, dark] = await Promise.all([read("footprints", () => (source.footprints ?? readFootprints)(pids)),
    read("queue", () => source.queue().catch(() => null)), chatIds,
    (source.feed ?? readUsable)(at, cut, unread), read("memory", () => (source.memory ?? memoryByGroup)().catch(() => null)),
    chatIds.then(ids => Promise.all((source.remotes?.() ?? []).map(remote => {
      const read = hostWatchLine(remote, { now: at, chats: ids, title: source.title });
      return stopping ? Promise.race([read, stopping.then(() => unreadHost(remote.name))]) : read;
    }))), read("services", () => (source.services ?? listOrphanServices)().catch(() => [])),
    read("uplink", () => (source.uplink ?? readUplinkDark)(at).catch(() => false))]);
  const handed = servicesLine(services ?? []);
  const resumed = process.cpuUsage();
  const latency = takeLatency();
  const footprints = read_ ?? { workers: {}, swap_used_bytes: null, pressure_level: null, cpu_s: 0 };
  const marks = source.calls && read_ ? callMarks(rows, footprints.kernels ?? [], at) : [];
  const judged = source.calls && read_ ? source.calls.judge(marks, at, callNamer(rows, source.title)) : [];
  const stopper = source.stop;
  const { stopped, left: hung } = stopper ? await read("stop", () => stopper.stop(judged, footprints.kernels ?? []).then(result => {
    if (result.stopped.length) source.calls?.release(result.stopped.map(call => call.session));
    return result;
  })) ?? { stopped: [], left: judged } : { stopped: [], left: judged };
  clearTimeout(minuteEnd);
  const line = { ...source.host ? { host: source.host } : {}, ...watchLine({ now: at, rows, footprints, queue: queue ?? null, chats, title: source.title, cpuMs: 0, usable, memory: memory ?? null,
    hung: new Set(hung.map(call => call.session)) }),
    ...hosts.length ? { hosts } : {}, serviceGb: round(process.memoryUsage().rss / GB), ...latency ? { chat: latency } : {},
    ...marks.length ? { calls: marks } : {}, ...hung.length ? { hung } : {}, ...stopped.length ? { stopped } : {}, ...handed ? { services: handed } : {},
    ...unread.length ? { unread } : {}, ...dark ? { uplinkDark: true as const } : {} };
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

/** Each session's name and chat tree, for a hung call's line. */
function callNamer(rows: readonly unknown[], title: (id: string) => string | null): (session: string) => { name: string; root: string; tree: string } {
  const byId = new Map(rows.map(parseRow).filter((row): row is Row => row !== null).map(row => [row.id, row] as const));
  const tree = treeOf(byId, title);
  return session => {
    const row = byId.get(session);
    return { name: row?.name ?? session.slice(0, 8), ...row ? tree(row) : { root: session, tree: title(session) ?? session.slice(0, 8) } };
  };
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
 * stop is called. A sample's reads are cut at the next tick (`sample`), so a tick that finds it still writing its line runs right after it,
 * and a start tick that finds a sample running skips. The start samples only fill a minute the last process left
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
  const startTick = () => tick(false, true);
  // The tool call marks of the last PROGRESS_WINDOW_MS come back from this box's own lines, so a restart judges no call on fewer marks.
  const seeded = source.calls ? readWatch(source.dataDir, now() - PROGRESS_WINDOW_MS, now())
    .then(lines => source.calls!.seed(lines.filter(line => (line.host ?? null) === (source.host ?? null)))).catch(() => {}) : Promise.resolve();
  // A start tick asks whether its minute has a line once the seed is read and the sample would start: at the release-1ca77d6 start on
  // 10-25 it asked before, with the catalog still empty, and the catalog's copy loaded while the seed read the watch files, so the sample
  // wrote a second 11:14Z line at 11:14:44.904Z beside the old process's 11:14:30.010Z one.
  const run = (fill = false) => seeded.then(() => {
    if (!fill || !written()) return sample(source, stopping);
    if (source.rows().length) landed = true;
    return null;
  }).then(line => { if (line) { landed = true; lastAt = Date.parse(line.at); } })
    .catch(error => source.log(`mac usable watch: ${error instanceof Error ? error.message : String(error)}`));
  let queued = false;
  const tick = (queue = false, fill = false) => {
    if (running) { queued ||= queue; return; }
    running = run(fill).finally(() => { running = null; if (queued) { queued = false; tick(); } });
  };
  let due = nextSampleAt(now());
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(() => { tick(true); due = nextSampleAt(Math.max(now(), due)); arm(); }, Math.max(0, due - now()));
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
