import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { MachineView, MemoryPressure } from "./shared/types.ts";

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

async function memory(): Promise<MachineView["memory"]> {
  const totalBytes = totalmem();
  if (process.platform !== "darwin") return { usedBytes: totalBytes - freemem(), totalBytes, swapUsedBytes: null, swapTotalBytes: null, pressure: null };
  const [vm, sysctl] = await Promise.all([
    run("vm_stat").then(out => parseVmStat(out.stdout), () => null),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]).then(out => parseSysctl(out.stdout), () => ({ pressure: null, swapUsedBytes: null, swapTotalBytes: null })),
  ]);
  return { usedBytes: vm ?? totalBytes - freemem(), totalBytes, ...sysctl };
}

export async function machineView(): Promise<MachineView> {
  const mem = await memory();
  const percent = cpuPercent();
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { cpu: { percent, cores: cpus().length, load: [one, five, fifteen] }, memory: mem };
}
