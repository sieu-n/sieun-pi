import { join } from "node:path";
import type { Holder, MemoryGroupId } from "./host-stats.ts";
import { kernelFile } from "./kernel-read.ts";
import { envOwner, parseProcStat } from "./rig-cpu.ts";

/**
 * The box's busy cores by the memory groups' holders (host-stats.ts `leafHolder`), asked by the owner on 10-28 ("what's the CPU usage mostly
 * at?") when Settings > Hosts read us-metal02 at 93% CPU with no split. A leaf cgroup's cpu.stat usage_usec counts its own time, and a qemu
 * guest's libvirt cgroup counts its vcpu threads' time. The Prime daemon's cgroup is split by process: its workers, kernels and supervisor go
 * to their holders, and the rest of its time, the processes that ended in the window, goes to jobs. A cgroup whose children ended in the window
 * keeps their time, so what a parent used beyond its live children counts as its ended units: in a 10 s window near 17:20Z on 10-27 app.slice
 * used 19.5 cores more than its live leaves, the run-*.scope tests and builds jobs start and end within seconds. What no cgroup below the root holds,
 * kernel threads and interrupts, is the /proc/stat busy time less all of that, so the groups add up to the busy cores the card shows.
 */
export interface CpuItem { label: string; cores: number }
export interface CpuGroup { id: MemoryGroupId; label: string; cores: number; top: CpuItem[] }
/** A process of a by-process leaf: its start (clock ticks after boot), utime+stime ticks, command line with spaces and owning job. */
export interface CpuProc { leaf: string; start: number; ticks: number; command: string; owner?: string }
/**
 * One reading: the /proc/stat text, usage_usec of each leaf and of each cgroup above a leaf (the root's children down), and the processes of
 * the by-process leaves by pid.
 */
export interface CpuSnapshot { at: number; stat: string; usage: Map<string, number>; leaves: ReadonlySet<string>; procs: Map<number, CpuProc> }
export interface CpuClassifier {
  leafHolder(path: string): Holder | "by-process";
  processHolder(path: string, proc: { command: string; owner?: string }): Holder;
  groupLabels: Readonly<Record<MemoryGroupId, string>>;
}

/** The kernel's clock ticks a second (getconf CLK_TCK), which /proc/<pid>/stat times count in. */
export const TICK_HZ = 100;
export const KERNEL_LABEL = "Kernel and interrupts";
export const ENDED_PROCESSES = "Processes that ended in the window";
/** The label of a cgroup's units that ended in the window, such as "Units that ended under app.slice". */
export const endedUnits = (parent: string): string => `Units that ended under ${parent.split("/").at(-1)!.replace(/\\x2d/g, "-")}`;
/**
 * Where a parent cgroup's ended units count. Under the user's slice, its user manager and its app.slice they are the transient units, run-*.scope
 * runs and ssh session scopes jobs start (rig-cpu.ts). Elsewhere they count to the group all the parent's live leaves share, such as CI for
 * system-virev\x2dci\x2dvirt.slice, whose virev-ci-virt@ VMs ended 1.8 cores' worth in the 3 s fixture window of 10-27, else to the holder of a
 * path under the parent.
 */
export function endedHolder(parent: string, leafHolder: CpuClassifier["leafHolder"], liveGroups: ReadonlySet<MemoryGroupId> = new Set()): Holder {
  const label = endedUnits(parent);
  if (/^user\.slice\/user-\d+\.slice(?:\/user@\d+\.service(?:\/app\.slice)?)?$/.test(parent)) return { id: "jobs", label };
  if (liveGroups.size === 1) return { id: [...liveGroups][0]!, label };
  const holder = leafHolder(`${parent}/`);
  return { id: holder === "by-process" ? "jobs" : holder.id, label };
}

/** The cgroups above `leaves` (each leaf's ancestors below the root), so each one's ended children are seen. */
export function parentsOf(leaves: Iterable<string>): string[] {
  const parents = new Set<string>();
  for (const leaf of leaves) for (let at = leaf.indexOf("/"); at > 0; at = leaf.indexOf("/", at + 1)) parents.add(leaf.slice(0, at));
  return [...parents];
}

/**
 * The busy cores between two snapshots by group, largest first, each with its 3 busiest holders. `busyCores` is the card's CPU percent of all
 * cores over the same window, and the groups add up to it: a leaf counts its usage_usec growth, a parent its growth beyond its live children's,
 * and System gets the rest as Kernel and interrupts. When the cgroups read more than `busyCores` (their files and /proc/stat are read a few
 * milliseconds apart), every item shrinks by the same share. A counter that went back counts its new value, and a cgroup new in the window
 * counts its whole usage, up to the window's CPU time. A process alive at both ends counts its ticks between them, one started in the window
 * all of them. Null for an empty window.
 */
export function cpuGroups(before: CpuSnapshot, after: CpuSnapshot, classify: CpuClassifier, busyCores: number, cores: number, tickHz = TICK_HZ): CpuGroup[] | null {
  const ms = after.at - before.at;
  if (!(ms > 0)) return null;
  const seconds = (usec: number): number => usec / 1e6;
  const grown = (path: string): number => {
    const end = after.usage.get(path), start = before.usage.get(path);
    if (end === undefined) return 0;
    if (start === undefined) return end <= ms * 1000 * cores ? seconds(end) : 0;
    return seconds(end >= start ? end - start : end);
  };
  const items = new Map<string, { id: MemoryGroupId; label: string; seconds: number }>();
  const add = (holder: Holder, time: number): void => {
    if (!(time > 0)) return;
    const key = `${holder.id}\0${holder.label}`;
    const item = items.get(key) ?? { id: holder.id, label: holder.label, seconds: 0 };
    item.seconds += time;
    items.set(key, item);
  };
  const live = new Map<string, number>();
  for (const [pid, proc] of after.procs) {
    const was = before.procs.get(pid);
    const time = (was && was.start === proc.start ? Math.max(0, proc.ticks - was.ticks) : proc.ticks) / tickHz;
    add(classify.processHolder(proc.leaf, proc), time);
    live.set(proc.leaf, (live.get(proc.leaf) ?? 0) + time);
  }
  const children = new Map<string, number>(), liveGroups = new Map<string, Set<MemoryGroupId>>();
  const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const counted = (path: string, time: number): void => { if (parentOf(path)) children.set(parentOf(path), (children.get(parentOf(path)) ?? 0) + time); };
  for (const leaf of after.leaves) {
    const time = grown(leaf), holder = classify.leafHolder(leaf);
    counted(leaf, time);
    const id = holder === "by-process" ? "jobs" : holder.id;
    liveGroups.set(parentOf(leaf), (liveGroups.get(parentOf(leaf)) ?? new Set()).add(id));
    if (holder === "by-process") add({ id, label: ENDED_PROCESSES }, time - (live.get(leaf) ?? 0));
    else add(holder, time);
  }
  const parents = [...after.usage.keys()].filter(path => !after.leaves.has(path)).sort((a, b) => b.split("/").length - a.split("/").length);
  for (const parent of parents) {
    const time = grown(parent);
    add(endedHolder(parent, classify.leafHolder, liveGroups.get(parent)), time - (children.get(parent) ?? 0));
    counted(parent, time);
  }
  const busy = busyCores * ms / 1000;
  add({ id: "system", label: KERNEL_LABEL }, busy - [...items.values()].reduce((sum, item) => sum + item.seconds, 0));
  const total = [...items.values()].reduce((sum, item) => sum + item.seconds, 0);
  const scale = total > busy && total > 0 ? busy / total : 1;
  const toCores = (time: number): number => Math.round(100 * time * scale * 1000 / ms) / 100;
  const groups = new Map<MemoryGroupId, { seconds: number; members: { label: string; seconds: number }[] }>();
  for (const item of items.values()) {
    const group = groups.get(item.id) ?? { seconds: 0, members: [] };
    group.seconds += item.seconds;
    group.members.push(item);
    groups.set(item.id, group);
  }
  return [...groups].map(([id, group]): CpuGroup => ({ id, label: classify.groupLabels[id], cores: toCores(group.seconds),
    top: group.members.sort((a, b) => b.seconds - a.seconds).slice(0, 3).map(member => ({ label: member.label, cores: toCores(member.seconds) })).filter(item => item.cores > 0) }))
    .filter(group => group.cores > 0).sort((a, b) => b.cores - a.cores);
}

const kernel = (path: string): Promise<string> => kernelFile(path).catch(() => "");
const usageUsec = (text: string): number | undefined => { const value = /^usage_usec (\d+)$/m.exec(text)?.[1]; return value === undefined ? undefined : Number(value); };

/**
 * Reads a snapshot of `leaves` (host-stats.ts `memoryLeaves`, paths under `root`) and their parents, and of the processes of each leaf
 * `leafHolder` splits by process. All reads go through kernel-read.ts lanes, so a hung cgroup file holds one thread-pool thread. On
 * us-metal02 at 17:31Z on 10-27 (load 44 to 79 on 80 cores) one snapshot of 214 to 218 cgroups and 261 to 267 daemon processes took 38 to 55
 * ms and 13 to 24 ms of main thread, and the memoryLeaves walk before it 15 to 23 ms and 6 to 11 ms.
 */
export async function cpuSnapshot(leaves: readonly string[], leafHolder: CpuClassifier["leafHolder"], root = "/sys/fs/cgroup", proc = "/proc", at = Date.now()): Promise<CpuSnapshot> {
  const split = leaves.filter(leaf => leafHolder(leaf) === "by-process");
  const paths = [...leaves, ...parentsOf(leaves)];
  const [stat, texts, procs] = await Promise.all([
    kernel(join(proc, "stat")),
    Promise.all(paths.map(path => kernel(join(root, path, "cpu.stat")))),
    Promise.all(split.map(leaf => leafProcs(leaf, root, proc))).then(lists => new Map(lists.flat())),
  ]);
  const usage = new Map<string, number>();
  paths.forEach((path, index) => { const usec = usageUsec(texts[index]!); if (usec !== undefined) usage.set(path, usec); });
  bootTime = Number(/^btime (\d+)$/m.exec(stat)?.[1]) || bootTime;
  commands = seen;
  seen = new Map();
  return { at, stat, usage, leaves: new Set(leaves.filter(leaf => usage.has(leaf))), procs };
}

/** The box's boot time in seconds since the epoch, from the last /proc/stat btime line; NaN before the first snapshot. */
let bootTime = NaN;
/**
 * The command line of each process (by pid and start) older than 2 s at the last snapshot, so a snapshot reads the cmdline of new processes
 * only; a younger one may not have run exec yet. Without the cache one snapshot of us-metal02's 270 to 305 daemon processes on 10-27 at 17:30Z
 * spent 42 to 62 ms of main thread, against 10 to 18 ms for its 226 cgroup files alone.
 */
let commands = new Map<string, string>(), seen = new Map<string, string>();

/** The processes of one leaf from its cgroup.procs, each with its ticks, command and owning job (rig-cpu.ts `envOwner`). */
async function leafProcs(leaf: string, root: string, proc: string): Promise<[number, CpuProc][]> {
  const pids = (await kernel(join(root, leaf, "cgroup.procs"))).split("\n").filter(pid => /^\d+$/.test(pid)).map(Number);
  const stats = new Map<number, { ppid: number; start: number; ticks: number; command: string }>();
  const settled = Date.now() / 1000 - 2;
  await Promise.all(pids.map(async pid => {
    const parsed = parseProcStat(await kernel(join(proc, String(pid), "stat")));
    if (!parsed) return;
    const key = `${pid}:${parsed.start}`;
    const command = commands.get(key) ?? (await kernel(join(proc, String(pid), "cmdline"))).replaceAll("\0", " ").trim().slice(0, 400);
    if (bootTime + parsed.start / TICK_HZ < settled) seen.set(key, command);
    stats.set(pid, { ...parsed, command });
  }));
  return Promise.all([...stats].map(async ([pid, stat]): Promise<[number, CpuProc]> => {
    const owner = await envOwner(pid, stats);
    return [pid, { leaf, start: stat.start, ticks: stat.ticks, command: stat.command, ...owner ? { owner } : {} }];
  }));
}
