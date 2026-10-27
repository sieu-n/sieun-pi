import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { macAway } from "./mac-reach.ts";
import { CHECKS, type Outcome, realDeps, runChecks } from "./skills-and-tools.ts";

/**
 * The Box tools parity duty's precheck (`node --import tsx scripts/duties/box-parity.ts`): whether us-metal02 still matches the owner's MacBook Pro
 * for every tool auto-sns-agent and sieun-pi agents use (owner 10-18). No model call, nothing sent outside. Three numbers:
 * - `tool_rows_off`: rows of box-parity.rows.json (the 167 rows of the 10-18 audit, /home/sieun/box-tools-parity/gap-table.md) where the box lacks
 *   what the Mac has: a file, folder entry, config hash, CLI version, port, service, or a real call that fails on the box. box-parity-probe.py reads
 *   both sides, the Mac over one `ssh mac` that only reads (see the probe's docstring). The Mac is the standard, so a Mac value that is absent or
 *   failing asks nothing of the box, a set on the box may hold more than the Mac's, and a CLI version on the box may be newer. A probe with `intended` (Poppler), a row with `byDesign`
 *   and a Mac commit the Mac never pushed to origin (`mac_unpushed`) are listed and never counted. Rows with a `panel` probe run that Skills and tools check (skills-and-tools.ts) here, without its fixes; a fail
 *   whose detail the probe's `shared` regex matches comes from a service both hosts use, such as Google on Virev or an account in the box's
 *   pi-pool, which the Mac reads through ~/.config/pi-pool/remote.json, so it is no box gap.
 * - `resource_limits_set`: memory, CPU, IO, task and priority settings on the box's systemd units, Docker containers and systemd manager files that
 *   no vendor file ships (owner rule c107: "remove all the bullshit i didn't explicitly asked for"), one per setting and unit name with its numbers
 *   folded, plus services whose main process runs at a nice level its unit does not set. A limit at or above the box's RAM limits nothing.
 *   A setting the owner asked for is listed as `owner_asked` with its layer and not counted: a CPUWeight setup-cpu.sh sets (CPU layer 1), the
 *   daemon's nice from cpu-protect.py (CPU layer 2), and a `heavy` scope (memory layer 4), all in deploy/linux/README.md after the owner's 10-19
 *   asks and his t84 answer. `parseLayers` reads them from those scripts, so a value that differs from its script still counts.
 * - `rcu_boost_off`: 1 when rcu-boost.service (CPU layer 3) is not running or rcu_cpu_stall_timeout differs from its STALL_TIMEOUT_S, see rcuBoostOff.
 * - `public_ssh_open`: 1 when port 22 on the box's public address answers from us-metal01 (METAL_SSH_HOST), or ssh-public-guard.service is not
 *   active; the probe also dials a closed port, so a refused answer proves the path reaches the box.
 * A Mac that Tailscale lists offline leaves `tool_rows_off` out with a `host_away` item (mac-reach.ts), with no ssh to it, and the runner reruns
 * the duty once Tailscale reads it online. A source that cannot be read leaves its metric out with a `source_error` item, so the run says not
 * measured instead of a miss.
 * STATE_FILE keeps the Mac CLI versions the probe had to run, keyed by path and mtime, so later runs only read the Mac.
 */

const HERE = import.meta.dirname;
const MAC = process.env.MAC_SSH_HOST || "mac";
const OUTSIDE = process.env.METAL_SSH_HOST || "us-metal01";
/** The whole Mac read, ssh included: on 10-18 at load 450 the Mac took 9 to 40 s (probe 6 s, the rest ssh). */
const MAC_TIMEOUT_S = 90;

export type Probe = Record<string, unknown>;
export interface Row { id: string; tool: string; probes?: Probe[]; mac?: Probe[]; box?: Probe[]; note?: string; byDesign?: string }
export interface ProbeOutput { host: "mac" | "box"; values: Record<string, string[]>; versions: Record<string, unknown>; ms: number }
export interface RowVerdict { row: Row; why: string }
export interface RowsResult { off: RowVerdict[]; byDesign: RowVerdict[]; intended: RowVerdict[]; unpushed: RowVerdict[]; matched: number }

const setOf = (value: string): string[] | undefined => value.startsWith("set:") ? JSON.parse(value.slice(4)) as string[] : undefined;
const failing = (value: string | undefined): boolean => value === undefined || value === "absent" || value.startsWith("fail");

/**
 * Why the box value falls short of the Mac value, or null when it matches. The Mac is the standard; a box set may hold extra entries, and a box CLI
 * version at or above the Mac's matches, because a newer jq or psql on the box gives agents every feature the Mac's has (owner 10-18 goal p1).
 */
export function shortfall(mac: string | undefined, box: string | undefined): string | null {
  if (failing(mac)) return null;
  if (box === undefined) return "the box gave no value";
  if (mac!.startsWith("commits:")) return commitShortfall(mac!, box);
  if (mac!.startsWith("blobs:")) return blobShortfall(mac!, box);
  const macSet = setOf(mac!);
  if (macSet) {
    const boxSet = setOf(box);
    if (!boxSet) return `Mac has ${macSet.length} entries, box ${box.slice(0, 120)}`;
    const missing = macSet.filter(entry => !boxSet.includes(entry));
    return missing.length ? `box lacks ${missing.length} of the Mac's ${macSet.length}: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}` : null;
  }
  if (mac!.startsWith("v:") && box.startsWith("v:") && compareVersions(box.slice(2), mac!.slice(2)) >= 0) return null;
  return mac === box ? null : `Mac ${mac!.slice(0, 80)}, box ${box.slice(0, 160)}`;
}

/**
 * A file the box checkout tracks, such as ~/.prime/agent/AGENTS.md: it matches when the box's blobs, its file's and those the file held at the
 * commits its HEAD descends from, include the Mac file's. The Mac reads it from a runtime release that rolls later, so the box ahead matches.
 */
export function blobShortfall(mac: string, box: string): string | null {
  const [macBlob] = JSON.parse(mac.slice(6)) as string[];
  if (!box.startsWith("blobs:")) return `Mac blob ${macBlob?.slice(0, 10)}, box ${box.slice(0, 160)}`;
  const boxBlobs = JSON.parse(box.slice(6)) as string[];
  return boxBlobs.includes(macBlob!) ? null
    : `the Mac's file (blob ${macBlob?.slice(0, 10)}) is at no commit the box checkout's HEAD descends from, box blob ${boxBlobs[0]?.slice(0, 10)}`;
}

type MacCommit = [id: string, patch: string, paths: string[], pushed?: boolean];
interface BoxCommits { ids: string[]; patches: string[]; bytes: string[]; fetched?: string[] }

/**
 * The Mac's last commits on its branch that the box cannot work on, from the probe's `commits:` values. A Mac commit is on the box when the box's
 * dev/sieun has its hash, a commit with its patch-id (taken without context lines, so a change carried onto another base matches), or, for every
 * path it touched, a commit that wrote the same bytes there, which covers a wiki page batch the box wrote again in other commits; or when a branch
 * the box fetched from origin holds its hash, such as the Mac's own dev/sieun-mac (c119). A commit missing on the box that the Mac pushed is a
 * box gap, fixed by a fetch on the box. One the Mac never pushed is `unpushed`: the box cannot reach it, and only the Mac can fix that.
 */
export function commitGaps(mac: string, box: string): { missing: string[]; unpushed: string[]; total: number } {
  const macCommits = JSON.parse(mac.slice(8)) as MacCommit[];
  const boxCommits = JSON.parse(box.slice(8)) as BoxCommits;
  const ids = new Set([...boxCommits.ids, ...boxCommits.fetched ?? []]);
  const patches = new Set(boxCommits.patches);
  const bytes = new Set(boxCommits.bytes);
  const absent = macCommits.filter(([id, patch, paths]) => !ids.has(id) && !(patch && patches.has(patch)) && !paths.every(key => bytes.has(key)));
  return { missing: absent.filter(commit => commit[3] !== false).map(([id]) => id), unpushed: absent.filter(commit => commit[3] === false).map(([id]) => id), total: macCommits.length };
}

const listed = (ids: string[]) => `${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", ..." : ""}`;

export function commitShortfall(mac: string, box: string): string | null {
  if (!box.startsWith("commits:")) return `the Mac gave its commits, box ${box.slice(0, 160)}`;
  const { missing, total } = commitGaps(mac, box);
  return missing.length ? `box lacks ${missing.length} of the Mac's ${total}, which the Mac pushed, so a fetch on the box gets them: ${listed(missing)}` : null;
}

/** The Mac commits the box lacks because the Mac never pushed them, for a `mac_unpushed` item that names them and counts toward no metric. */
export function unpushedNote(mac: string | undefined, box: string | undefined): string | null {
  if (!mac?.startsWith("commits:") || !box?.startsWith("commits:")) return null;
  const { unpushed, total } = commitGaps(mac, box);
  return unpushed.length ? `the Mac has ${unpushed.length} of its last ${total} commits on its branch unpushed to origin, so the box cannot fetch them: ${listed(unpushed)}` : null;
}

/** Orders two probe versions such as "8.1.1" or "3.6a": number by number, then the letter suffix, so "3.6" < "3.6a" < "3.7". */
export function compareVersions(a: string, b: string): number {
  const parts = (text: string) => ({ numbers: text.split(/[^\d]+/).filter(Boolean).map(Number), letter: /[a-z]$/.exec(text)?.[0] ?? "" });
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index++) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return left.letter === right.letter ? 0 : left.letter < right.letter ? -1 : 1;
}

/** The box value of a Skills and tools check: a pass, an off that is off on purpose, or a fail whose detail the probe's `shared` regex matches, is "ok". */
export const panelValue = (outcome: Outcome | undefined, shared?: unknown): string =>
  !outcome ? "fail: the Skills and tools check did not run"
    : outcome.status === "fail" && !(typeof shared === "string" && new RegExp(shared).test(outcome.detail)) ? `fail: ${outcome.detail}` : "ok";

const probesOf = (row: Row, host: "mac" | "box"): Probe[] => row[host] ?? row.probes ?? [];

/** Each row's verdict from both hosts' probe values and the box's Skills and tools outcomes. */
export function judgeRows(rows: readonly Row[], mac: ProbeOutput, box: ProbeOutput, panel: ReadonlyMap<string, Outcome>): RowsResult {
  const result: RowsResult = { off: [], byDesign: [], intended: [], unpushed: [], matched: 0 };
  for (const row of rows) {
    const boxProbes = probesOf(row, "box");
    const macValues = mac.values[row.id] ?? [];
    const boxValues = (box.values[row.id] ?? []).map((value, index) => value === "panel" ? panelValue(panel.get(String(boxProbes[index]?.panel)), boxProbes[index]?.shared) : value);
    const misses: string[] = [];
    const intended: string[] = [];
    probesOf(row, "mac").forEach((_, index) => {
      const unpushed = unpushedNote(macValues[index], boxValues[index]);
      if (unpushed) result.unpushed.push({ row, why: unpushed });
      const why = shortfall(macValues[index], boxValues[index]);
      if (!why) return;
      const reason = boxProbes[index]?.intended;
      if (typeof reason === "string") intended.push(`${why} (${reason})`);
      else misses.push(why);
    });
    if (intended.length) result.intended.push({ row, why: intended.join("; ") });
    if (!misses.length) { result.matched++; continue; }
    if (row.byDesign) { result.byDesign.push({ row, why: `${misses.join("; ")} (${row.byDesign})` }); result.matched++; continue; }
    result.off.push({ row, why: misses.join("; ") });
  }
  return result;
}

/** `systemctl show` output: one record per unit, split on blank lines. */
export function parseShow(text: string): Record<string, string>[] {
  return text.split(/\n\s*\n/).map(block => Object.fromEntries(block.split("\n").filter(line => line.includes("=")).map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }))).filter(unit => unit.Id);
}

/** Each property `systemctl show` reports, the directive a unit file sets it with, and the values that mean nothing is set. */
export const LIMIT_PROPS: readonly { prop: string; directive: string; unset: readonly string[] }[] = [
  { prop: "MemoryMax", directive: "MemoryMax", unset: ["infinity"] },
  { prop: "MemoryHigh", directive: "MemoryHigh", unset: ["infinity"] },
  { prop: "MemorySwapMax", directive: "MemorySwapMax", unset: ["infinity"] },
  { prop: "MemoryLow", directive: "MemoryLow", unset: ["0"] },
  { prop: "MemoryMin", directive: "MemoryMin", unset: ["0"] },
  { prop: "CPUQuotaPerSecUSec", directive: "CPUQuota", unset: ["infinity"] },
  { prop: "CPUWeight", directive: "CPUWeight", unset: ["[not set]"] },
  { prop: "StartupCPUWeight", directive: "StartupCPUWeight", unset: ["[not set]"] },
  { prop: "IOWeight", directive: "IOWeight", unset: ["[not set]"] },
  { prop: "StartupIOWeight", directive: "StartupIOWeight", unset: ["[not set]"] },
  { prop: "IOReadBandwidthMax", directive: "IOReadBandwidthMax", unset: [""] },
  { prop: "IOWriteBandwidthMax", directive: "IOWriteBandwidthMax", unset: [""] },
  { prop: "IOReadIOPSMax", directive: "IOReadIOPSMax", unset: [""] },
  { prop: "IOWriteIOPSMax", directive: "IOWriteIOPSMax", unset: [""] },
  { prop: "TasksMax", directive: "TasksMax", unset: ["infinity"] },
  { prop: "Nice", directive: "Nice", unset: ["0"] },
  { prop: "CPUSchedulingPolicy", directive: "CPUSchedulingPolicy", unset: ["0"] },
  { prop: "IOSchedulingClass", directive: "IOSchedulingClass", unset: ["0", "2"] },
  { prop: "IOSchedulingPriority", directive: "IOSchedulingPriority", unset: ["4"] },
  { prop: "AllowedCPUs", directive: "AllowedCPUs", unset: [""] },
  { prop: "CPUAffinity", directive: "CPUAffinity", unset: [""] },
];
export const SHOW_PROPS = ["Id", "FragmentPath", "DropInPaths", "ActiveState", "MainPID", "Description", ...LIMIT_PROPS.map(limit => limit.prop)];
const VENDOR = /^\/(usr\/)?lib\//;

/** The settings the owner asked for on the box, as their scripts set them: unit weights keyed by scope and unit, the daemon's nice and `heavy`'s scope. */
export interface Layers {
  weights: ReadonlyMap<string, string>;
  nice: { unit: string; value: number };
  heavy: { swapMax: string; score: number };
  rcuBoost: { unit: string; policy: string; stallTimeoutS: number };
}
export interface LimitContext {
  scope: "system" | "user"; defaultTasksMax: string; memTotal: number; layers: Layers;
  read: (path: string) => string | undefined; niceOf: (pid: number) => number | undefined;
}
export interface LimitFinding { key: string; excerpt: string; ownerAsked?: string }

const CPU_LAYERS = "of deploy/linux/README.md, which the owner asked for in his t84 answer of 10-19";
const MEMORY_LAYERS = "of deploy/linux/README.md, which the owner asked for on 10-19";

/** `systemctl show` gives CPUSchedulingPolicy as the kernel's number for the name a unit file sets. */
const POLICY_NUMBERS: Record<string, string> = { other: "0", fifo: "1", rr: "2", batch: "3", idle: "5" };

/**
 * The owner-asked layers from deploy/linux/cpu/setup-cpu.sh (its SYSTEM_WEIGHTS and USER_WEIGHTS tables, `$uid` as the box user's), cpu-protect.py
 * (DAEMON and CORE_NICE), memory/heavy (its systemd-run line) and rcu-boost.service with rcu-boost.py (its policy and STALL_TIMEOUT_S). A script
 * whose shape changed throws, so the metric says not measured.
 */
export function parseLayers(setupCpu: string, cpuProtect: string, heavy: string, uid: number, rcuBoostUnit: string, rcuBoost: string): Layers {
  const weights = new Map<string, string>();
  for (const [table, scope] of [["SYSTEM_WEIGHTS", "system"], ["USER_WEIGHTS", "user"]] as const) {
    const body = new RegExp(`^declare -A ${table}=\\(([^)]*)\\)`, "m").exec(setupCpu)?.[1];
    if (!body) throw new Error(`setup-cpu.sh has no ${table} table`);
    for (const [, unit, weight] of body.matchAll(/\[([^\]]+)\]=(\d+)/g)) weights.set(`${scope} ${unit!.replace("$uid", String(uid))}`, weight!);
  }
  const unit = /^DAEMON = "([^"]+)"/m.exec(cpuProtect)?.[1];
  const nice = /^CORE_NICE = (-?\d+)/m.exec(cpuProtect)?.[1];
  if (!unit || !nice) throw new Error("cpu-protect.py has no DAEMON or CORE_NICE");
  const run = /systemd-run --user --scope .*-p MemoryMax="\$size" -p MemorySwapMax=(\S+) -- choom -n (-?\d+) --/.exec(heavy);
  if (!run) throw new Error("heavy has no systemd-run --user --scope line with MemoryMax, MemorySwapMax and choom");
  const policy = POLICY_NUMBERS[/^CPUSchedulingPolicy=(\w+)$/m.exec(rcuBoostUnit)?.[1] ?? ""];
  const stall = /^STALL_TIMEOUT_S = (\d+)$/m.exec(rcuBoost)?.[1];
  if (!policy || !stall) throw new Error("rcu-boost.service has no CPUSchedulingPolicy or rcu-boost.py no STALL_TIMEOUT_S");
  return { weights, nice: { unit, value: Number(nice) }, heavy: { swapMax: run[1]!, score: Number(run[2]) },
    rcuBoost: { unit: "rcu-boost.service", policy, stallTimeoutS: Number(stall) } };
}

/**
 * A `heavy` scope: a systemd-run user scope with heavy's MemorySwapMax whose command, in the Description systemd-run gives it, is heavy's choom
 * call. A scope whose command failed keeps its unit and settings with no process left, and still matches.
 */
const isHeavyScope = (unit: Record<string, string>, context: LimitContext): boolean =>
  context.scope === "user" && /^run-p\d+-i\d+\.scope$/.test(unit.Id!) && unit.MemorySwapMax === context.layers.heavy.swapMax
    && new RegExp(`^\\[systemd-run\\] (\\S*/)?choom -n ${context.layers.heavy.score} -- `).test(unit.Description ?? "");

/** Why the owner asked for this setting on this unit, or undefined when no layer sets it to this value. */
export function layerReason(unit: Record<string, string>, prop: string, value: string, context: LimitContext): string | undefined {
  if (prop === "CPUWeight" && context.layers.weights.get(`${context.scope} ${unit.Id}`) === value) return `setup-cpu.sh sets it as CPU layer 1 ${CPU_LAYERS}`;
  if ((prop === "MemoryMax" || prop === "MemorySwapMax") && isHeavyScope(unit, context)) return `\`heavy\` sets it as memory layer 4 ${MEMORY_LAYERS}`;
  if (prop === "CPUSchedulingPolicy" && context.scope === "system" && unit.Id === context.layers.rcuBoost.unit && value === context.layers.rcuBoost.policy) {
    return `rcu-boost.service sets it as CPU layer 3 ${CPU_LAYERS}`;
  }
  return undefined;
}

/** A unit name with its instance numbers and ids folded, so 12 CI guest scopes or 40 container scopes are one setting to fix. */
export const foldName = (id: string): string => id.replace(/\\x2d/g, "-").replace(/[0-9a-f]{12,}/g, "<id>").replace(/(?<=[-@][a-z]?)\d+/g, "N");
/** systemd-machined gives every machine scope it registers TasksMax=16384 (MACHINE_TASKS_MAX in systemd's machine.c), so a libvirt guest's is the vendor's. */
const MACHINED_TASKS_MAX = "16384";

/**
 * The limits one unit carries that no vendor file ships: for each set property, the last of its unit file and drop-ins that names the directive
 * decides; a file under /usr/lib or /lib is the vendor's, and a property no file names was set at runtime (`systemctl set-property`, systemd-run).
 */
export function unitLimits(unit: Record<string, string>, context: LimitContext): LimitFinding[] {
  const files = [unit.FragmentPath, ...(unit.DropInPaths ?? "").split(" ")].filter((file): file is string => Boolean(file));
  const findings: LimitFinding[] = [];
  for (const limit of LIMIT_PROPS) {
    const value = unit[limit.prop];
    if (value === undefined || limit.unset.includes(value)) continue;
    if (limit.prop === "TasksMax" && (value === context.defaultTasksMax || (unit.Id!.startsWith("machine-") && value === MACHINED_TASKS_MAX))) continue;
    if (limit.prop.startsWith("Memory") && Number(value) >= context.memTotal) continue;
    const source = files.filter(file => new RegExp(`^\\s*${limit.directive}=`, "m").test(context.read(file) ?? "")).at(-1);
    if (source && VENDOR.test(source)) continue;
    const ownerAsked = layerReason(unit, limit.prop, value, context);
    findings.push({ key: `${context.scope} ${foldName(unit.Id!)} ${limit.directive}`,
      excerpt: `${context.scope} unit ${unit.Id} sets ${limit.directive} (${limit.prop}=${value}) ${source ? `in ${source}` : "at runtime"}`, ...ownerAsked ? { ownerAsked } : {} });
  }
  const pid = Number(unit.MainPID);
  if (unit.ActiveState === "active" && pid > 0 && unit.Nice === "0") {
    const nice = context.niceOf(pid);
    const asked = context.scope === "user" && unit.Id === context.layers.nice.unit && nice === context.layers.nice.value;
    if (nice) findings.push({ key: `${context.scope} ${foldName(unit.Id!)} nice`, excerpt: `${context.scope} unit ${unit.Id}: its main process ${pid} runs at nice ${nice}, which the unit does not set`,
      ...asked ? { ownerAsked: `cpu-protect.py sets it as CPU layer 2 ${CPU_LAYERS}` } : {} });
  }
  return findings;
}

export interface Container { Name?: string; HostConfig?: Record<string, unknown> }
/** Docker HostConfig limits: CPU, pids, IO weight, cpuset and memory reservation, and a memory limit below the box's RAM. */
export function containerLimits(containers: readonly Container[], memTotal: number): LimitFinding[] {
  const findings: LimitFinding[] = [];
  for (const container of containers) {
    const config = container.HostConfig ?? {};
    const name = (container.Name ?? "?").replace(/^\//, "");
    const set = (key: string, unset: (value: unknown) => boolean) => {
      if (!unset(config[key])) findings.push({ key: `docker ${foldName(name)} ${key}`, excerpt: `docker container ${name} sets HostConfig.${key}=${JSON.stringify(config[key])}` });
    };
    const zero = (value: unknown) => value === undefined || value === null || value === 0 || value === "";
    set("Memory", value => zero(value) || Number(value) >= memTotal);
    set("MemoryReservation", zero);
    set("NanoCpus", zero);
    set("CpuQuota", zero);
    set("CpuShares", value => zero(value) || value === 1024);
    set("PidsLimit", value => zero(value) || value === -1);
    set("BlkioWeight", zero);
    set("CpusetCpus", zero);
  }
  return findings;
}

/** Non-comment `Default*Max`, `DefaultCPUQuota`, `DefaultTasksMax` or `UserTasksMax` lines in the systemd manager and logind files. */
export function managerLimits(files: readonly { path: string; text: string }[]): LimitFinding[] {
  return files.flatMap(({ path, text }) => text.split("\n").map(line => line.trim())
    .filter(line => /^(Default\w*(Max|Quota|Weight|Limit\w*)|UserTasksMax)=/.test(line) && !/=(infinity)?$/.test(line))
    .map(line => ({ key: `manager ${path} ${line.split("=")[0]}`, excerpt: `${path} sets ${line}` })));
}

/** Port 22 on the public address, judged by what us-metal01 got from it and from a port with nothing behind it. */
export function publicSsh(answers: { ssh: string; control: string } | Error, guard: Record<string, string>): { value?: number; excerpt: string } {
  const guardOn = guard.ActiveState === "active" && guard.Result === "success";
  const guardText = `ssh-public-guard.service ${guard.ActiveState ?? "unknown"} (${guard.Result ?? "?"})`;
  if (!guardOn) return { value: 1, excerpt: `${guardText}, so the nft table inet ssh_public_guard is not loaded` };
  if (answers instanceof Error) return { excerpt: `${guardText}; no outside answer: ${answers.message}` };
  if (answers.ssh === "open") return { value: 1, excerpt: `${guardText}, but port 22 accepted a connection from ${OUTSIDE}` };
  if (answers.control === "refused") return { value: 0, excerpt: `${guardText}; from ${OUTSIDE} port 22 gave ${answers.ssh} and a closed port gave refused, so the path reaches the box` };
  return { excerpt: `${guardText}; from ${OUTSIDE} port 22 gave ${answers.ssh} and the closed port gave ${answers.control}, so the path is unproven` };
}

/**
 * `rcu_boost_off`: 1 when rcu-boost.service, CPU layer 3, is not running or the kernel's RCU stall warning delay is not the STALL_TIMEOUT_S it
 * sets. Without it a reader preempted in an RCU read section can starve, as one did on us-metal02 from 11:23Z to 13:06Z on 10-20 and hung the box.
 */
export function rcuBoostOff(unit: Record<string, string>, stallTimeout: string | Error, want: number): { value?: number; excerpt: string } {
  if (stallTimeout instanceof Error) return { excerpt: `rcu_cpu_stall_timeout could not be read: ${stallTimeout.message}` };
  const running = unit.ActiveState === "active" && unit.SubState === "running";
  const timeout = Number(stallTimeout.trim());
  const text = `rcu-boost.service ${unit.ActiveState ?? "unknown"} (${unit.SubState ?? "?"}), rcu_cpu_stall_timeout ${stallTimeout.trim()} s against ${want} s`;
  return { value: running && timeout === want ? 0 : 1, excerpt: text };
}

type Exec = (file: string, args: readonly string[], options?: { input?: string; timeoutMs?: number; cwd?: string }) => Promise<string>;
const exec: Exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, cwd: options.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim().slice(0, 300)}`)) : resolve(stdout));
  if (options.input !== undefined) child.stdin!.end(options.input);
});

const PROBE = join(HERE, "box-parity-probe.py");
const DEPLOY = join(HERE, "../../../../../deploy/linux");

async function readLayers(): Promise<Layers> {
  const [setupCpu, cpuProtect, heavy, rcuUnit, rcuBoost] = await Promise.all(["cpu/setup-cpu.sh", "cpu/cpu-protect.py", "memory/heavy", "cpu/rcu-boost.service", "cpu/rcu-boost.py"]
    .map(file => readFile(join(DEPLOY, file), "utf8")));
  return parseLayers(setupCpu!, cpuProtect!, heavy!, process.getuid!(), rcuUnit!, rcuBoost!);
}

const probeArg = (host: "mac" | "box", rows: readonly Row[], known: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ host, rows, known })).toString("base64");

async function probeBox(rows: readonly Row[]): Promise<ProbeOutput> {
  return JSON.parse(await exec("python3", [PROBE, probeArg("box", rows, {})], { timeoutMs: 80_000 })) as ProbeOutput;
}

async function probeMac(rows: readonly Row[], known: Record<string, unknown>): Promise<ProbeOutput> {
  const script = await readFile(PROBE, "utf8");
  const text = await exec("timeout", [String(MAC_TIMEOUT_S), "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=40", MAC, "/usr/bin/python3", "-", probeArg("mac", rows, known)],
    { input: script, timeoutMs: (MAC_TIMEOUT_S + 5) * 1000 });
  return JSON.parse(text) as ProbeOutput;
}

async function panelOutcomes(rows: readonly Row[]): Promise<Map<string, Outcome>> {
  const ids = new Set(rows.flatMap(row => probesOf(row, "box")).map(probe => probe.panel).filter((id): id is string => typeof id === "string"));
  const { pinSkillPaths: _writesThePin, ...deps } = realDeps(tmpdir());
  const results = await runChecks(deps, CHECKS.filter(check => ids.has(check.id)));
  return new Map(results.map(result => [result.check.id, result.outcome]));
}

async function resourceLimits(): Promise<LimitFinding[]> {
  const memTotal = Number(/^MemTotal:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8"))?.[1] ?? NaN) * 1024;
  const layers = await readLayers();
  const cache = new Map<string, string | undefined>();
  const files = new Map<string, string>();
  const read = (path: string) => files.get(path);
  const niceOf = (pid: number) => { const stat = cache.get(`/proc/${pid}/stat`); return stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]) : undefined; };
  const findings: LimitFinding[] = [];
  for (const scope of ["system", "user"] as const) {
    const flag = scope === "user" ? ["--user"] : [];
    const [show, manager] = await Promise.all([
      exec("systemctl", [...flag, "show", "*", "--all", "-p", SHOW_PROPS.join(",")], { timeoutMs: 60_000 }),
      exec("systemctl", [...flag, "show", "-p", "DefaultTasksMax"]),
    ]);
    const units = parseShow(show);
    const paths = new Set(units.flatMap(unit => [unit.FragmentPath, ...(unit.DropInPaths ?? "").split(" ")]).filter((path): path is string => Boolean(path)));
    await Promise.all([...paths].map(async path => { files.set(path, await readFile(path, "utf8").catch(() => "")); }));
    await Promise.all(units.map(async unit => {
      const pid = Number(unit.MainPID);
      if (pid > 0) cache.set(`/proc/${pid}/stat`, await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined));
    }));
    const defaultTasksMax = manager.trim().split("=")[1] ?? "";
    for (const unit of units) findings.push(...unitLimits(unit, { scope, defaultTasksMax, memTotal, layers, read, niceOf }));
  }
  const ids = (await exec("docker", ["ps", "-q"])).split("\n").filter(Boolean);
  const containers = await Promise.all(ids.map(id => exec("docker", ["inspect", id]).then(text => JSON.parse(text) as Container[], () => [] as Container[])));
  findings.push(...containerLimits(containers.flat(), memTotal));
  const managerFiles = ["/etc/systemd/system.conf", "/etc/systemd/user.conf", "/etc/systemd/logind.conf",
    ...["system.conf.d", "user.conf.d", "logind.conf.d"].flatMap(folder => [`/etc/systemd/${folder}`])];
  const texts: { path: string; text: string }[] = [];
  for (const path of managerFiles) {
    if (path.endsWith(".d")) {
      const names = await readdir(path).catch(() => [] as string[]);
      for (const name of names.filter(name => name.endsWith(".conf"))) texts.push({ path: join(path, name), text: await readFile(join(path, name), "utf8").catch(() => "") });
    } else texts.push({ path, text: await readFile(path, "utf8").catch(() => "") });
  }
  findings.push(...managerLimits(texts));
  return findings;
}

async function outsideSsh(): Promise<{ ssh: string; control: string }> {
  const route = await exec("ip", ["-4", "route", "get", "1.1.1.1"]);
  const address = /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1];
  if (!address) throw new Error(`no public source address in \`ip route get 1.1.1.1\`: ${route.trim()}`);
  const dial = (port: number) => `timeout 6 bash -c '</dev/tcp/${address}/${port}' 2>/tmp/box-parity-dial.$$; c=$?; ` +
    `if [ $c = 0 ]; then echo open; elif grep -q refused /tmp/box-parity-dial.$$; then echo refused; elif [ $c = 124 ]; then echo dropped; else echo error$c; fi; rm -f /tmp/box-parity-dial.$$`;
  const text = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", OUTSIDE, `${dial(22)}; ${dial(9)}`], { timeoutMs: 40_000 });
  const [ssh = "none", control = "none"] = text.trim().split("\n");
  return { ssh: `${ssh} (${address}:22)`.replace(/^open \(.*/, "open"), control };
}

const settle = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

export async function measure(rows: readonly Row[], known: Record<string, unknown>): Promise<{ output: PrecheckOutput; versions?: Record<string, unknown> }> {
  const at = Date.now();
  const showUnit = (unit: string, props: string) =>
    exec("systemctl", ["show", unit, "-p", props]).then(text => Object.fromEntries(text.trim().split("\n").map(line => line.split("="))) as Record<string, string>, () => ({}));
  const away = await macAway(MAC, "tool rows are", at);
  // With the Mac away the box side of the rows has nothing to match, so neither the box probe nor the panel checks run.
  const skip = <T>(read: () => Promise<T>): Promise<T | Error> => away ? Promise.resolve(new Error(away.excerpt)) : settle(read());
  const [mac, box, panel, limits, outside, guard, rcuUnit, stallTimeout, layers] = await Promise.all([
    skip(() => probeMac(rows, known)), skip(() => probeBox(rows)), skip(() => panelOutcomes(rows)), settle(resourceLimits()), settle(outsideSsh()),
    showUnit("ssh-public-guard.service", "ActiveState,Result"), showUnit("rcu-boost.service", "ActiveState,SubState"),
    settle(readFile("/sys/module/rcupdate/parameters/rcu_cpu_stall_timeout", "utf8")), settle(readLayers()),
  ]);
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const sourceError = (excerpt: string) => flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) });

  if (away) flagged.push(away);
  else if (mac instanceof Error) sourceError(`the Mac read over ssh failed, so tool rows are not measured: ${mac.message}`);
  else if (box instanceof Error) sourceError(`the box probe failed: ${box.message}`);
  else {
    const result = judgeRows(rows, mac, box, panel instanceof Error ? new Map() : panel);
    if (panel instanceof Error) sourceError(`the Skills and tools checks did not run: ${panel.message}`);
    metrics.tool_rows_off = result.off.length;
    for (const { row, why } of result.off) flagged.push({ at, kind: "tool_row_off", item: row.id, excerpt: `${row.tool}: ${why}${row.note ? ` (${row.note})` : ""}`.slice(0, 600) });
    for (const { row, why } of result.intended) flagged.push({ at, kind: "intended", item: row.id, excerpt: `${row.tool}: ${why}`.slice(0, 600) });
    for (const { row, why } of result.byDesign) flagged.push({ at, kind: "by_design", item: row.id, excerpt: `${row.tool}: ${why}`.slice(0, 600) });
    for (const { row, why } of result.unpushed) flagged.push({ at, kind: "mac_unpushed", item: row.id, excerpt: `${row.tool}: ${why}`.slice(0, 600) });
    flagged.push({ at, kind: "rows", excerpt: `${result.matched} of ${rows.length} rows match; the Mac read took ${mac.ms} ms and the box probe ${box.ms} ms` });
  }

  if (limits instanceof Error) sourceError(`resource limits: ${limits.message}`);
  else {
    const group = (findings: LimitFinding[]) => {
      const byKey = new Map<string, LimitFinding[]>();
      for (const finding of findings) byKey.set(finding.key, [...byKey.get(finding.key) ?? [], finding]);
      return [...byKey].map(([key, same]) => ({ key, excerpt: `${same[0]!.excerpt}${same.length > 1 ? ` (and ${same.length - 1} more like it)` : ""}`, ownerAsked: same[0]!.ownerAsked }));
    };
    const counted = group(limits.filter(finding => !finding.ownerAsked));
    metrics.resource_limits_set = counted.length;
    for (const { key, excerpt } of counted) flagged.push({ at, kind: "resource_limit", item: key, excerpt: excerpt.slice(0, 600) });
    for (const { key, excerpt, ownerAsked } of group(limits.filter(finding => finding.ownerAsked))) {
      flagged.push({ at, kind: "owner_asked", item: key, excerpt: `${excerpt}; ${ownerAsked}`.slice(0, 600) });
    }
  }

  const ssh = publicSsh(outside, guard);
  if (ssh.value === undefined) sourceError(`public ssh: ${ssh.excerpt}`);
  else metrics.public_ssh_open = ssh.value;
  flagged.push({ at, kind: "public_ssh", excerpt: ssh.excerpt.slice(0, 600) });

  const rcu = layers instanceof Error ? { excerpt: `deploy/linux layers: ${layers.message}` } : rcuBoostOff(rcuUnit, stallTimeout, layers.rcuBoost.stallTimeoutS);
  if (rcu.value === undefined) sourceError(`rcu boost: ${rcu.excerpt}`);
  else metrics.rcu_boost_off = rcu.value;
  flagged.push({ at, kind: "rcu_boost", excerpt: rcu.excerpt.slice(0, 600) });
  return { output: { metrics, flagged }, ...(mac instanceof Error ? {} : { versions: mac.versions }) };
}

async function main(): Promise<void> {
  const rows = JSON.parse(await readFile(join(HERE, "box-parity.rows.json"), "utf8")) as Row[];
  const stateFile = process.env.STATE_FILE;
  const state: { versions?: Record<string, unknown> } = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as { versions?: Record<string, unknown> }, () => ({})) : {};
  const result = await measure(rows, state.versions ?? {});
  const text = JSON.stringify(result.output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  if (stateFile && result.versions) await writeFile(stateFile, JSON.stringify({ versions: { ...state.versions, ...result.versions } }) + "\n");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
