import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { FEED_FRESH_MS, PRESSURE_FEED } from "./mac-usable-watch.ts";
import { groupOf } from "./memory-groups.ts";
import type { MachineView, MemoryGroup, MemoryGroupId, MemoryPressure } from "./shared/types.ts";

const run = promisify(execFile);
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

const GB = 1024 ** 3;
const GROUP_LABELS: Record<MemoryGroupId, string> = { agents: "Agent sessions", dev: "Dev servers and app code", docker: "Docker", browsers: "Browsers",
  coding: "Coding tools", system: "System", other: "Other" };

/** The feed's owners summed into groups, largest first; Docker shows even at 0 GB, an empty group else drops. Null for a stale or unknown feed. */
export function memoryGroups(feed: unknown, now: number): MemoryGroup[] | null {
  if (typeof feed !== "object" || feed === null) return null;
  const { v, ts, owners, mem_gb: mem } = feed as Record<string, unknown>;
  if (v !== 1 || typeof ts !== "string" || !(now - Date.parse(ts) < FEED_FRESH_MS) || !Array.isArray(owners)) return null;
  const groups = new Map<MemoryGroupId, { label: string; bytes: number }[]>(Object.keys(GROUP_LABELS).map(id => [id as MemoryGroupId, []]));
  for (const item of owners as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { owner, label, mem_gb: gb } = item as Record<string, unknown>;
    if (typeof owner !== "string" || typeof gb !== "number") continue;
    groups.get(groupOf(owner))!.push({ label: typeof label === "string" ? label : owner, bytes: Math.round(gb * GB) });
  }
  const wired = typeof mem === "object" && mem !== null ? (mem as Record<string, unknown>).wired : undefined;
  if (typeof wired === "number") groups.get("system")!.push({ label: "Wired memory (macOS kernel)", bytes: Math.round(wired * GB) });
  return [...groups].map(([id, items]) => {
    const top = items.sort((a, b) => b.bytes - a.bytes);
    return { id, label: GROUP_LABELS[id], bytes: top.reduce((sum, item) => sum + item.bytes, 0), top: top.slice(0, 3) };
  }).filter(group => group.bytes > 0 || group.id === "docker").sort((a, b) => b.bytes - a.bytes);
}

async function memory(): Promise<MachineView["memory"]> {
  const totalBytes = totalmem();
  if (process.platform !== "darwin") return { usedBytes: totalBytes - freemem(), totalBytes, swapUsedBytes: null, swapTotalBytes: null, pressure: null, groups: null };
  const [vm, sysctl, feed] = await Promise.all([
    run("vm_stat").then(out => parseVmStat(out.stdout), () => null),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]).then(out => parseSysctl(out.stdout), () => ({ pressure: null, swapUsedBytes: null, swapTotalBytes: null })),
    readFile(PRESSURE_FEED, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null),
  ]);
  return { usedBytes: vm ?? totalBytes - freemem(), totalBytes, ...sysctl, groups: memoryGroups(feed, Date.now()) };
}

export async function machineView(): Promise<MachineView> {
  const mem = await memory();
  const percent = cpuPercent();
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { cpu: { percent, cores: cpus().length, load: [one, five, fifteen] }, memory: mem };
}
