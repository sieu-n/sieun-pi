import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bounded, kernelDir, kernelFile } from "./kernel-read.ts";
import { DAEMON_UNIT, envOwner, harnessSplit, type HarnessSplit, NO_OWNER, ownCommand, snapshot as rigSnapshot, type Snapshot as RigSnapshot, SSH_OWNER } from "./rig-cpu.ts";
import { type CpuGroup, cpuGroups, cpuSnapshot, type CpuSnapshot } from "./cpu-groups.ts";

/**
 * One box's CPU, memory and turn queue, read on the box itself. The relay serves it as GET /v1/host, and sieun-pi reads its own box the same
 * way, so Settings > Hosts shows every box from one reader. It imports nothing outside Node and its own folder, because the relay is installed
 * alone with the files install.mjs copies.
 */
const run = promisify(execFile);

export type MemoryPressure = "normal" | "warn" | "critical";
export const MEMORY_GROUPS = ["agents", "services", "jobs", "dev", "ci", "docker", "browsers", "coding", "system", "files", "other"] as const;
export type MemoryGroupId = (typeof MEMORY_GROUPS)[number];
/**
 * One memory group: its bytes and its 3 largest holders (a chat tree, a pm2 app, an app with its helpers, a systemd unit, a job). On Linux
 * `bytes` is the memory the box cannot take back (`heldBytes`) and `swapBytes` the part of it in swap, so `bytes` less `swapBytes` is the
 * group's RAM, and the groups' RAM adds up to usedBytes; a macOS group has no `swapBytes`. Each holder of `top` has its own `swapBytes` the same way.
 */
export interface MemoryGroup { id: MemoryGroupId; label: string; bytes: number; swapBytes?: number; top: { label: string; bytes: number; swapBytes?: number }[] }
export interface MachineView {
  platform: "darwin" | "linux";
  /** Busy share of all cores since the previous reading, 0 to 100. */
  cpu: { percent: number; cores: number; load: [number, number, number];
    /**
     * The busy cores by group over the same window as `percent`, largest first, adding up to percent of cores (cpu-groups.ts); absent on
     * macOS, on a relay older than 10-28 and on the first reading after a start.
     */
    groups?: CpuGroup[] };
  /**
   * On macOS usedBytes counts app, wired and compressed memory, as Activity Monitor's "Memory Used" does, and the groups are the pressure
   * feed's owners by footprint. On Linux usedBytes is MemTotal minus MemAvailable, and the groups are what the leaf cgroups hold that the
   * box cannot take back (`heldBytes`) with the kernel's own share in System (`kernelItems`), so their RAM adds up to usedBytes.
   */
  memory: { usedBytes: number; totalBytes: number; swapUsedBytes: number | null; swapTotalBytes: number | null; pressure: MemoryPressure | null;
    /** Largest first; null when the macOS feed is stale or the cgroup tree is unreadable. */
    groups: MemoryGroup[] | null;
    /** The leaf cgroups' file cache, which the box takes back when it needs the room; absent on macOS and from a relay older than 10-19. */
    cacheBytes?: number | null };
}
/** The box's own `pi-pool queue --json` and `pi-pool config`, passed on unparsed: sieun-pi parses them at its edge. */
export type PoolReading = { queue: unknown; config: unknown } | { error: string };
export interface HostStats { machine: MachineView; pool: PoolReading }

type CpuSample = { busy: number; total: number; cores: number };
/**
 * All cores' busy and total ticks, and the online core count. On Linux they come from /proc/stat's "cpu" and "cpuN" lines, with the fields
 * libuv's os.cpus() sums (user, nice, system, idle, irq). os.cpus() also reads each core's cpufreq file, and on 10-19 at load 150 to 520 on
 * us-metal02 a scratch serve's machineView spent 1.0 and 1.6 s of main thread in single os.cpus() calls, its two longest tasks.
 */
export function cpuSample(stat: string | null = process.platform === "linux" ? procStat() : null): CpuSample {
  let busy = 0, total = 0, cores = 0;
  if (stat !== null) {
    for (const line of stat.split("\n")) {
      if (/^cpu\d/.test(line)) { cores++; continue; }
      if (!line.startsWith("cpu ")) continue;
      const [user = 0, nice = 0, sys = 0, idle = 0, , irq = 0] = line.trim().split(/\s+/).slice(1).map(Number);
      total = user + nice + sys + idle + irq;
      busy = total - idle;
    }
    if (cores) return { busy, total, cores };
  }
  const all = cpus();
  for (const { times } of all) {
    const sum = times.user + times.nice + times.sys + times.irq + times.idle;
    total += sum;
    busy += sum - times.idle;
  }
  return { busy, total, cores: all.length };
}
function procStat(): string | null {
  try { return readFileSync("/proc/stat", "utf8"); } catch { return null; }
}
let previous = cpuSample();
let lastPercent = 0;
/** Busy share of all cores since the previous call, so each poll reports the time since the one before. */
function cpuPercent(next = cpuSample()): { percent: number; cores: number } {
  const total = next.total - previous.total;
  if (total > 0) lastPercent = Math.max(0, Math.min(100, (100 * (next.busy - previous.busy)) / total));
  previous = next;
  return { percent: lastPercent, cores: next.cores };
}

const GB = 1024 ** 3;
export const GROUP_LABELS: Record<MemoryGroupId, string> = { agents: "Agent sessions", services: "Agent services", jobs: "Jobs' servers, builds and tests",
  dev: "Dev servers and app code", ci: "CI runners", docker: "Docker", browsers: "Browsers", coding: "Coding tools", system: "System",
  files: "Files in /tmp and shared memory", other: "Other" };

type Item = { id: MemoryGroupId; label: string; bytes: number; swapBytes?: number };
/** RAM first: what an item holds less its part in swap. */
const ram = (item: { bytes: number; swapBytes?: number }): number => item.bytes - (item.swapBytes ?? 0);
/** The items summed into groups, items of one group with one label merged (a job's several units), each group and its top by RAM. */
function grouped(items: Item[], always: MemoryGroupId[]): MemoryGroup[] {
  const groups = new Map<MemoryGroupId, Map<string, Item>>(MEMORY_GROUPS.map(id => [id, new Map()]));
  for (const item of items) {
    const members = groups.get(item.id)!, same = members.get(item.label);
    members.set(item.label, same ? { ...same, bytes: same.bytes + item.bytes, ...same.swapBytes !== undefined || item.swapBytes !== undefined
      ? { swapBytes: (same.swapBytes ?? 0) + (item.swapBytes ?? 0) } : {} } : item);
  }
  return [...groups].map(([id, members]): MemoryGroup => {
    const top = [...members.values()].sort((a, b) => ram(b) - ram(a));
    const swapped = top.some(item => item.swapBytes !== undefined);
    return { id, label: GROUP_LABELS[id], bytes: top.reduce((sum, item) => sum + item.bytes, 0),
      ...swapped ? { swapBytes: top.reduce((sum, item) => sum + (item.swapBytes ?? 0), 0) } : {},
      top: top.slice(0, 3).map(({ label, bytes, swapBytes }) => ({ label, bytes, ...swapBytes ? { swapBytes } : {} })) };
  }).filter(group => group.bytes > 0 || always.includes(group.id)).sort((a, b) => ram(b) - ram(a));
}

/** ops guy's Mac-wide feed, schema v1, rewritten every 10 s. A reading older than FEED_FRESH_MS (three missed writes) is stale. */
export const PRESSURE_FEED = join(homedir(), ".cache", "virev", "mac-pressure.json");
export const FEED_FRESH_MS = 30_000;

/**
 * The group of a pressure feed owner key (scripts/sieun/mac/pressure-feed.c in auto-sns-agent), first match. The feed already folds helpers
 * into their app and a process tree into its chat or pm2 app, so the key alone decides. Root processes such as WindowServer and kernel_task
 * have no owner rows, so System gets the feed's wired memory instead. The chat service and pi-pool are agent services (CGROUP_RULES).
 */
export const GROUP_RULES: [MemoryGroupId, RegExp][] = [
  ["services", /^other:(chat-service|pi-pool|pool\.py)/i],
  ["agents", /^chat:|^other:(prime-agent|rlm)/i],
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
  const [vm, sysctl, byGroup] = await Promise.all([
    run("vm_stat").then(out => parseVmStat(out.stdout), () => null),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]).then(out => parseSysctl(out.stdout), () => ({ pressure: null, swapUsedBytes: null, swapTotalBytes: null })),
    memoryByGroup(),
  ]);
  return { usedBytes: vm ?? totalBytes - freemem(), totalBytes, ...sysctl, ...byGroup };
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

/** Who holds some memory in Settings > Hosts: its group and the name the group's list shows. */
export interface Holder { id: MemoryGroupId; label: string }

/**
 * The units installed under the user's app.slice that are not agent services, by group. Every other installed unit there serves the harness
 * (the chat services, pi-pool, the relay, prime-sync, the watchdog, the feeds), and every transient unit is a job's (`leafHolder`).
 */
const INSTALLED_UNITS: [MemoryGroupId, RegExp][] = [
  ["dev", /^(auto-sns-dev-pm2|box-devserver-heal|llm-wiki|b2-viewer)\.service$/],
  ["ci", /^ci-(cache|monitor)\.service$/],
  ["coding", /code-server|cursor|vscode/],
  ["system", /^(dbus|ssh-agent|gpg-agent[\w-]*|at-spi[\w-]*)\.(service|socket)$/],
];
const APP_UNIT = /^user\.slice\/user-\d+\.slice\/user@\d+\.service\/app\.slice\/([^/]+)/;
const LOGIN_SCOPE = /^user\.slice\/user-\d+\.slice\/session-[^/]+\.scope$/;
/**
 * The group of a cgroup path under /sys/fs/cgroup outside the user's app.slice, first match. The dev half of us-metal02 is dev.slice and the
 * CI half is virev.slice, with its production servers in virev-prod.slice; the box's CI runner slots run as system.slice/system-ci02\x2dslot.slice.
 */
const PATH_RULES: [MemoryGroupId, RegExp][] = [
  ["dev", /^virev\.slice\/virev-prod/],
  ["ci", /^virev\.slice\/|virev-ci|virev\\x2dci|ci02\\x2dslot/],
  ["docker", /docker|containerd|^machine\.slice\//],
  ["dev", /^dev\.slice\//],
  ["coding", /code-server|cursor|vscode/],
  ["system", /^system\.slice\/|^init\.scope$|^user\.slice\/user-\d+\.slice\/user@\d+\.service\//],
];

let transientRead: { at: number; units: ReadonlySet<string> } | null = null;
/**
 * The units systemd started at run time for this user (systemd-run, `heavy`, Chrome's app scopes, a kernel's own scope), from
 * /run/user/<uid>/systemd/transient, read again after 10 s. rig-cpu.ts tells a job's rig from an installed unit the same way.
 */
export function transientUnits(now = Date.now()): ReadonlySet<string> {
  if (transientRead && now - transientRead.at < 10_000) return transientRead.units;
  let units: string[] = [];
  try { units = readdirSync(`/run/user/${process.getuid?.() ?? 0}/systemd/transient`); } catch {}
  transientRead = { at: now, units: new Set(units) };
  return transientRead.units;
}

/**
 * Who holds a memory leaf (`memoryLeaves`), or "by-process" for a leaf whose processes split between groups: prime-agent-daemon.service runs
 * the supervisor, workers and kernels beside the tests, builds, servers and browsers jobs start there, and an ssh login's session scope runs
 * Prime itself on some days (12:56Z to 16:46Z on 10-27) and Mac jobs' box checks on others. `processHolder` names each of their processes.
 *
 * Under app.slice an installed unit is an agent service unless INSTALLED_UNITS gives it another group, a kernel's own pi-rlm-kernel scope is an
 * agent session, and every other transient unit is a job's (`transient`, `transientUnits`). Until 10-28 a path matched only CGROUP_RULES, so
 * jobs' transient units and the ssh scopes read Other: 43.1 GB of the 69.7 GB the groups summed at 17:15Z on 10-27.
 */
export function leafHolder(path: string, transient: ReadonlySet<string> = transientUnits()): Holder | "by-process" {
  const label = cgroupLabel(path);
  const unit = APP_UNIT.exec(path)?.[1];
  if (unit !== undefined) {
    if (unit === DAEMON_UNIT) return "by-process";
    if (unit.startsWith("pi-rlm-kernel-")) return { id: "agents", label: "Prime kernels" };
    if (transient.has(unit)) return { id: "jobs", label };
    return { id: INSTALLED_UNITS.find(([, rule]) => rule.test(unit))?.[0] ?? "services", label };
  }
  if (LOGIN_SCOPE.test(path)) return "by-process";
  return { id: PATH_RULES.find(([, rule]) => rule.test(path))?.[0] ?? "other", label };
}

const SUPERVISOR_COMMAND = /(?:^|\/)prime-agent --mode daemon --daemon-socket \S*\/daemon\.sock(?:\s|$)/;
/**
 * Who holds a process of a by-process leaf, from its command line (NULs as spaces) and its owner (rig-cpu.ts `envOwner`: the job its environ or
 * a parent's names). The supervisor is the daemon process on daemon.sock and a worker any other `ownCommand` process, both with no owner, since a
 * job's test daemon carries its job's session; a kernel (`-m rlm.repl`) is an agent session's. Every other process is a job's, named by its
 * owner, else NO_OWNER in the daemon's unit and SSH_OWNER in a login scope.
 */
export function processHolder(path: string, proc: { command: string; owner?: string }): Holder {
  if (/\s-m rlm\.repl\b/.test(proc.command)) return { id: "agents", label: "Prime kernels" };
  if (proc.owner === undefined && SUPERVISOR_COMMAND.test(proc.command)) return { id: "services", label: "Prime supervisor" };
  if (proc.owner === undefined && ownCommand(proc.command)) return { id: "agents", label: "Prime workers" };
  return { id: "jobs", label: proc.owner ?? (LOGIN_SCOPE.test(path) ? SSH_OWNER : NO_OWNER) };
}

/**
 * The leaf cgroups at the memory controller's edge under `root`, relative to it, so each byte counts once: a cgroup whose
 * cgroup.subtree_control has no memory. A qemu guest is so its .../libvirt cgroup, never the vcpuN and emulator threads under it, which have no
 * memory files. Until 10-28 the walk went down to cgroups with no child, read those threads, found no memory.stat and left every CI guest out:
 * CI runners read 0.0 GB at 17:15Z on 10-27 while ps put 55 to 85 GB in qemu. A cgroup that cannot be read is left out.
 */
export async function memoryLeaves(root = "/sys/fs/cgroup"): Promise<string[]> {
  const leaves: string[] = [];
  async function walk(relative: string): Promise<void> {
    const dir = relative ? join(root, relative) : root;
    const control = await kernelFile(join(dir, "cgroup.subtree_control")).catch(() => null);
    if (control === null) return;
    if (relative && !control.split(/\s+/).includes("memory")) { leaves.push(relative); return; }
    const children = (await kernelDir(dir).catch(() => [])).filter(entry => entry.isDirectory());
    await Promise.all(children.map(entry => walk(relative ? `${relative}/${entry.name}` : entry.name)));
  }
  await walk("");
  return leaves.sort();
}

/**
 * One leaf cgroup's memory: what its processes hold that the box cannot take back (`bytes`, in RAM or swap), the part of that in swap, its file
 * cache, and the tmpfs and shared memory files charged to it (`fileBytes`, `fileSwapBytes` of them in swap), which outlive the processes that
 * wrote them. `holders` splits `bytes` and `swapBytes` between who holds them: one holder for most leaves, each process's holder for a
 * by-process leaf (`processShares`).
 */
export interface LeafMemory { path: string; bytes: number; swapBytes: number; cacheBytes: number; fileBytes: number; fileSwapBytes: number;
  holders: { holder: Holder; bytes: number; swapBytes: number }[] }

/** The anonymous memory and swap of /proc/<pid>/status in bytes. */
export function processHeld(status: string): { bytes: number; swapBytes: number } {
  const kb = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? 0) * 1024;
  const swapBytes = kb("VmSwap");
  return { bytes: kb("RssAnon") + swapBytes, swapBytes };
}

/**
 * A leaf cgroup's memory from its memory.stat, memory.swap.current and the swap its live processes hold (`processSwap`, the sum of their
 * VmSwap; null when they were not read). Its processes hold their anonymous pages and that swap. Its files are shmem (tmpfs files such as
 * /tmp, which the kernel can only move to swap, never drop) and the cgroup's swap no live process holds, which is such files paged out. File
 * cache (`file` less shmem) is apart, since the box takes it back when it needs the room. Settings > Hosts summed memory.current before 10-19,
 * which counts that cache and reclaimable slab: at 01:11Z on 10-19 the Prime daemon's cgroup read 109.4 GB there with 43.7 GB of anon, 56.5
 * GB of file cache and 8.4 GB of slab, more than the 88.0 GB the whole box used. Until 10-20 the files counted with the processes, so Agent
 * sessions held the auto-sns-agent clones jobs left in /tmp: at 02:20Z on 10-20 the Prime daemon's cgroup had 4.11 GB more swap than all its
 * processes, while /tmp held 3.94 GB of files with 0.18 GB of them in RAM, and d7 read 9.3 GB with no session working at 00:23Z.
 * Null when memory.stat has no anon line.
 */
export function heldBytes(stat: string, swap: string, processSwap: number | null): Omit<LeafMemory, "path" | "holders"> | null {
  const field = (name: string): number | null => { const value = new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1]; return value === undefined ? null : Number(value); };
  const anon = field("anon"), shmem = field("shmem") ?? 0, file = field("file") ?? 0;
  if (anon === null) return null;
  const swapped = Number(swap.trim());
  const cgroupSwap = swap.trim() && Number.isFinite(swapped) ? swapped : 0;
  const swapBytes = processSwap === null ? cgroupSwap : Math.min(cgroupSwap, processSwap);
  const fileSwapBytes = cgroupSwap - swapBytes;
  return { bytes: anon + swapBytes, swapBytes, cacheBytes: Math.max(0, file - shmem), fileBytes: shmem + fileSwapBytes, fileSwapBytes };
}

/** The VmSwap of /proc/<pid>/status in bytes, 0 when it has none. */
export function vmSwap(status: string): number {
  const kb = /^VmSwap:\s+(\d+) kB/m.exec(status)?.[1];
  return kb === undefined ? 0 : Number(kb) * 1024;
}

/** The swap the processes of a cgroup's `cgroup.procs` hold; a process that exited meanwhile counts 0. */
export async function processSwap(procs: string): Promise<number> {
  const pids = procs.split("\n").filter(pid => /^\d+$/.test(pid));
  const swaps = await Promise.all(pids.map(pid => kernelFile(`/proc/${pid}/status`).then(vmSwap, () => 0)));
  return swaps.reduce((sum, bytes) => sum + bytes, 0);
}

/** One process of a by-process leaf as `processShares` weighs it: its holder and its RssAnon and VmSwap (`processHeld`). */
export interface ProcessShare { holder: Holder; bytes: number; swapBytes: number }
/**
 * A by-process leaf's `bytes` and `swapBytes` split between its processes' holders in proportion to what each holds, so the parts add up to
 * the cgroup's own count: RssAnon counts a forked child's shared pages twice, and a process that exits leaves the cgroup's count first.
 * A leaf none of whose live processes hold anything goes to `fallback` whole.
 */
export function processShares(leaf: { bytes: number; swapBytes: number }, procs: readonly ProcessShare[], fallback: Holder): LeafMemory["holders"] {
  const ram = leaf.bytes - leaf.swapBytes;
  const byHolder = new Map<string, ProcessShare>();
  for (const proc of procs) {
    const key = `${proc.holder.id}\0${proc.holder.label}`;
    const entry = byHolder.get(key) ?? { holder: proc.holder, bytes: 0, swapBytes: 0 };
    entry.bytes += proc.bytes - proc.swapBytes;
    entry.swapBytes += proc.swapBytes;
    byHolder.set(key, entry);
  }
  const parts = [...byHolder.values()];
  const procRam = parts.reduce((sum, part) => sum + part.bytes, 0), procSwap = parts.reduce((sum, part) => sum + part.swapBytes, 0);
  if (!(procRam > 0) && !(procSwap > 0)) return [{ holder: fallback, bytes: leaf.bytes, swapBytes: leaf.swapBytes }];
  // A side the processes hold none of goes by the other side's weights, so the parts still add up to the leaf.
  const ramWeight = (part: ProcessShare): number => procRam > 0 ? part.bytes / procRam : part.swapBytes / procSwap;
  const swapWeight = (part: ProcessShare): number => procSwap > 0 ? part.swapBytes / procSwap : part.bytes / procRam;
  return parts.map(part => {
    const swapBytes = Math.round(leaf.swapBytes * swapWeight(part));
    return { holder: part.holder, bytes: Math.round(ram * ramWeight(part)) + swapBytes, swapBytes };
  }).filter(part => part.bytes > 0);
}

/** Each live process of a cgroup's `procs` with its holder (`processHolder`) and its anonymous memory and swap. */
async function processesOf(path: string, procs: string): Promise<ProcessShare[]> {
  const pids = procs.split("\n").filter(pid => /^\d+$/.test(pid)).map(Number);
  const read = await Promise.all(pids.map(async pid => {
    const [status, command] = await Promise.all([kernelFile(`/proc/${pid}/status`).catch(() => null), kernelFile(`/proc/${pid}/cmdline`).catch(() => null)]);
    if (status === null || command === null) return null;
    const owner = await envOwner(pid).catch(() => undefined);
    return { holder: processHolder(path, { command: command.replaceAll("\0", " ").trim(), ...owner ? { owner } : {} }), ...processHeld(status) };
  }));
  return read.filter(proc => proc !== null);
}

/** The job a job's unit belongs to, from the first of its processes whose environ, or a parent's, names one (rig-cpu.ts `envOwner`). */
async function unitOwner(procs: string): Promise<string | undefined> {
  for (const pid of procs.split("\n").filter(pid => /^\d+$/.test(pid)).slice(0, 8)) {
    const owner = await envOwner(Number(pid)).catch(() => undefined);
    if (owner) return owner;
  }
  return undefined;
}

/**
 * The memory leaves under `root` (`memoryLeaves`) with their memory (`heldBytes`) and who holds it (`leafHolder`, `processHolder`). A job's
 * unit takes its job's name when one of its processes names it (`unitOwner`), else its unit's. A cgroup that cannot be read is left out.
 */
export async function leafCgroups(root = "/sys/fs/cgroup", transient: ReadonlySet<string> = transientUnits()): Promise<LeafMemory[]> {
  const leaves = await Promise.all((await memoryLeaves(root)).map(async (path): Promise<LeafMemory | null> => {
    const dir = join(root, path);
    const [stat = null, swap = null, procs = null] = await Promise.all(["memory.stat", "memory.swap.current", "cgroup.procs"].map(name => kernelFile(join(dir, name)).catch(() => null)));
    const swapped = Number(swap?.trim() || 0) > 0;
    const held = heldBytes(stat ?? "", swap ?? "", swapped && procs !== null ? await processSwap(procs) : null);
    if (!held || !(held.bytes > 0 || held.cacheBytes > 0 || held.fileBytes > 0)) return null;
    const holder = leafHolder(path, transient);
    if (holder === "by-process") {
      const fallback: Holder = LOGIN_SCOPE.test(path) ? { id: "jobs", label: SSH_OWNER } : { id: "agents", label: "Prime workers" };
      return { path, ...held, holders: processShares(held, held.bytes > 0 && procs !== null ? await processesOf(path, procs) : [], fallback) };
    }
    const owner = holder.id === "jobs" && procs !== null ? await unitOwner(procs) : undefined;
    return { path, ...held, holders: [{ holder: owner ? { id: "jobs", label: owner } : holder, bytes: held.bytes, swapBytes: held.swapBytes }] };
  }));
  return leaves.filter(leaf => leaf !== null);
}

/** A readable name for a cgroup: a login session names its user id, a qemu guest its domain name, a container its id's first 12 characters, and a unit drops its suffix. */
export function cgroupLabel(path: string): string {
  const login = /user-(\d+)\.slice\/session-([^/]+)\.scope$/.exec(path);
  if (login) return `${login[1] === "0" ? "root" : `uid ${login[1]}`} login session ${login[2]}`;
  const parts = path.split("/").map(part => part.replace(/\\x2d/g, "-"));
  const leaf = parts.length > 1 && /^(libvirt|emulator|vcpu\d+)$/.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1)!;
  return leaf.replace(/^machine-qemu-\d+-/, "").replace(/^(docker-[0-9a-f]{12})[0-9a-f]{52}\b/, "$1").replace(/\.(service|scope|slice)$/, "");
}

/**
 * The kernel's own share of used memory (MemTotal less MemAvailable) as System items, from /proc/meminfo and /proc/zoneinfo, and the process
 * memory the box counted that the leaf cgroups' `cgroupRam` (their anon and shmem in RAM) did not, which is memory that changed while the leaves
 * were read. MemAvailable is MemFree less the free pages the kernel keeps back (each zone's high watermark and lowmem protection), plus the file
 * cache and reclaimable slab less a low watermark of each (mm/show_mem.c si_mem_available), so those three count as used. Free pages on the
 * per-CPU lists are not in MemFree either: at 17:20Z on 10-27 on us-metal02, with 80 CPUs, they held 6.7 GB, the watermarks 7.7 GB, the cache's
 * low watermarks 6.4 GB, and used read 143.4 GB. Null when either file does not parse.
 */
export function kernelItems(meminfo: string, zoneinfo: string, cgroupRam: number, pageSize = 4096): { system: (Holder & { bytes: number })[]; unread: number } | null {
  const kb = (name: string): number | null => { const value = new RegExp(`^${name.replace(/[()]/g, "\\$&")}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]; return value === undefined ? null : Number(value) * 1024; };
  const total = kb("MemTotal"), free = kb("MemFree"), available = kb("MemAvailable");
  const zones = zoneinfo.split(/^Node /m).slice(1);
  if (total === null || free === null || available === null || !zones.length) return null;
  const pages = (zone: string, name: string): number => Number(new RegExp(`^\\s+${name}\\s+(\\d+)$`, "m").exec(zone)?.[1] ?? 0);
  let reserve = 0, low = 0, perCpu = 0;
  for (const zone of zones) {
    const protection = Math.max(0, ...(/protection: \(([^)]*)\)/.exec(zone)?.[1] ?? "").split(",").map(Number).filter(Number.isFinite));
    reserve += Math.min(protection + pages(zone, "high"), pages(zone, "managed"));
    low += pages(zone, "low");
    for (const count of zone.matchAll(/^\s+count:\s+(\d+)$/gm)) perCpu += Number(count[1]);
  }
  const cache = (kb("Active(file)") ?? 0) + (kb("Inactive(file)") ?? 0), slab = kb("KReclaimable") ?? kb("SReclaimable") ?? 0;
  const heldBack = Math.min(Math.floor(cache / 2), low * pageSize) + Math.min(Math.floor(slab / 2), low * pageSize);
  const named: [string, number][] = [["Free memory the kernel keeps in reserve (watermarks)", reserve * pageSize],
    ["File cache and slab MemAvailable keeps back (low watermarks)", heldBack], ["Free pages on the per-CPU lists", perCpu * pageSize],
    ["Kernel slab it cannot reclaim", kb("SUnreclaim") ?? 0], ["Compressed swap pool (zswap)", kb("Zswap") ?? 0],
    ["Page tables", (kb("PageTables") ?? 0) + (kb("SecPageTables") ?? 0)], ["Per-CPU allocations", kb("Percpu") ?? 0], ["Kernel stacks", kb("KernelStack") ?? 0]];
  const process = (kb("AnonPages") ?? 0) + (kb("Shmem") ?? 0);
  const kernel = total - free - cache - slab - process - named.slice(2).reduce((sum, [, bytes]) => sum + bytes, 0);
  named.push(["Other kernel memory (swap cache, drivers, vmalloc)", Math.max(0, kernel)]);
  return { system: named.filter(([, bytes]) => bytes > 0).map(([label, bytes]) => ({ id: "system", label, bytes })), unread: Math.max(0, process - cgroupRam) };
}

/**
 * The leaves' memory by group, each holder once in its group's list, with the kernel's own items in System (`kernelItems`) when the box's
 * /proc/meminfo and /proc/zoneinfo texts are given.
 */
export function cgroupGroups(leaves: readonly LeafMemory[], proc?: { meminfo: string; zoneinfo: string }): MemoryGroup[] | null {
  if (!leaves.length) return null;
  const kernel = proc ? kernelItems(proc.meminfo, proc.zoneinfo, leafRam(leaves)) : null;
  return grouped([...leaves.flatMap(leaf => [...leaf.holders.filter(part => part.bytes > 0).map(({ holder, bytes, swapBytes }) => ({ ...holder, bytes, swapBytes })),
    ...leaf.fileBytes > 0 ? [{ id: "files" as const, label: cgroupLabel(leaf.path), bytes: leaf.fileBytes, swapBytes: leaf.fileSwapBytes }] : []]),
    ...kernel?.system ?? [], ...kernel && kernel.unread > 0 ? [{ id: "other" as const, label: "Process memory that changed while the cgroups were read", bytes: kernel.unread }] : []], []);
}

/** The RAM the leaves' processes and files hold: their anon and shmem, which /proc/meminfo counts as AnonPages and Shmem. */
const leafRam = (leaves: readonly LeafMemory[]): number => leaves.reduce((sum, leaf) => sum + leaf.bytes - leaf.swapBytes + leaf.fileBytes - leaf.fileSwapBytes, 0);

/**
 * The box's memory by group, the one reading Settings > Hosts draws and the Whole system duty's quiet_agent_gb reads (src/mac-usable-watch.ts
 * `agentLine`), so the two cannot disagree: on Linux the leaf cgroups' held memory and the kernel's own share, with their file cache beside
 * it, on macOS the pressure feed's owners by footprint. A call while a Linux walk is still out joins it (kernel-read.ts `bounded`), so a hung
 * cgroup file is read once.
 */
export async function memoryByGroup(): Promise<{ groups: MemoryGroup[] | null; cacheBytes?: number | null }> {
  if (process.platform === "darwin") return { groups: memoryGroups(await readFile(PRESSURE_FEED, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null), Date.now()) };
  return (await bounded("leaf cgroups", async () => {
    const leaves = await leafCgroups();
    const [meminfo, zoneinfo] = await Promise.all(["/proc/meminfo", "/proc/zoneinfo"].map(path => kernelFile(path).catch(() => "")));
    return { groups: cgroupGroups(leaves, { meminfo: meminfo!, zoneinfo: zoneinfo! }), cacheBytes: leaves.length ? leaves.reduce((sum, leaf) => sum + leaf.cacheBytes, 0) : null };
  }))!;
}

async function linuxMemory(): Promise<MachineView["memory"]> {
  const [meminfo, psi, byGroup] = await Promise.all([
    kernelFile("/proc/meminfo").then(parseMeminfo, () => null),
    kernelFile("/proc/pressure/memory").then(parsePsi, () => null),
    memoryByGroup(),
  ]);
  const totalBytes = totalmem();
  return { ...(meminfo ?? { usedBytes: totalBytes - freemem(), totalBytes, swapUsedBytes: null, swapTotalBytes: null }), pressure: psi, ...byGroup };
}

/**
 * The CPU groups' last snapshot and the groups it ended. Two readers that poll at once join one snapshot (kernel-read.ts `bounded`) and get
 * the same groups, and `cpuPercent` reads the same /proc/stat text, so the groups and the percent cover one window.
 */
let lastCpu: { snapshot: CpuSnapshot; groups?: CpuGroup[] } | null = null;
const readCpu = async (): Promise<CpuSnapshot> => (await bounded("cpu groups", async () => cpuSnapshot(await memoryLeaves(), path => leafHolder(path))))!;
if (process.platform === "linux") void readCpu().then(snapshot => { if (!lastCpu && snapshot.stat) { lastCpu = { snapshot }; previous = cpuSample(snapshot.stat); } }, () => {});
async function linuxCpu(): Promise<Omit<MachineView["cpu"], "load">> {
  const snapshot = await readCpu();
  const { percent, cores } = cpuPercent(cpuSample(snapshot.stat || null));
  if (snapshot !== lastCpu?.snapshot) {
    const classifier = { leafHolder: (path: string) => leafHolder(path), processHolder, groupLabels: GROUP_LABELS };
    const groups = lastCpu ? cpuGroups(lastCpu.snapshot, snapshot, classifier, (percent * cores) / 100, cores) : null;
    lastCpu = { snapshot, ...groups ? { groups } : {} };
  }
  return { percent, cores, ...lastCpu.groups ? { groups: lastCpu.groups } : {} };
}

export async function machineView(): Promise<MachineView> {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const memory = platform === "darwin" ? await macMemory() : await linuxMemory();
  const cpu = platform === "linux" ? await linuxCpu() : cpuPercent();
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { platform, cpu: { ...cpu, load: [one, five, fifteen] }, memory };
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

/** The box's machine reading and turn queue; `readPool` stands in for this box's pi-pool in tests. */
export async function hostStats(readPool: () => Promise<PoolReading> = poolReading): Promise<HostStats> {
  const [machine, pool] = await Promise.all([machineView(), readPool()]);
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
 * 1.0 means one runnable task for each of those CPUs. With no pins that is every CPU of the box, and a Virev VM's vCPU time counts as load
 * there like any other task.
 */
export interface LinuxUsable { kind: "linux"; memSomeAvg10: number; memFullAvg10: number; cpuSomeAvg10: number; swapoutsPerS: number | null; runnablePerCore: number; allowedCpus: number;
  /** Each side's CPU time over the same window, in cores (`cpuSides`); absent on readings before 10-18 06:5xZ and where the cgroups cannot be read. */
  cpuCores?: CpuSides;
  /** The harness side's cores split into its own work and the rigs jobs started, with the owners of the most (rig-cpu.ts); absent on readings written before it. */
  harnessSplit?: HarnessSplit }
/** Who CPU time on a Linux box belongs to: the harness (agents and the services that run them), the apps' servers, the owner, CI and the OS. */
export type CpuSide = "harness" | "apps" | "owner" | "ci" | "system";
export type CpuSides = Record<CpuSide, number>;
export const CPU_SIDES: readonly CpuSide[] = ["harness", "apps", "owner", "ci", "system"];
/**
 * The cgroups each side's CPU time is read from, under /sys/fs/cgroup, with {app} for user@<uid>.service/app.slice in this process's
 * user-<uid>.slice. The harness is that whole user slice (the Prime daemon and its workers, the chat service, pi-pool, the relay, agents'
 * ssh sessions and their transient units) less the units named here for another side, so a unit that ends inside the window still counts.
 * Virev's CI VMs and production servers in virev.slice count in full, because on 10-18 from 07:45Z metal-management removed the CPU pins on
 * us-metal02's slices and they run on the same 80 CPUs as the harness.
 */
export const SIDE_CGROUPS: Readonly<Record<Exclude<CpuSide, "harness">, readonly string[]>> = {
  apps: ["dev.slice", "{app}/auto-sns-dev-pm2.service", "{app}/box-devserver-heal.service", "virev.slice/virev-prod.slice"],
  owner: ["{app}/code-server.service"],
  ci: ["{app}/ci-cache.service", "{app}/ci-monitor.service", "virev.slice/virev-ci.slice"],
  system: ["system.slice"],
};
/** usage_usec of a cgroup's cpu.stat; null when the line is absent. */
export function parseUsageUsec(text: string): number | null {
  const value = /^usage_usec (\d+)$/m.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}
/** This process's user-<uid>.slice and its user@<uid>.service/app.slice, from a /proc/self/cgroup text; null outside a user slice. */
export function userSlice(cgroup: string): { slice: string; app: string } | null {
  const match = /^0::\/(user\.slice\/user-(\d+)\.slice)(?:\/|$)/m.exec(cgroup);
  return match ? { slice: match[1]!, app: `${match[1]}/user@${match[2]}.service/app.slice` } : null;
}
/**
 * Each side's cores between two cgroup readings `ms` apart. A counter that went back (a unit restarted) counts its new value, a cgroup missing
 * from the later reading counts 0, and the harness is its slice less the other sides' units under it. Null without both slice readings.
 */
export function cpuSides(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, slice: { slice: string; app: string }, ms: number): CpuSides | null {
  const from = before.get(slice.slice), to = after.get(slice.slice);
  if (from === undefined || to === undefined || !(ms > 0)) return null;
  const used = (path: string): number => {
    const end = after.get(path);
    if (end === undefined) return 0;
    const start = before.get(path) ?? 0;
    return end >= start ? end - start : end;
  };
  const cores = (usec: number): number => Math.round(100 * Math.max(0, usec) / (ms * 1000)) / 100;
  const sides = { harness: 0, apps: 0, owner: 0, ci: 0, system: 0 } satisfies CpuSides;
  let inSlice = 0;
  for (const [side, paths] of Object.entries(SIDE_CGROUPS) as [Exclude<CpuSide, "harness">, readonly string[]][]) {
    for (const template of paths) {
      const path = template.replace("{app}", slice.app);
      const usec = used(path);
      sides[side] += usec;
      if (path.startsWith(`${slice.slice}/`)) inSlice += usec;
    }
  }
  sides.harness = used(slice.slice) - inSlice;
  return Object.fromEntries(CPU_SIDES.map(side => [side, cores(sides[side])])) as CpuSides;
}
const CGROUP_ROOT = "/sys/fs/cgroup";
const readText = (path: string): string => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const ownSlice = process.platform === "linux" ? userSlice(readText("/proc/self/cgroup")) : null;
/**
 * The usage_usec of the user slice and of every cgroup SIDE_CGROUPS names, by path; a cgroup that cannot be read is left out. The reads are
 * async, off the main thread: on 10-20 from 11:45Z to 13:08Z one readFileSync of a cpu.stat here held the live chat's event loop for 83 min,
 * while systemd killed hung `ss` reads of the box textfile collector, and the chat's CPU profile ended in readCgroups. They run in the cgroup
 * lane (kernel-read.ts), so a hung cgroup file holds one thread-pool thread and no more.
 */
async function readCgroups(slice: { slice: string; app: string } | null): Promise<Map<string, number> | undefined> {
  if (!slice) return undefined;
  const paths = [slice.slice, ...Object.values(SIDE_CGROUPS).flat().map(template => template.replace("{app}", slice.app))];
  const texts = await Promise.all(paths.map(path => kernelFile(join(CGROUP_ROOT, path, "cpu.stat")).catch(() => "")));
  return new Map(paths.flatMap((path, at) => { const usec = parseUsageUsec(texts[at]!); return usec === null ? [] : [[path, usec] as const]; }));
}
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
type Sched = { at: number; times: Map<number, number>; cgroups?: Map<string, number> };
const loadSchedstat = (): Sched | null => {
  const times = parseSchedstat(readText("/proc/schedstat"));
  return times ? { at: Date.now(), times } : null;
};
let lastSched = process.platform === "linux" ? loadSchedstat() : null;
/** Resolves once the load-time reading has its cgroups, which `schedstatMark` then carries. */
export const loadedCgroups: Promise<void> = lastSched
  ? (first => bounded("cgroups", () => readCgroups(ownSlice)).then(cgroups => { if (cgroups && lastSched === first) first.cgroups = cgroups; }))(lastSched) : Promise.resolve();
/** The units under app.slice that SIDE_CGROUPS gives another side, which the harness split leaves out. */
const SIDE_UNITS = new Set(Object.values(SIDE_CGROUPS).flat().filter(path => path.startsWith("{app}/")).map(path => path.slice("{app}/".length)));
const readRigs = async (now: number): Promise<RigSnapshot | null> => ownSlice && process.getuid ? await rigSnapshot(ownSlice.app, SIDE_UNITS, process.getuid(), now) : null;
let lastRigs: RigSnapshot | null = null;
if (process.platform === "linux") void bounded("rigs", () => readRigs(Date.now())).then(read => { lastRigs ??= read ?? null; });
/** Where the next linuxUsable window starts: the last reading's time, per-CPU nanoseconds and cgroup usage_usec; null before the module could read schedstat. */
export type SchedstatMark = { at: number; times: Record<string, number>; cgroups?: Record<string, number> };
export const schedstatMark = (): SchedstatMark | null => lastSched && { at: lastSched.at, times: Object.fromEntries(lastSched.times),
  ...lastSched.cgroups ? { cgroups: Object.fromEntries(lastSched.cgroups) } : {} };
/**
 * Starts the next linuxUsable window at `mark`, the last reading of the process before a restart, so the first line after it averages over the
 * same span as any other line. False, and the window stays at the module's load, when the mark is malformed, not older than this module's
 * baseline, or a counter went back since it (a reboot).
 */
export function seedSchedstat(mark: unknown): boolean {
  const { at, times, cgroups } = (mark ?? {}) as { at?: unknown; times?: unknown; cgroups?: unknown };
  if (!lastSched || typeof at !== "number" || !(at < lastSched.at) || !times || typeof times !== "object") return false;
  const seeded = new Map<number, number>();
  for (const [cpu, ns] of Object.entries(times)) {
    const now = lastSched.times.get(Number(cpu));
    if (typeof ns !== "number" || now === undefined || ns > now) return false;
    seeded.set(Number(cpu), ns);
  }
  if (seeded.size !== lastSched.times.size) return false;
  const usage = cgroups && typeof cgroups === "object" ? new Map(Object.entries(cgroups).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : undefined;
  // A cgroup the last process did not read starts at this module's load, never at 0: release-a71b8cb added virev-ci.slice, and its first
  // line on 10-18 at 07:54:12Z counted the slice's whole life since boot as 3874 cores of CI in one window.
  if (usage) for (const [path, usec] of lastSched.cgroups ?? []) if (!usage.has(path)) usage.set(path, usec);
  lastSched = { at, times: seeded, ...usage ? { cgroups: usage } : {} };
  return true;
}
/**
 * The box's LinuxUsable now. The first call's window starts at the mark seedSchedstat took, else when this module loaded, so the watch line
 * a chat restart writes carries a reading. Null, so the box reads unknown, when /proc/pressure/memory, /proc/schedstat or this process's CPU set cannot be read.
 * Each of its three reads (the /proc files, the cgroups, the rigs) answers by `cut` (kernel-read.ts `bounded`) and adds its name to `unread`
 * when it does not: unread /proc files make the reading null and leave the window where it was, unread cgroups leave out cpuCores and unread
 * rigs the harness split, so the watch line of a minute with a hung cgroup file still carries the box's memory and run queue.
 */
export async function linuxUsable(now = Date.now(), cut?: Promise<unknown>, unread?: string[]): Promise<LinuxUsable | null> {
  const texts = await bounded("proc", () => Promise.all(["/proc/pressure/memory", "/proc/pressure/cpu", "/proc/vmstat", "/proc/schedstat", "/proc/self/status"]
    .map(path => kernelFile(path).catch(() => ""))), cut, unread);
  if (!texts) return null;
  const [memory, cpu, vmstat, schedstat, status] = texts;
  const memSome = psiAvg10(memory!, "some"), memFull = psiAvg10(memory!, "full");
  const pages = parsePswpout(vmstat!);
  const previous = lastSwap;
  lastSwap = pages === null ? null : { at: now, pages };
  const swapoutsPerS = pages !== null && previous && now > previous.at ? Math.max(0, (pages - previous.pages) * 1000 / (now - previous.at)) : null;
  const times = parseSchedstat(schedstat!);
  const before = lastSched;
  const cgroups = await bounded("cgroups", () => readCgroups(ownSlice), cut, unread);
  lastSched = times ? { at: now, times, ...cgroups ? { cgroups } : {} } : null;
  const cores = parseCpusAllowed(status!);
  const runnable = times && before && cores ? runnablePerCore(before.times, times, cores, now - before.at) : null;
  if (memSome === null || memFull === null || runnable === null || !cores) return null;
  const sides = ownSlice && cgroups && before?.cgroups ? cpuSides(before.cgroups, cgroups, ownSlice, now - before.at) : null;
  const rigs = await bounded("rigs", () => readRigs(now), cut, unread) ?? null;
  const split = sides && lastRigs && rigs ? harnessSplit(lastRigs, rigs, sides.harness) : null;
  lastRigs = rigs;
  return { kind: "linux", memSomeAvg10: memSome, memFullAvg10: memFull, cpuSomeAvg10: psiAvg10(cpu!, "some") ?? 0,
    swapoutsPerS: swapoutsPerS === null ? null : Math.round(swapoutsPerS), runnablePerCore: Math.round(100 * runnable) / 100, allowedCpus: cores.length,
    ...sides ? { cpuCores: sides } : {}, ...split ? { harnessSplit: split } : {} };
}

/** What a box reads for its usability: the raw pressure feed on macOS (the chat service parses it), the LinuxUsable reading on Linux. */
export type UsableRaw = { platform: "darwin"; feed: unknown } | { platform: "linux"; reading: LinuxUsable | null };
export async function usableRaw(now = Date.now()): Promise<UsableRaw> {
  if (process.platform === "darwin") return { platform: "darwin", feed: await readFile(PRESSURE_FEED, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null) };
  return { platform: "linux", reading: await linuxUsable(now) };
}
