import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * One box's CPU, memory and turn queue, read on the box itself. The relay serves it as GET /v1/host, and sieun-pi reads its own box the same
 * way, so Settings > Hosts shows every box from one reader. This file imports nothing outside Node, because the relay is installed alone.
 */
const run = promisify(execFile);

export type MemoryPressure = "normal" | "warn" | "critical";
export const MEMORY_GROUPS = ["agents", "dev", "ci", "docker", "browsers", "coding", "system", "other"] as const;
export type MemoryGroupId = (typeof MEMORY_GROUPS)[number];
/** One memory group: its bytes and its 3 largest owners (a chat tree, a pm2 app, an app with its helpers, a systemd unit). */
export interface MemoryGroup { id: MemoryGroupId; label: string; bytes: number; top: { label: string; bytes: number }[] }
export interface MachineView {
  platform: "darwin" | "linux";
  /** Busy share of all cores since the previous reading, 0 to 100. */
  cpu: { percent: number; cores: number; load: [number, number, number] };
  /**
   * On macOS usedBytes counts app, wired and compressed memory, as Activity Monitor's "Memory Used" does, and the groups are the pressure
   * feed's owners by footprint. On Linux usedBytes is MemTotal minus MemAvailable, and the groups are the leaf cgroups' memory.current.
   */
  memory: { usedBytes: number; totalBytes: number; swapUsedBytes: number | null; swapTotalBytes: number | null; pressure: MemoryPressure | null;
    /** Largest first; null when the macOS feed is stale or the cgroup tree is unreadable. */
    groups: MemoryGroup[] | null };
}
/** The box's own `pi-pool queue --json` and `pi-pool config`, passed on unparsed: sieun-pi parses them at its edge. */
export type PoolReading = { queue: unknown; config: unknown } | { error: string };
export interface HostStats { machine: MachineView; pool: PoolReading }

type CpuSample = { busy: number; total: number };
function cpuSample(): CpuSample {
  let busy = 0, total = 0;
  for (const { times } of cpus()) {
    const sum = times.user + times.nice + times.sys + times.irq + times.idle;
    total += sum;
    busy += sum - times.idle;
  }
  return { busy, total };
}
let previous = cpuSample();
let lastPercent = 0;
/** Busy share of all cores since the previous call, so each poll reports the time since the one before. */
function cpuPercent(): number {
  const next = cpuSample();
  const total = next.total - previous.total;
  if (total > 0) lastPercent = Math.max(0, Math.min(100, (100 * (next.busy - previous.busy)) / total));
  previous = next;
  return lastPercent;
}

const GB = 1024 ** 3;
const GROUP_LABELS: Record<MemoryGroupId, string> = { agents: "Agent sessions", dev: "Dev servers and app code", ci: "CI runners", docker: "Docker",
  browsers: "Browsers", coding: "Coding tools", system: "System", other: "Other" };

function grouped(items: { id: MemoryGroupId; label: string; bytes: number }[], always: MemoryGroupId[]): MemoryGroup[] {
  const groups = new Map<MemoryGroupId, { label: string; bytes: number }[]>(MEMORY_GROUPS.map(id => [id, []]));
  for (const item of items) groups.get(item.id)!.push({ label: item.label, bytes: item.bytes });
  return [...groups].map(([id, members]) => {
    const top = members.sort((a, b) => b.bytes - a.bytes);
    return { id, label: GROUP_LABELS[id], bytes: top.reduce((sum, item) => sum + item.bytes, 0), top: top.slice(0, 3) };
  }).filter(group => group.bytes > 0 || always.includes(group.id)).sort((a, b) => b.bytes - a.bytes);
}

/** ops guy's Mac-wide feed, schema v1, rewritten every 10 s. A reading older than FEED_FRESH_MS (three missed writes) is stale. */
export const PRESSURE_FEED = join(homedir(), ".cache", "virev", "mac-pressure.json");
export const FEED_FRESH_MS = 30_000;

/**
 * The group of a pressure feed owner key (scripts/sieun/mac/pressure-feed.c in auto-sns-agent), first match. The feed already folds helpers
 * into their app and a process tree into its chat or pm2 app, so the key alone decides. Root processes such as WindowServer and kernel_task
 * have no owner rows, so System gets the feed's wired memory instead.
 */
export const GROUP_RULES: [MemoryGroupId, RegExp][] = [
  ["agents", /^chat:|^other:(prime-agent|chat-service|pi-pool|pool\.py|rlm)/i],
  ["docker", /^docker-vm$|^other:(OrbStack|Docker|com\.docker|colima|lima|vfkit|qemu)/i],
  ["dev", /^pm2:|^other:(pm2-daemon|next-server|vite|convex|turbo)/i],
  ["browsers", /^browser:|^other:com\.apple\.WebKit/i],
  ["coding", /^other:(Visual Studio Code|Code|Cursor|Claude|Zed|Xcode|Ghostty|iTerm2?|Terminal|Warp|claude|codex)/i],
  ["system", /^other:(com\.apple\.|Dock$|Finder$|Siri|System Settings$|Spotlight|ControlCenter|NotificationCenter|SystemUIServer|WindowManager|loginwindow)/i],
];
export const groupOf = (owner: string): MemoryGroupId => GROUP_RULES.find(([, rule]) => rule.test(owner))?.[0] ?? "other";

/** The feed's owners summed into groups, largest first; Docker shows even at 0 GB, an empty group else drops. Null for a stale or unknown feed. */
export function memoryGroups(feed: unknown, now: number): MemoryGroup[] | null {
  if (typeof feed !== "object" || feed === null) return null;
  const { v, ts, owners, mem_gb: mem } = feed as Record<string, unknown>;
  if (v !== 1 || typeof ts !== "string" || !(now - Date.parse(ts) < FEED_FRESH_MS) || !Array.isArray(owners)) return null;
  const items: { id: MemoryGroupId; label: string; bytes: number }[] = [];
  for (const item of owners as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { owner, label, mem_gb: gb } = item as Record<string, unknown>;
    if (typeof owner !== "string" || typeof gb !== "number") continue;
    items.push({ id: groupOf(owner), label: typeof label === "string" ? label : owner, bytes: Math.round(gb * GB) });
  }
  const wired = typeof mem === "object" && mem !== null ? (mem as Record<string, unknown>).wired : undefined;
  if (typeof wired === "number") items.push({ id: "system", label: "Wired memory (macOS kernel)", bytes: Math.round(wired * GB) });
  return grouped(items, ["docker"]);
}

/** Memory Used as Activity Monitor counts it: app memory (anonymous minus purgeable), wired, and compressed pages. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\.`, "m").exec(text)?.[1]);
  const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
  return Number.isFinite(pageSize) && Number.isFinite(used) ? used * pageSize : null;
}

const PRESSURE_LEVELS: Record<string, MemoryPressure> = { "1": "normal", "2": "warn", "4": "critical" };
/** `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage`: the kernel's pressure level (1, 2 or 4) on the first line, swap use on the second. */
export function parseSysctl(text: string): { pressure: MemoryPressure | null; swapUsedBytes: number | null; swapTotalBytes: number | null } {
  const [level, swap = ""] = text.split("\n");
  const pressure = PRESSURE_LEVELS[level?.trim() ?? ""] ?? null;
  const megabytes = (name: string) => {
    const value = new RegExp(`${name} = ([\\d.]+)M`).exec(swap)?.[1];
    return value === undefined ? null : Math.round(Number(value) * 1024 * 1024);
  };
  return { pressure, swapUsedBytes: megabytes("used"), swapTotalBytes: megabytes("total") };
}

async function macMemory(): Promise<MachineView["memory"]> {
  const totalBytes = totalmem();
  const [vm, sysctl, feed] = await Promise.all([
    run("vm_stat").then(out => parseVmStat(out.stdout), () => null),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]).then(out => parseSysctl(out.stdout), () => ({ pressure: null, swapUsedBytes: null, swapTotalBytes: null })),
    readFile(PRESSURE_FEED, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null),
  ]);
  return { usedBytes: vm ?? totalBytes - freemem(), totalBytes, ...sysctl, groups: memoryGroups(feed, Date.now()) };
}

/** /proc/meminfo in bytes: used is MemTotal minus MemAvailable, the number `free` shows as used plus reclaimable cache left out. */
export function parseMeminfo(text: string): { usedBytes: number; totalBytes: number; swapUsedBytes: number | null; swapTotalBytes: number | null } | null {
  const kb = (name: string) => { const value = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1]; return value === undefined ? null : Number(value) * 1024; };
  const total = kb("MemTotal"), available = kb("MemAvailable"), swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
  if (total === null || available === null) return null;
  return { usedBytes: total - available, totalBytes: total, swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null, swapTotalBytes: swapTotal };
}

/**
 * /proc/pressure/memory as a level: some avg10 at 7% reads warn and full avg10 at 70% reads critical, the same marks pi-pool's Linux memory
 * governor uses (Android lmkd's psi_partial_stall_ms 70 and psi_complete_stall_ms 700 for its 1 s window).
 */
export function parsePsi(text: string): MemoryPressure | null {
  const avg = (kind: string) => { const value = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text)?.[1]; return value === undefined ? null : Number(value); };
  const some = avg("some"), full = avg("full");
  if (some === null || full === null) return null;
  return full >= 70 ? "critical" : some >= 7 ? "warn" : "normal";
}

/** The group of a leaf cgroup path under /sys/fs/cgroup, first match. The dev half of us-metal02 is dev.slice and the CI half is virev.slice. */
export const CGROUP_RULES: [MemoryGroupId, RegExp][] = [
  ["agents", /prime-agent|sieun-pi|pi-pool|prime-relay|agent-chat/],
  ["ci", /^virev\.slice\/|virev-ci/],
  ["docker", /docker|containerd|^machine\.slice\//],
  ["dev", /^dev\.slice\//],
  ["coding", /code-server|cursor|vscode/],
  ["system", /^system\.slice\/|^init\.scope$/],
];
export const cgroupGroupOf = (path: string): MemoryGroupId => CGROUP_RULES.find(([, rule]) => rule.test(path))?.[0] ?? "other";

/** The leaf cgroups under `root` with their memory.current, so each byte counts once. A cgroup that cannot be read is skipped. */
export async function leafCgroups(root = "/sys/fs/cgroup"): Promise<{ path: string; bytes: number }[]> {
  const leaves: { path: string; bytes: number }[] = [];
  async function walk(relative: string): Promise<void> {
    const dir = relative ? join(root, relative) : root;
    const children = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => relative ? `${relative}/${entry.name}` : entry.name);
    if (relative && !children.length) {
      const bytes = Number((await readFile(join(dir, "memory.current"), "utf8").catch(() => "")).trim());
      if (Number.isFinite(bytes) && bytes > 0) leaves.push({ path: relative, bytes });
      return;
    }
    await Promise.all(children.map(walk));
  }
  await walk("");
  return leaves;
}

/** A readable name for a leaf cgroup: a login session names its user id, and libvirt's inner cgroup takes its VM's scope name. */
export function cgroupLabel(path: string): string {
  const login = /user-(\d+)\.slice\/session-(\d+)\.scope$/.exec(path);
  if (login) return `${login[1] === "0" ? "root" : `uid ${login[1]}`} login session ${login[2]}`;
  const parts = path.split("/").map(part => part.replace(/\\x2d/g, "-"));
  const leaf = parts.length > 1 && /^(libvirt|emulator|vcpu\d+)$/.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1)!;
  return leaf.replace(/\.(service|scope|slice)$/, "");
}

export function cgroupGroups(leaves: { path: string; bytes: number }[]): MemoryGroup[] | null {
  if (!leaves.length) return null;
  return grouped(leaves.map(leaf => ({ id: cgroupGroupOf(leaf.path), label: cgroupLabel(leaf.path), bytes: leaf.bytes })), []);
}

async function linuxMemory(): Promise<MachineView["memory"]> {
  const [meminfo, psi, leaves] = await Promise.all([
    readFile("/proc/meminfo", "utf8").then(parseMeminfo, () => null),
    readFile("/proc/pressure/memory", "utf8").then(parsePsi, () => null),
    leafCgroups(),
  ]);
  const totalBytes = totalmem();
  return { ...(meminfo ?? { usedBytes: totalBytes - freemem(), totalBytes, swapUsedBytes: null, swapTotalBytes: null }), pressure: psi, groups: cgroupGroups(leaves) };
}

export async function machineView(): Promise<MachineView> {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const memory = platform === "darwin" ? await macMemory() : await linuxMemory();
  const percent = cpuPercent();
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { platform, cpu: { percent, cores: cpus().length, load: [one, five, fifteen] }, memory };
}

/** The installed pi-pool CLI, ~/.local/bin/pi-pool, or PI_POOL_BIN. */
const poolBin = (): string => process.env.PI_POOL_BIN || join(homedir(), ".local", "bin", "pi-pool");

export async function poolReading(bin = poolBin()): Promise<PoolReading> {
  const json = async (args: string[]): Promise<unknown> => JSON.parse((await run(bin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  try {
    const [queue, config] = await Promise.all([json(["queue", "--json"]), json(["config"])]);
    return { queue, config };
  } catch (error) { return { error: `pi-pool: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }; }
}

export async function hostStats(): Promise<HostStats> {
  const [machine, pool] = await Promise.all([machineView(), poolReading()]);
  return { machine, pool };
}

/**
 * A Linux box's usability reading for the chat service's watch (sieun-pi src/mac-usable-watch.ts `unusable` judges it): memory and CPU
 * pressure stall (avg10, % of the last 10 s), swap-outs a second since the previous call (null on the first), and `runnablePerCore`.
 *
 * `runnablePerCore` estimates the mean number of tasks running or waiting to run, for each of the `allowedCpus` CPUs this process may run on,
 * between this call and the one before. It is the growth of /proc/schedstat's per-CPU run time plus run-queue wait time over the window,
 * divided by the window and the CPU count. That makes it a sample-window estimate: the kernel adds a task's run time when it leaves a CPU
 * and its wait when it gets one, so time still open at the window's end shows up in the next window, and it is no instant queue length.
 * 1.0 means one runnable task for each of those CPUs.
 */
export interface LinuxUsable { kind: "linux"; memSomeAvg10: number; memFullAvg10: number; cpuSomeAvg10: number; swapoutsPerS: number | null; runnablePerCore: number; allowedCpus: number }
/** One avg10 of a /proc/pressure file's `some` or `full` line; null when the line is absent. */
export function psiAvg10(text: string, kind: "some" | "full"): number | null {
  const value = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text)?.[1];
  return value === undefined ? null : Number(value);
}
/** pswpout of /proc/vmstat: pages swapped out since boot. */
export function parsePswpout(text: string): number | null {
  const value = /^pswpout (\d+)$/m.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}
/**
 * The CPUs of a /proc/<pid>/status Cpus_allowed_list line ("9,11,13-15"), sorted and each once. Null when the line is absent or any part is not
 * a CPU number or an ascending "from-to" range, such as "-1", "1-2-3", "3-1", an empty part, or digits past Number.MAX_SAFE_INTEGER.
 */
export function parseCpusAllowed(status: string): number[] | null {
  const list = /^Cpus_allowed_list:[ \t]*(\S*)[ \t]*$/m.exec(status)?.[1];
  if (!list) return null;
  const cpus = new Set<number>();
  for (const part of list.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]), to = Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return null;
    for (let cpu = from; cpu <= to; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a, b) => a - b);
}
/**
 * Each CPU's nanoseconds of task run time plus run-queue wait since boot, from /proc/schedstat's cpuN lines (fields 7 and 8 in versions 15
 * to 17, kept by CONFIG_SCHED_INFO even with the kernel.sched_schedstats counters off); null for another version or no cpu line.
 */
export function parseSchedstat(text: string): Map<number, number> | null {
  const version = Number(/^version (\d+)$/m.exec(text)?.[1]);
  if (!(version >= 15 && version <= 17)) return null;
  const times = new Map<number, number>();
  for (const match of text.matchAll(/^cpu(\d+)(?: \d+){6} (\d+) (\d+)/gm)) times.set(Number(match[1]), Number(match[2]) + Number(match[3]));
  return times.size ? times : null;
}
/**
 * Tasks running or waiting a CPU, averaged over `cores` between two schedstat readings `ms` apart. Null, so the box reads unknown, when the
 * window is empty, a CPU is missing from either reading (hotplug), a counter went back (a reset), or no CPU of the set counted any time.
 */
export function runnablePerCore(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>, cores: readonly number[], ms: number): number | null {
  if (!cores.length || !(ms > 0)) return null;
  let ns = 0;
  for (const core of cores) {
    const from = before.get(core), to = after.get(core);
    if (from === undefined || to === undefined || to < from) return null;
    ns += to - from;
  }
  const counted = ns > 0;
  return counted ? ns / (ms * 1e6 * cores.length) : null;
}
let lastSwap: { at: number; pages: number } | null = null;
const loadSchedstat = (): { at: number; times: Map<number, number> } | null => {
  try {
    const times = parseSchedstat(readFileSync("/proc/schedstat", "utf8"));
    return times ? { at: Date.now(), times } : null;
  } catch { return null; }
};
let lastSched = process.platform === "linux" ? loadSchedstat() : null;
/** Where the next linuxUsable window starts: the last reading's time and per-CPU nanoseconds, null before the module could read schedstat. */
export type SchedstatMark = { at: number; times: Record<string, number> };
export const schedstatMark = (): SchedstatMark | null => lastSched && { at: lastSched.at, times: Object.fromEntries(lastSched.times) };
/**
 * Starts the next linuxUsable window at `mark`, the last reading of the process before a restart, so the first line after it averages over the
 * same span as any other line. False, and the window stays at the module's load, when the mark is malformed, not older than this module's
 * baseline, or a counter went back since it (a reboot).
 */
export function seedSchedstat(mark: unknown): boolean {
  const { at, times } = (mark ?? {}) as { at?: unknown; times?: unknown };
  if (!lastSched || typeof at !== "number" || !(at < lastSched.at) || !times || typeof times !== "object") return false;
  const seeded = new Map<number, number>();
  for (const [cpu, ns] of Object.entries(times)) {
    const now = lastSched.times.get(Number(cpu));
    if (typeof ns !== "number" || now === undefined || ns > now) return false;
    seeded.set(Number(cpu), ns);
  }
  if (seeded.size !== lastSched.times.size) return false;
  lastSched = { at, times: seeded };
  return true;
}
/**
 * The box's LinuxUsable now. The first call's window starts at the mark seedSchedstat took, else when this module loaded, so the watch line
 * a chat restart writes carries a reading. Null, so the box reads unknown, when /proc/pressure/memory, /proc/schedstat or this process's CPU set cannot be read.
 */
export async function linuxUsable(now = Date.now()): Promise<LinuxUsable | null> {
  const [memory, cpu, vmstat, schedstat, status] = await Promise.all(["/proc/pressure/memory", "/proc/pressure/cpu", "/proc/vmstat", "/proc/schedstat", "/proc/self/status"]
    .map(path => readFile(path, "utf8").catch(() => "")));
  const memSome = psiAvg10(memory!, "some"), memFull = psiAvg10(memory!, "full");
  const pages = parsePswpout(vmstat!);
  const previous = lastSwap;
  lastSwap = pages === null ? null : { at: now, pages };
  const swapoutsPerS = pages !== null && previous && now > previous.at ? Math.max(0, (pages - previous.pages) * 1000 / (now - previous.at)) : null;
  const times = parseSchedstat(schedstat!);
  const before = lastSched;
  lastSched = times ? { at: now, times } : null;
  const cores = parseCpusAllowed(status!);
  const runnable = times && before && cores ? runnablePerCore(before.times, times, cores, now - before.at) : null;
  if (memSome === null || memFull === null || runnable === null || !cores) return null;
  return { kind: "linux", memSomeAvg10: memSome, memFullAvg10: memFull, cpuSomeAvg10: psiAvg10(cpu!, "some") ?? 0,
    swapoutsPerS: swapoutsPerS === null ? null : Math.round(swapoutsPerS), runnablePerCore: Math.round(100 * runnable) / 100, allowedCpus: cores.length };
}
/** What a box reads for its usability: the raw pressure feed on macOS (the chat service parses it), the LinuxUsable reading on Linux. */
export type UsableRaw = { platform: "darwin"; feed: unknown } | { platform: "linux"; reading: LinuxUsable | null };
export async function usableRaw(now = Date.now()): Promise<UsableRaw> {
  if (process.platform === "darwin") return { platform: "darwin", feed: await readFile(PRESSURE_FEED, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null) };
  return { platform: "linux", reading: await linuxUsable(now) };
}
