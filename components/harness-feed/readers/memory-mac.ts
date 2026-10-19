import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context, Sample } from "../otlp.ts";
import { FEED_FRESH_MS, heldBytes, linuxUsable, machineView, MEMORY_GROUPS, userSlice, type LinuxUsable, type MachineView, type MemoryPressure } from "../../prime-relay/host-stats.ts";

/**
 * Memory, OOM and the Mac, on both boxes. The machine numbers are Settings > Hosts' own reading (prime-relay/host-stats.ts machineView, drawn by
 * client/MachineMeters.svelte), the usability reading and the top workers are the chat's Mac usable watch line (src/mac-usable-watch.ts), and the
 * rest reads the kernel, the cgroups and metal-management's memory layers on us-metal02 (sieun-pi deploy/linux/memory), which export nothing.
 */

const run = promisify(execFile);
const GB = 1024 ** 3;
const text = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");
const gauge = (name: string, help: string, value: number, labels?: Record<string, string>, unit?: Sample["unit"]): Sample =>
  ({ name, kind: "gauge", help, value, ...unit ? { unit } : {}, ...labels ? { labels } : {} });
const counter = (name: string, help: string, value: number, labels?: Record<string, string>): Sample => ({ name, kind: "counter", help, value, ...labels ? { labels } : {} });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A holder name for a label: a docker cgroup's 64-hex id cut to 12, as `docker ps` shows it, so the label stays short. */
export const shortHolder = (label: string): string => label.replace(/^(docker-[0-9a-f]{12})[0-9a-f]{52}$/, "$1").slice(0, 60);

/** The pressure level as the Mac's kernel numbers it (1 normal, 2 warn, 4 critical), so it reads on the same scale as devbox_memory_pressure_level. */
export const PRESSURE_LEVEL: Record<MemoryPressure, number> = { normal: 1, warn: 2, critical: 4 };

/**
 * Settings > Hosts' numbers. On the Mac the load, pressure level and swap are left out, because the Mac's Alloy sends them as devbox_load1,
 * devbox_memory_pressure_level and devbox_swap_used_bytes already.
 */
export function machineSamples(view: MachineView): Sample[] {
  const linux = view.platform === "linux";
  const { memory } = view;
  const out: Sample[] = [
    gauge("harness.host.cpu_used", "Busy share of all cores since the previous reading, as Settings > Hosts draws it.", view.cpu.percent / 100, undefined, "1"),
    gauge("harness.host.cores", "Cores the box has.", view.cpu.cores),
    gauge("harness.host.memory_used", "Memory in use as Settings > Hosts counts it: MemTotal less MemAvailable on Linux, app, wired and compressed memory on macOS.", memory.usedBytes, undefined, "By"),
    gauge("harness.host.memory_total", "The box's RAM.", memory.totalBytes, undefined, "By"),
  ];
  if (linux) {
    view.cpu.load.forEach((value, index) => out.push(gauge("harness.host.load", "Load average.", value, { window: ["1m", "5m", "15m"][index]! })));
    if (memory.pressure) out.push(gauge("harness.host.memory_pressure_level", "Memory pressure from PSI on the Mac's scale: 1 normal, 2 warn (some avg10 at 7%), 4 critical (full avg10 at 70%).", PRESSURE_LEVEL[memory.pressure]));
    if (memory.swapUsedBytes !== null) out.push(gauge("harness.host.swap_used", "Swap in use.", memory.swapUsedBytes, undefined, "By"));
    if (memory.swapTotalBytes !== null) out.push(gauge("harness.host.swap_total", "Swap the box has.", memory.swapTotalBytes, undefined, "By"));
  }
  if (typeof memory.cacheBytes === "number") out.push(gauge("harness.host.file_cache", "The leaf cgroups' file cache, which the box takes back when it needs the room.", memory.cacheBytes, undefined, "By"));
  const groups = new Map((memory.groups ?? []).map(group => [group.id, group]));
  if (memory.groups) for (const id of MEMORY_GROUPS) {
    const group = groups.get(id);
    out.push(gauge("harness.host.memory_group", "Memory by Settings > Hosts group: on Linux what the group holds that the box cannot take back, on macOS its footprint.", group?.bytes ?? 0, { group: id }, "By"));
    if (linux) out.push(gauge("harness.host.memory_group_swap", "The part of a memory group that sits in swap.", group?.swapBytes ?? 0, { group: id }, "By"));
    group?.top.forEach((item, index) => out.push(gauge("harness.host.memory_group_top", "A memory group's largest holders, as the Hosts card lists them.", item.bytes, { group: id, rank: String(index + 1), holder: shortHolder(item.label) }, "By")));
  }
  return out;
}

/** The usable marks of src/mac-usable-watch.ts (USABLE, LINUX_USABLE), copied because its import tree has TS parameter properties node cannot strip. */
export const USABLE = { pressureLevel: 4, swapoutsPerS: 6000, kernelTaskPct: 100 } as const;
export const LINUX_USABLE = { memFullAvg10: 70, runnablePerCore: 1 } as const;
export type Miss = "pressure" | "swapouts" | "kernel_task" | "cpu";
/** A Mac pressure feed reading's usable inputs (mac-usable-watch.ts parseFeed), or null when stale, not schema v1, or short of a number. */
export function macUsable(feed: unknown, now: number): { pressureLevel: number; swapoutsPerS: number; kernelTaskPct: number } | null {
  if (!isRecord(feed) || feed.v !== 1 || typeof feed.ts !== "string" || !(now - Date.parse(feed.ts) < FEED_FRESH_MS)) return null;
  const { pressure_level: pressureLevel, swapouts_per_s: swapoutsPerS, kernel_task_cpu_pct: kernelTaskPct } = feed;
  return num(pressureLevel) && num(swapoutsPerS) && num(kernelTaskPct) ? { pressureLevel, swapoutsPerS, kernelTaskPct } : null;
}

/** The usable verdict and the misses behind it, as mac-usable-watch.ts `unusable` judges a minute. */
export function verdictSamples(misses: readonly Miss[], all: readonly Miss[]): Sample[] {
  return [gauge("harness.usable.ok", "1 when the box was usable by the chat's Mac usable watch marks, 0 when a mark was missed.", misses.length ? 0 : 1),
    ...all.map(reason => gauge("harness.usable.miss", "1 when the box missed this usable mark.", misses.includes(reason) ? 1 : 0, { reason }))];
}

/**
 * A Linux usable reading (host-stats.ts LinuxUsable): the swap-out rate, runnable tasks a core, each side's CPU cores and the harness split with
 * the rigs' owners. Memory and CPU stall come from /proc/pressure each round instead (`psiSamples`).
 */
export function linuxUsableSamples(reading: LinuxUsable): Sample[] {
  const misses: Miss[] = [];
  if (reading.memFullAvg10 >= LINUX_USABLE.memFullAvg10) misses.push("pressure");
  if (reading.runnablePerCore >= LINUX_USABLE.runnablePerCore) misses.push("cpu");
  const out: Sample[] = [
    gauge("harness.usable.runnable_per_core", "Tasks running or waiting a CPU, per CPU the harness may use, over the watch window.", reading.runnablePerCore),
    gauge("harness.usable.allowed_cpus", "CPUs the harness may run on.", reading.allowedCpus),
    ...verdictSamples(misses, ["pressure", "cpu"]),
  ];
  if (reading.swapoutsPerS !== null) out.push(gauge("harness.usable.swapouts_per_s", "Pages swapped out a second over the watch window.", reading.swapoutsPerS));
  for (const [side, cores] of Object.entries(reading.cpuCores ?? {})) out.push(gauge("harness.usable.cpu_cores", "CPU cores each side used over the watch window: harness, apps, owner, ci and system.", cores, { side }));
  const split = reading.harnessSplit;
  if (split) {
    out.push(gauge("harness.usable.harness_cores", "The harness side's cores split into its own work and the rigs jobs started.", split.own, { part: "own" }),
      gauge("harness.usable.harness_cores", "The harness side's cores split into its own work and the rigs jobs started.", split.rigs, { part: "rigs" }));
    split.top.forEach((line, index) => out.push(gauge("harness.usable.rig_cores", "The owners whose rigs used the most cores over the watch window.", line.cores, { rank: String(index + 1), owner: line.owner.slice(0, 60) })));
  }
  return out;
}

export function macUsableSamples(reading: { pressureLevel: number; swapoutsPerS: number; kernelTaskPct: number }): Sample[] {
  const misses: Miss[] = [];
  if (reading.pressureLevel >= USABLE.pressureLevel) misses.push("pressure");
  if (reading.swapoutsPerS >= USABLE.swapoutsPerS) misses.push("swapouts");
  if (reading.kernelTaskPct >= USABLE.kernelTaskPct) misses.push("kernel_task");
  return verdictSamples(misses, ["pressure", "swapouts", "kernel_task"]);
}

/** Each avg10 and avg60 of /proc/pressure/<resource>. */
export function psiSamples(resource: string, body: string): Sample[] {
  const out: Sample[] = [];
  for (const match of body.matchAll(/^(some|full) avg10=([\d.]+) avg60=([\d.]+)/gm))
    for (const [window, value] of [["avg10", match[2]], ["avg60", match[3]]] as const)
      out.push(gauge("harness.host.psi", "Pressure stall: the share of time some or all tasks waited on the resource, in percent.", Number(value), { resource, kind: match[1]!, window }));
  return out;
}

/** One worker's tree in the top N: its footprint, the part its sessions' work holds, its session count and the chat with the most sessions on it. */
export interface TopWorker { gb: number; workGb?: number; sessions?: number; chat: string }
export function workerSamples(workers: number, workerGb: number, top: readonly TopWorker[], trees: readonly { chat: string; gb: number }[]): Sample[] {
  const out: Sample[] = [gauge("harness.workers.count", "Prime worker processes on the box.", workers),
    gauge("harness.workers.memory", "Footprint of every Prime worker's process tree, resident plus swapped on Linux.", Math.round(workerGb * GB), undefined, "By")];
  top.forEach((worker, index) => {
    const labels = { rank: String(index + 1), chat: worker.chat.slice(0, 60) };
    out.push(gauge("harness.workers.top_memory", "The largest Prime worker trees by footprint, with the chat that has the most sessions on each.", Math.round(worker.gb * GB), labels, "By"));
    if (worker.workGb !== undefined) out.push(gauge("harness.workers.top_work_memory", "The part of a top worker's tree its sessions' work holds.", Math.round(worker.workGb * GB), labels, "By"));
    if (worker.sessions !== undefined) out.push(gauge("harness.workers.top_sessions", "Live sessions on a top worker.", worker.sessions, labels));
  });
  trees.forEach((tree, index) => out.push(gauge("harness.workers.tree_memory", "The chat trees with the largest footprint, their kernels' subtrees plus their orphans.", Math.round(tree.gb * GB), { rank: String(index + 1), chat: tree.chat.slice(0, 60) }, "By")));
  return out;
}

/** The newest line of the chat's watch file text that is under `maxAgeMs` old at `now`, or null. */
export function freshWatchLine(body: string, now: number, maxAgeMs = 150_000): Record<string, unknown> | null {
  const lines = body.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const line = JSON.parse(lines[index]!) as unknown;
      if (!isRecord(line) || typeof line.at !== "string") continue;
      return now - Date.parse(line.at) < maxAgeMs ? line : null;
    } catch { continue; }
  }
  return null;
}

/** The tail of the newest day file in the chat's mac-usable folder; the first line may be cut, which `freshWatchLine` skips. */
async function watchTail(home: string): Promise<string> {
  const dir = join(home, ".prime/agent/browser-chat/mac-usable");
  const files = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl"));
  const dated = await Promise.all(files.map(async name => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = dated.sort((a, b) => b.at - a.at)[0];
  if (!newest) return "";
  const handle = await open(join(dir, newest.name), "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

/** The watch line's workers and chat trees (mac-usable-watch.ts watchLine `top` and `trees`), checked at the edge. */
export function watchWorkers(line: Record<string, unknown>): Sample[] {
  if (!num(line.workers) || !num(line.workerGb) || !Array.isArray(line.top)) return [];
  const top = line.top.filter(isRecord).filter(worker => num(worker.gb))
    .map(worker => ({ gb: worker.gb as number, ...num(worker.workGb) ? { workGb: worker.workGb } : {}, ...num(worker.sessions) ? { sessions: worker.sessions } : {}, chat: typeof worker.tree === "string" && worker.tree ? worker.tree : "unknown" }));
  const trees = (Array.isArray(line.trees) ? line.trees : []).filter(isRecord).filter(tree => num(tree.gb)).map(tree => ({ chat: typeof tree.tree === "string" ? tree.tree : "unknown", gb: tree.gb as number }));
  return workerSamples(line.workers, line.workerGb, top, trees);
}

/** One `ps ax -o pid=,ppid=,rss=,args=` row. */
export interface PsRow { pid: number; ppid: number; rssBytes: number; args: string }
export function parsePs(body: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, args: match[4]! });
  }
  return rows;
}
/** A Prime worker: a `prime-agent --mode daemon` whose socket is a worker-*.sock; the supervisor's socket is daemon.sock. */
export const isWorker = (args: string): boolean => /(?:^|\/)prime-agent --mode daemon\b.*--daemon-socket \S*\/worker-[^/\s]*\.sock/.test(args);
/** The Playwright and Puppeteer browsers no agent work may run on the Mac (worker-footprint.py TEST_BROWSER), their helpers included. */
const TEST_BROWSER = /\/Google Chrome for Testing( Helper[^/]*)?\.app\/|\/chrome-headless-shell( |$)/;
export function testBrowserSamples(rows: readonly PsRow[]): Sample[] {
  const all = rows.filter(row => TEST_BROWSER.test(row.args));
  const main = all.filter(row => !/\s--type=/.test(row.args));
  return [gauge("harness.mac.test_browsers", "Chrome for Testing and chrome-headless-shell browsers running on the Mac, where agent work may run none.", main.length),
    gauge("harness.mac.test_browser_processes", "Processes of those browsers, helpers included.", all.length),
    gauge("harness.mac.test_browser_rss", "Resident memory of those browsers and their helpers.", all.reduce((sum, row) => sum + row.rssBytes, 0), undefined, "By")];
}

/** What worker-footprint.py prints, as far as the reader uses it. */
export interface Footprints { workers: Record<string, { bytes: number }>; kernels?: { pid: number; root: string; bytes: number }[] }
/**
 * Top workers from the footprint helper, for a box with no fresh watch line (the Mac): each worker's chat is the chat tree with the most kernels
 * under it, found by walking each kernel's ps parents up to a worker, and named from the pressure feed's `chat:<root>` labels.
 */
export function helperWorkers(footprints: Footprints, rows: readonly PsRow[], names: ReadonlyMap<string, string>, limit = 5): Sample[] {
  const parent = new Map(rows.map(row => [row.pid, row.ppid]));
  const workerOf = (pid: number): string | null => {
    for (let at: number | undefined = pid, hops = 0; at && at > 1 && hops < 64; at = parent.get(at), hops++) if (footprints.workers[String(at)]) return String(at);
    return null;
  };
  const roots = new Map<string, Map<string, number>>();
  for (const kernel of footprints.kernels ?? []) {
    const worker = workerOf(kernel.pid);
    if (!worker || !kernel.root) continue;
    const counts = roots.get(worker) ?? new Map<string, number>();
    counts.set(kernel.root, (counts.get(kernel.root) ?? 0) + 1);
    roots.set(worker, counts);
  }
  const chat = (worker: string): string => {
    const lead = [...roots.get(worker) ?? []].sort((a, b) => b[1] - a[1])[0]?.[0];
    return lead ? names.get(lead) ?? lead.slice(0, 8) : "no session";
  };
  const entries = Object.entries(footprints.workers);
  const top = entries.sort((a, b) => b[1].bytes - a[1].bytes).slice(0, limit).map(([pid, tree]) => ({ gb: tree.bytes / GB, chat: chat(pid) }));
  return workerSamples(entries.length, entries.reduce((sum, [, tree]) => sum + tree.bytes, 0) / GB, top, []);
}
/** The chat names the Mac pressure feed gives its `chat:<root>` owners. */
export function feedChatNames(feed: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (isRecord(feed) && Array.isArray(feed.owners)) for (const owner of feed.owners)
    if (isRecord(owner) && typeof owner.owner === "string" && owner.owner.startsWith("chat:") && typeof owner.label === "string") names.set(owner.owner.slice(5), owner.label);
  return names;
}

const HELPER = new URL("../../user-history/src/worker-footprint.py", import.meta.url).pathname;
async function footprints(pids: readonly number[]): Promise<Footprints> {
  return await new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/python3", ["-B", HELPER], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as Footprints); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(pids.join("\n") + "\n");
  });
}

/** /proc/swaps' devices: size and use in bytes, by path. */
export function parseSwaps(body: string): { device: string; sizeBytes: number; usedBytes: number }[] {
  return body.split("\n").slice(1).flatMap(line => {
    const [device, , size, used] = line.trim().split(/\s+/);
    return device && Number.isFinite(Number(size)) && Number.isFinite(Number(used)) ? [{ device, sizeBytes: Number(size) * 1024, usedBytes: Number(used) * 1024 }] : [];
  });
}
/** A `name value` file such as /proc/vmstat or memory.events, as numbers by name. */
export function fields(body: string): Map<string, number> {
  return new Map(body.split("\n").flatMap(line => { const [key, value] = line.trim().split(/\s+/); return key && value !== undefined && /^\d+$/.test(value) ? [[key, Number(value)] as const] : []; }));
}
/** A /proc/meminfo field in bytes, or null. */
export const meminfoBytes = (body: string, name: string): number | null => { const value = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(body)?.[1]; return value === undefined ? null : Number(value) * 1024; };
/** The `key = value` lines of a sysctl.d file. */
export function parseSysctlConf(body: string): Map<string, string> {
  return new Map(body.split("\n").flatMap(line => { const match = /^\s*([\w.]+)\s*=\s*(\S+)\s*$/.exec(line); return match ? [[match[1]!, match[2]!] as const] : []; }));
}
/** `systemctl show -p Id,MainPID,ActiveState` blocks, by unit. */
export function parseShow(body: string): Map<string, { pid: number; active: boolean }> {
  const units = new Map<string, { pid: number; active: boolean }>();
  for (const block of body.split(/\n\s*\n/)) {
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(block)?.[1];
    const id = value("Id");
    if (id) units.set(id, { pid: Number(value("MainPID") ?? 0), active: value("ActiveState") === "active" });
  }
  return units;
}
/** earlyoom's kill lines in journal text by signal, and the cursor `--show-cursor` printed last. */
export function earlyoomKills(body: string): { kills: Map<string, number>; cursor: string | null } {
  const kills = new Map<string, number>();
  let cursor: string | null = null;
  for (const line of body.split("\n")) {
    const signal = /^sending (SIG\w+) to process \d+/.exec(line)?.[1];
    if (signal) kills.set(signal, (kills.get(signal) ?? 0) + 1);
    const mark = /^-- cursor: (.+)$/.exec(line)?.[1];
    if (mark) cursor = mark;
  }
  return { kills, cursor };
}

const LAYER_UNITS = ["zswap-zstd.service", "earlyoom.service", "oom-protect.service"];
const SYSTEM_TARGETS: Record<string, string> = { "ssh.service": "sshd", "tailscaled.service": "tailscaled" };
const USER_TARGETS: Record<string, string> = { "prime-agent-daemon.service": "prime-daemon", "sieun-pi-chat.service": "chat-service", "pi-pool-serve.service": "pi-pool-serve", "pi-pool-hookd.service": "pi-pool-hookd" };
const STATE = { cursor: "memory-mac.earlyoom-cursor", kills: "memory-mac.earlyoom-kills" } as const;

/** us-metal02's memory layers (deploy/linux/memory), the kernel's OOM counters, the Prime daemon's cgroup and the heavy scopes. */
async function linuxLayers(ctx: Context): Promise<Sample[]> {
  const out: Sample[] = [];
  const slice = userSlice(await text("/proc/self/cgroup"));
  const cg = (path: string) => join("/sys/fs/cgroup", path);
  const daemonCg = slice ? `${slice.app}/prime-agent-daemon.service` : null;
  const [swaps, meminfo, vmstat, zswap, sliceEvents, daemonEvents, daemonStat, daemonSwap, daemonCurrent, conf, system, user, ...sysctls] = await Promise.all([
    text("/proc/swaps"), text("/proc/meminfo"), text("/proc/vmstat"),
    Promise.all(["enabled", "compressor", "max_pool_percent"].map(name => text(`/sys/module/zswap/parameters/${name}`).then(value => value.trim()))),
    slice ? text(cg(`${slice.slice}/memory.events`)) : "", daemonCg ? text(cg(`${daemonCg}/memory.events`)) : "",
    daemonCg ? text(cg(`${daemonCg}/memory.stat`)) : "", daemonCg ? text(cg(`${daemonCg}/memory.swap.current`)) : "", daemonCg ? text(cg(`${daemonCg}/memory.current`)) : "",
    text("/etc/sysctl.d/90-agent-memory.conf"),
    run("systemctl", ["show", "-p", "Id,MainPID,ActiveState", ...LAYER_UNITS, ...Object.keys(SYSTEM_TARGETS)]).then(result => result.stdout, () => ""),
    run("systemctl", ["--user", "show", "-p", "Id,MainPID,ActiveState", ...Object.keys(USER_TARGETS)]).then(result => result.stdout, () => ""),
    ...["vm/swappiness", "vm/watermark_scale_factor", "vm/min_free_kbytes"].map(name => text(`/proc/sys/${name}`).then(value => value.trim())),
  ]);

  for (const swap of parseSwaps(swaps)) out.push(gauge("harness.memory.swap_device_size", "Size of each swap device.", swap.sizeBytes, { device: swap.device }, "By"),
    gauge("harness.memory.swap_device_used", "Swap in use on each swap device.", swap.usedBytes, { device: swap.device }, "By"));

  const [enabled, compressor, maxPool] = zswap;
  if (enabled) {
    out.push(gauge("harness.memory.zswap_enabled", "1 when zswap is on, with its compressor.", enabled === "Y" ? 1 : 0, { compressor: compressor || "unknown" }));
    if (maxPool) out.push(gauge("harness.memory.zswap_max_pool", "The most RAM zswap's pool may take, max_pool_percent of MemTotal.", Number(maxPool) / 100 * (meminfoBytes(meminfo, "MemTotal") ?? 0), undefined, "By"));
    const pool = meminfoBytes(meminfo, "Zswap"), stored = meminfoBytes(meminfo, "Zswapped");
    if (pool !== null) out.push(gauge("harness.memory.zswap_pool", "RAM zswap's compressed pool takes now.", pool, undefined, "By"));
    if (stored !== null) out.push(gauge("harness.memory.zswap_stored", "Memory zswap holds, at its size before compression.", stored, undefined, "By"));
  }
  const kernel = fields(vmstat);
  const vm = (key: string) => kernel.get(key);
  if (vm("oom_kill") !== undefined) out.push(counter("harness.memory.oom_kills", "Processes the kernel's OOM killer killed since boot, cgroup kills included.", vm("oom_kill")!));
  for (const [key, direction] of [["pswpin", "in"], ["pswpout", "out"]] as const) if (vm(key) !== undefined) out.push(counter("harness.memory.swap_pages", "Pages swapped in and out since boot.", vm(key)!, { direction }));
  for (const [key, event] of [["zswpout", "store"], ["zswpin", "load"], ["zswpwb", "writeback"]] as const) if (vm(key) !== undefined) out.push(counter("harness.memory.zswap_pages", "Pages zswap stored, loaded back and wrote back to swap since boot.", vm(key)!, { event }));

  for (const [cgroup, body] of [["user-slice", sliceEvents], ["prime-daemon", daemonEvents]] as const) {
    const events = fields(body);
    for (const event of ["max", "oom", "oom_kill"]) if (events.has(event)) out.push(counter("harness.memory.cgroup_events", "memory.events of the user slice and the Prime daemon's cgroup: times at memory.max, OOMs and OOM kills.", events.get(event)!, { cgroup, event }));
  }
  const held = heldBytes(daemonStat, daemonSwap);
  if (held) for (const [kind, value] of [["held", held.bytes], ["swap", held.swapBytes], ["cache", held.cacheBytes], ["current", Number(daemonCurrent.trim())]] as const)
    if (Number.isFinite(value)) out.push(gauge("harness.memory.daemon_cgroup", "The Prime daemon's cgroup: held (anon, shmem and swap, as Settings > Hosts counts), swap, file cache and memory.current.", value, { kind }, "By"));

  const units = new Map([...parseShow(system), ...parseShow(user)]);
  for (const unit of LAYER_UNITS) out.push(gauge("harness.memory.unit_active", "1 when a memory layer's unit is active.", units.get(unit)?.active ? 1 : 0, { unit }));
  const adj = async (pid: number): Promise<number | null> => { const value = (await text(`/proc/${pid}/oom_score_adj`)).trim(); return value ? Number(value) : null; };
  for (const [unit, target] of Object.entries({ ...SYSTEM_TARGETS, ...USER_TARGETS })) {
    const pid = units.get(unit)?.pid;
    const value = pid ? await adj(pid) : null;
    if (value !== null) out.push(gauge("harness.memory.oom_score_adj", "oom_score_adj of the processes oom-protect and the unit files guard; for prime-worker the highest any worker has.", value, { target }));
  }
  if (daemonCg) {
    const main = units.get("prime-agent-daemon.service")?.pid;
    const pids = (await text(cg(`${daemonCg}/cgroup.procs`))).split("\n").map(Number).filter(pid => pid > 0 && pid !== main);
    const scores = await Promise.all(pids.map(async pid => (await text(`/proc/${pid}/comm`)).trim() === "prime-agent" ? await adj(pid) : null));
    const workers = scores.filter((score): score is number => score !== null);
    if (workers.length) out.push(gauge("harness.memory.oom_score_adj", "oom_score_adj of the processes oom-protect and the unit files guard; for prime-worker the highest any worker has.", Math.max(...workers), { target: "prime-worker" }));
  }

  const [swappiness, watermark, minFree] = sysctls;
  if (swappiness) out.push(gauge("harness.memory.vm_swappiness", "vm.swappiness, how readily the kernel swaps anonymous memory instead of dropping file cache.", Number(swappiness)));
  if (watermark) out.push(gauge("harness.memory.vm_watermark_scale_factor", "vm.watermark_scale_factor, in ten-thousandths of RAM free at which kswapd wakes.", Number(watermark)));
  if (minFree) out.push(gauge("harness.memory.vm_min_free", "vm.min_free_kbytes, the kernel's emergency reserve.", Number(minFree) * 1024, undefined, "By"));
  const wanted = parseSysctlConf(conf);
  if (wanted.size) {
    const live: Record<string, string | undefined> = { "vm.swappiness": swappiness, "vm.watermark_scale_factor": watermark, "vm.min_free_kbytes": minFree };
    out.push(gauge("harness.memory.sysctl_drift", "Settings in /etc/sysctl.d/90-agent-memory.conf whose live value differs.", [...wanted].filter(([key, value]) => live[key] !== undefined && live[key] !== value).length));
  }

  if (slice) {
    const app = cg(slice.app);
    const scopes = (await readdir(app).catch(() => [] as string[])).filter(name => /^run-.+\.scope$/.test(name));
    const boxes = (await Promise.all(scopes.map(async name => {
      const [max, current] = await Promise.all([text(join(app, name, "memory.max")), text(join(app, name, "memory.current"))]);
      return /^\d+$/.test(max.trim()) ? { max: Number(max.trim()), current: Number(current.trim()) || 0 } : null;
    }))).filter(box => box !== null);
    out.push(gauge("harness.memory.heavy_scopes", "Live `heavy` runs: systemd-run scopes under the user's app.slice with a MemoryMax.", boxes.length),
      gauge("harness.memory.heavy_scope_memory", "memory.current of the live heavy runs, summed.", boxes.reduce((sum, box) => sum + box.current, 0), undefined, "By"),
      gauge("harness.memory.heavy_scope_limit", "MemoryMax of the live heavy runs, summed.", boxes.reduce((sum, box) => sum + box.max, 0), undefined, "By"));
  }

  out.push(...await earlyoom(ctx));
  return out;
}

/**
 * earlyoom's kills from the system journal, read from the saved cursor each round (since boot on the first), about 10 ms of journalctl.
 * sieun reads the journal through the ACL metal-management set on /var/log/journal on 10-19; where it cannot, the reader says so and sends no kill count.
 */
async function earlyoom(ctx: Context): Promise<Sample[]> {
  const files = await readdir("/var/log/journal").catch(() => [] as string[]);
  const readable = (await Promise.all(files.map(dir => access(join("/var/log/journal", dir, "system.journal"), constants.R_OK).then(() => true, () => false)))).some(Boolean);
  const out = [gauge("harness.memory.earlyoom_log_readable", "1 when this user can read earlyoom's kills from the system journal.", readable ? 1 : 0)];
  if (!readable) return out;
  const cursor = ctx.state.get(STATE.cursor) as string | undefined;
  const args = ["-u", "earlyoom.service", "-o", "cat", "-q", "--no-pager", "--show-cursor", ...cursor ? [`--after-cursor=${cursor}`] : ["-b"]];
  const result = earlyoomKills(await run("journalctl", args, { maxBuffer: 16 * 1024 * 1024 }).then(done => done.stdout, () => ""));
  const kills = (ctx.state.get(STATE.kills) as Map<string, number> | undefined) ?? new Map([["SIGTERM", 0], ["SIGKILL", 0]]);
  for (const [signal, count] of result.kills) kills.set(signal, (kills.get(signal) ?? 0) + count);
  ctx.state.set(STATE.kills, kills);
  if (result.cursor) ctx.state.set(STATE.cursor, result.cursor);
  for (const [signal, count] of kills) out.push(counter("harness.memory.earlyoom_kills", "Processes earlyoom signalled to free memory since boot, by signal.", count, { signal }));
  return out;
}

/** The Mac: workers by the footprint helper, the agents' test browsers by ps, and the usable verdict from ops guy's pressure feed. */
async function macParts(ctx: Context, watchFresh: boolean): Promise<Sample[]> {
  const ps = parsePs(await run("ps", ["ax", "-o", "pid=,ppid=,rss=,args="], { maxBuffer: 16 * 1024 * 1024 }).then(result => result.stdout, () => ""));
  const out = ctx.platform === "darwin" ? testBrowserSamples(ps) : [];
  if (!watchFresh) {
    const feed = await readFile(join(ctx.home, ".cache/virev/mac-pressure.json"), "utf8").then(body => JSON.parse(body) as unknown).catch(() => null);
    const pids = ps.filter(row => isWorker(row.args)).map(row => row.pid);
    if (pids.length) out.push(...helperWorkers(await footprints(pids), ps, feedChatNames(feed)));
    if (ctx.platform === "darwin") { const reading = macUsable(feed, ctx.now); if (reading) out.push(...macUsableSamples(reading)); }
  }
  return out;
}

export async function read(ctx: Context): Promise<Sample[]> {
  const linux = ctx.platform === "linux";
  const watch = ctx.chatHost ? freshWatchLine(await watchTail(ctx.home), ctx.now) : null;
  const [view, layers, psi] = await Promise.all([machineView(), linux ? linuxLayers(ctx) : [],
    linux ? Promise.all(["memory", "cpu", "io"].map(async resource => psiSamples(resource, await text(`/proc/pressure/${resource}`)))).then(lists => lists.flat()) : []]);
  const out = [...machineSamples(view), ...layers, ...psi];
  if (watch) {
    out.push(...watchWorkers(watch));
    const usable = watch.usable;
    if (isRecord(usable) && usable.kind === "linux") out.push(...linuxUsableSamples(usable as unknown as LinuxUsable));
  } else if (linux) {
    const reading = await linuxUsable(ctx.now);
    if (reading) out.push(...linuxUsableSamples(reading));
  }
  out.push(...await macParts(ctx, watch !== null && Array.isArray(watch.top)));
  return out;
}
