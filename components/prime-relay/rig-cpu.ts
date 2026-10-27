import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { kernelDir, kernelFile } from "./kernel-read.ts";

/**
 * The harness side's CPU split into the harness's own work and the rigs jobs start (asked on 10-18 after us-metal02 read 10 CPU minutes
 * unusable from 11:23Z to 11:32Z, when scratch chat services, test rigs and iso builds of jobs held most of the harness's cores).
 *
 * Own work is the Prime workers and kernels, the live chat service, pi-pool, the relay and every other unit installed under the user's app.slice.
 * A rig is what a job started: every other process in prime-agent-daemon.service (the commands kernels run, such as tests, builds and scratch
 * chat services), every transient unit (systemd-run, such as the p8iso-* units of the prime-agent fix job) and every ssh login's
 * session-<n>.scope under the user slice. The daemon unit's rigs are its cgroup time less its own processes' time, so a test that starts and
 * ends inside one window still counts as a rig. The ssh scopes count since 10-19: from 15:41Z to 15:48Z the chat read 12 to 24 cores as the
 * harness's own while the supervisor, workers and kernels used about 5, and about 11 of the rest were Mac jobs' box Chromium, svelte-check and
 * tsc runs that came in over ssh (box-cpu-waste job, /proc sample 15:46:50Z to 15:51:57Z).
 */
export interface RigLine { owner: string; cores: number; command: string }
export interface HarnessSplit { own: number; rigs: number; top: RigLine[] }

/** How a unit under app.slice counts: wholly own, wholly a rig, or the daemon unit whose own processes are told apart from its rigs. */
export type UnitRole = "own" | "rig" | "split";
export interface Proc { start: number; ticks: number; unit: string; own: boolean; owner?: string; command: string }
export interface Snapshot { at: number; units: Map<string, { role: UnitRole; usec: number }>; procs: Map<number, Proc> }

export const DAEMON_UNIT = "prime-agent-daemon.service";
/** The owner of every process in an ssh login's scope, such as a Mac job's box browser or check, which carries no session in its environ. */
export const SSH_OWNER = "ssh logins";
const SSH_SCOPE = /^session-[^/]+\.scope$/;
/** The owner of a daemon-unit process with no session in its environ or its parents', such as a server whose job's shell ended. */
export const NO_OWNER = "no live owner";
const OWN_COMMAND = /(?:^|\/)prime-agent --mode daemon\b|\s-m rlm\.repl\b|(?:^|\/)pi-pool-token\b/;
/** A process of the daemon unit that is the harness's own: a Prime worker or the supervisor, a kernel, or a pi-pool token helper. */
export const ownCommand = (command: string): boolean => OWN_COMMAND.test(command);

/** ppid, start (clock ticks after boot) and utime+stime ticks of a /proc/<pid>/stat text; null when it does not parse. */
export function parseProcStat(text: string): { ppid: number; start: number; ticks: number } | null {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]), utime = Number(fields[11]), stime = Number(fields[12]), start = Number(fields[19]);
  return [ppid, utime, stime, start].every(Number.isSafeInteger) ? { ppid, start, ticks: utime + stime } : null;
}

/** Where a job's session lives, from a process environ's RLM_SESSION_DIR: `<root id 8>/<job name>`, or the root alone for a root session. */
export function ownerOf(sessionDir: string, jobName: string | undefined): string {
  const parts = sessionDir.split("/session-artifacts/").at(-1)!.split("/").filter(Boolean);
  const root = (parts[0] ?? sessionDir).slice(0, 8);
  const name = parts.length > 1 ? jobName : undefined;
  return name ? `${root}/${name}` : parts.length > 1 ? `${root}/${parts.at(-1)}` : root;
}

/**
 * The split between two snapshots, `harness` the side's cores over the same window (host-stats.ts `cpuSides`). Rigs are the rig units' time plus
 * the daemon unit's time less its own processes', capped at the harness; own is the rest. `top` names the 5 owners whose live rig processes
 * used the most, each with its busiest command. A process alive at both ends counts its ticks between them, one started in the window all of them.
 */
export function harnessSplit(before: Snapshot, after: Snapshot, harness: number, tickHz = 100): HarnessSplit | null {
  const ms = after.at - before.at;
  if (!(ms > 0)) return null;
  const cores = (seconds: number): number => Math.round(100 * Math.max(0, seconds) * 1000 / ms) / 100;
  const used = (unit: string): number => {
    const end = after.units.get(unit)?.usec, start = before.units.get(unit)?.usec ?? 0;
    return end === undefined ? 0 : (end >= start ? end - start : end) / 1e6;
  };
  const procSeconds = (pid: number, proc: Proc): number => {
    const was = before.procs.get(pid);
    return (was && was.start === proc.start ? Math.max(0, proc.ticks - was.ticks) : proc.ticks) / tickHz;
  };
  let rigSeconds = 0, daemonOwn = 0;
  for (const [unit, { role }] of after.units) if (role === "rig") rigSeconds += used(unit);
  const owners = new Map<string, { seconds: number; command: string; top: number }>();
  for (const [pid, proc] of after.procs) {
    const seconds = procSeconds(pid, proc);
    if (proc.own) { daemonOwn += proc.unit === DAEMON_UNIT ? seconds : 0; continue; }
    if (!(seconds > 0)) continue;
    const owner = proc.owner ?? proc.unit;
    const entry = owners.get(owner) ?? { seconds: 0, command: proc.command, top: 0 };
    entry.seconds += seconds;
    if (seconds > entry.top) Object.assign(entry, { top: seconds, command: proc.command });
    owners.set(owner, entry);
  }
  if (after.units.get(DAEMON_UNIT)?.role === "split") rigSeconds += Math.max(0, used(DAEMON_UNIT) - daemonOwn);
  const rigs = Math.min(harness, cores(rigSeconds));
  const top = [...owners].sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 5)
    .map(([owner, entry]) => ({ owner, cores: cores(entry.seconds), command: entry.command })).filter(line => line.cores > 0);
  return { own: Math.round(100 * (harness - rigs)) / 100, rigs, top };
}

/** A command line cut to its program's base name and its first 3 words that are not flags, at most 80 characters. */
export const shortCommand = (cmdline: string): string => {
  const words = cmdline.split("\0").filter(Boolean);
  return [basename(words[0] ?? ""), ...words.slice(1).filter(word => !word.startsWith("-")).slice(0, 3)].join(" ").slice(0, 80);
};

const read = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");
/** A /proc or cgroup file in its lane (kernel-read.ts), "" when it cannot be read. */
const kernel = (path: string): Promise<string> => kernelFile(path).catch(() => "");
const dirNames = (dir: string): Promise<string[]> => kernelDir(dir).then(entries => entries.map(entry => entry.name), () => []);
const CGROUP_ROOT = "/sys/fs/cgroup";
const jobNames = new Map<string, string | undefined>();
const jobName = async (dir: string): Promise<string | undefined> => {
  if (!jobNames.has(dir)) {
    let name: unknown;
    try { name = (JSON.parse(await read(join(dir, "rlm-subagent.json"))) as { sessionName?: unknown }).sessionName; } catch {}
    jobNames.set(dir, typeof name === "string" && name ? name.slice(0, 60) : undefined);
  }
  return jobNames.get(dir);
};
/** The owner each pid (by its start) read from its environ, kept across snapshots so a long-lived process is read once. */
const envOwners = new Map<string, string | null>();
/**
 * The job that owns process `pid`: the one its environ's RLM_SESSION_DIR names, else its nearest parent's among `stats`, up to 40 hops. Each
 * pid and start is read once and kept (`envOwners`), so a later snapshot of a long-lived process reads no environ. Without `stats` each hop
 * reads its pid's /proc stat. Undefined when none names one.
 */
export async function envOwner(pid: number, stats?: ReadonlyMap<number, { ppid: number; start: number }>, hops = 0): Promise<string | undefined> {
  const stat = stats ? stats.get(pid) : parseProcStat(await kernel(`/proc/${pid}/stat`));
  if (!stat || hops > 40) return undefined;
  const key = `${pid}:${stat.start}`;
  if (!envOwners.has(key)) {
    const dir = /(?:^|\0)RLM_SESSION_DIR=([^\0]+)/.exec(await kernel(`/proc/${pid}/environ`))?.[1];
    if (envOwners.size > 50_000) envOwners.clear();
    envOwners.set(key, dir ? ownerOf(dir, await jobName(dir)) : null);
  }
  return envOwners.get(key) ?? await envOwner(stat.ppid, stats, hops + 1);
}

/** The unit a /proc/<pid>/cgroup text names: its unit under `app`, or its ssh login scope under the user slice that holds `app`; else null. */
export function unitOf(cgroup: string, app: string): string | null {
  const appPrefix = `0::/${app}/`, slicePrefix = `0::/${app.slice(0, app.indexOf("/user@"))}/`;
  if (cgroup.startsWith(appPrefix)) return cgroup.slice(appPrefix.length).split("/")[0]!;
  const scope = cgroup.startsWith(slicePrefix) ? cgroup.slice(slicePrefix.length).split("/")[0]! : "";
  return SSH_SCOPE.test(scope) ? scope : null;
}

/**
 * Reads the units under `app` (a cgroup path such as user.slice/user-1001.slice/user@1001.service/app.slice) less `excluded` (another side's
 * units), the ssh login scopes beside it in the user slice, and the processes of the daemon unit and of every rig unit. A unit is a rig when
 * systemd has it under /run/user/<uid>/systemd/transient, and an ssh login scope is always one.
 */
export async function snapshot(app: string, excluded: ReadonlySet<string>, uid: number, at = Date.now()): Promise<Snapshot> {
  const units = new Map<string, { role: UnitRole; usec: number }>();
  const slice = app.slice(0, app.indexOf("/user@"));
  const usage = async (path: string): Promise<number> => Number(/^usage_usec (\d+)$/m.exec(await kernel(join(CGROUP_ROOT, path, "cpu.stat")))?.[1]);
  const names = (await dirNames(join(CGROUP_ROOT, app))).filter(name => /\.(service|scope|slice)$/.test(name) && !excluded.has(name));
  const scopes = (await dirNames(join(CGROUP_ROOT, slice))).filter(name => SSH_SCOPE.test(name));
  await Promise.all([...names.map(async name => {
    const usec = await usage(join(app, name));
    if (!Number.isFinite(usec)) return;
    const role: UnitRole = name === DAEMON_UNIT ? "split" : existsSync(`/run/user/${uid}/systemd/transient/${name}`) ? "rig" : "own";
    units.set(name, { role, usec });
  }), ...scopes.map(async name => {
    const usec = await usage(join(slice, name));
    if (Number.isFinite(usec)) units.set(name, { role: "rig", usec });
  })]);
  const stats = new Map<number, { ppid: number; start: number; ticks: number; unit: string }>();
  const pids = (await dirNames("/proc")).filter(name => /^\d+$/.test(name));
  await Promise.all(pids.map(async name => {
    const unit = unitOf((await kernel(`/proc/${name}/cgroup`)).trim(), app);
    if (!unit) return;
    const role = units.get(unit)?.role;
    if (role !== "split" && role !== "rig") return;
    const stat = parseProcStat(await kernel(`/proc/${name}/stat`));
    if (stat) stats.set(Number(name), { ...stat, unit });
  }));
  const procs = new Map<number, Proc>();
  await Promise.all([...stats].map(async ([pid, stat]) => {
    const command = await kernel(`/proc/${pid}/cmdline`);
    const own = stat.unit === DAEMON_UNIT && ownCommand(command.replaceAll("\0", " "));
    const owner = own ? undefined : await envOwner(pid, stats) ?? (stat.unit === DAEMON_UNIT ? NO_OWNER : SSH_SCOPE.test(stat.unit) ? SSH_OWNER : stat.unit);
    procs.set(pid, { start: stat.start, ticks: stat.ticks, unit: stat.unit, own, command: shortCommand(command), ...owner ? { owner } : {} });
  }));
  return { at, units, procs };
}
