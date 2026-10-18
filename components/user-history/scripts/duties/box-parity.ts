import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHECKS, type Outcome, realDeps, runChecks } from "./skills-and-tools.ts";

/**
 * The Box tools parity duty's precheck (`node --import tsx scripts/duties/box-parity.ts`): whether us-metal02 still matches the owner's MacBook Pro
 * for every tool auto-sns-agent and sieun-pi agents use (owner 10-18). No model call, nothing sent outside. Four numbers:
 * - `tool_rows_off`: rows of box-parity.rows.json (the 167 rows of the 10-18 audit, /home/sieun/box-tools-parity/gap-table.md) where the box lacks
 *   what the Mac has: a file, folder entry, config hash, CLI version, port, service, or a real call that fails on the box. box-parity-probe.py reads
 *   both sides, the Mac over one `ssh mac` that only reads (see the probe's docstring). The Mac is the standard, so a Mac value that is absent or
 *   failing asks nothing of the box, a set on the box may hold more than the Mac's, and a CLI version on the box may be newer. A probe with `intended` (Poppler) and a row with `byDesign`
 *   are listed and never counted. Rows with a `panel` probe run that Skills and tools check (skills-and-tools.ts) here, without its fixes.
 * - `mac_behind_box`: commits on the box's auto-sns-agent sieun/dev, the shared tip since 10-18 11:23Z, that the Mac's sieun/dev lacks.
 * - `resource_limits_set`: memory, CPU, IO, task and priority settings on the box's systemd units, Docker containers and systemd manager files that
 *   no vendor file ships (owner rule c107: "remove all the bullshit i didn't explicitly asked for"), one per setting and unit name with its numbers
 *   folded, plus services whose main process runs at a nice level its unit does not set. A limit at or above the box's RAM limits nothing.
 * - `public_ssh_open`: 1 when port 22 on the box's public address answers from us-metal01 (METAL_SSH_HOST), or ssh-public-guard.service is not
 *   active; the probe also dials a closed port, so a refused answer proves the path reaches the box.
 * A source that cannot be read leaves its metric out with a `source_error` item, so the run says not measured instead of a miss.
 * STATE_FILE keeps the Mac CLI versions the probe had to run, keyed by path and mtime, so later runs only read the Mac.
 */

const HOME = homedir();
const REPO = process.env.LLM_WIKI_REPO || join(HOME, "Documents/Github/auto-sns-agent");
const HERE = import.meta.dirname;
const MAC = process.env.MAC_SSH_HOST || "mac";
const OUTSIDE = process.env.METAL_SSH_HOST || "us-metal01";
/** The whole Mac read, ssh included: on 10-18 at load 450 the Mac took 9 to 40 s (probe 6 s, the rest ssh). */
const MAC_TIMEOUT_S = 90;

export type Probe = Record<string, unknown>;
export interface Row { id: string; tool: string; probes?: Probe[]; mac?: Probe[]; box?: Probe[]; note?: string; byDesign?: string }
/** The Mac's sieun/dev tip and, when the Mac holds the box tip, the commits only the box has (`boxOnly`) and only the Mac has (`macOnly`). */
export interface Checkout { tip?: string; boxOnly?: number; macOnly?: number; error?: string; countError?: string }
export interface ProbeOutput { host: "mac" | "box"; values: Record<string, string[]>; checkout: Checkout; versions: Record<string, unknown>; ms: number }
export interface RowVerdict { row: Row; why: string }
export interface RowsResult { off: RowVerdict[]; byDesign: RowVerdict[]; intended: RowVerdict[]; matched: number }

const setOf = (value: string): string[] | undefined => value.startsWith("set:") ? JSON.parse(value.slice(4)) as string[] : undefined;
const failing = (value: string | undefined): boolean => value === undefined || value === "absent" || value.startsWith("fail");

/**
 * Why the box value falls short of the Mac value, or null when it matches. The Mac is the standard; a box set may hold extra entries, and a box CLI
 * version at or above the Mac's matches, because a newer jq or psql on the box gives agents every feature the Mac's has (owner 10-18 goal p1).
 */
export function shortfall(mac: string | undefined, box: string | undefined): string | null {
  if (failing(mac)) return null;
  if (box === undefined) return "the box gave no value";
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

/** The box value of a Skills and tools check: a pass, or an off that is off on purpose, is "ok". */
export const panelValue = (outcome: Outcome | undefined): string =>
  !outcome ? "fail: the Skills and tools check did not run" : outcome.status === "fail" ? `fail: ${outcome.detail}` : "ok";

const probesOf = (row: Row, host: "mac" | "box"): Probe[] => row[host] ?? row.probes ?? [];

/** Each row's verdict from both hosts' probe values and the box's Skills and tools outcomes. */
export function judgeRows(rows: readonly Row[], mac: ProbeOutput, box: ProbeOutput, panel: ReadonlyMap<string, Outcome>): RowsResult {
  const result: RowsResult = { off: [], byDesign: [], intended: [], matched: 0 };
  for (const row of rows) {
    const boxProbes = probesOf(row, "box");
    const macValues = mac.values[row.id] ?? [];
    const boxValues = (box.values[row.id] ?? []).map((value, index) => value === "panel" ? panelValue(panel.get(String(boxProbes[index]?.panel))) : value);
    const misses: string[] = [];
    const intended: string[] = [];
    probesOf(row, "mac").forEach((_, index) => {
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
export const SHOW_PROPS = ["Id", "FragmentPath", "DropInPaths", "ActiveState", "MainPID", ...LIMIT_PROPS.map(limit => limit.prop)];
const VENDOR = /^\/(usr\/)?lib\//;

export interface LimitContext { scope: "system" | "user"; defaultTasksMax: string; memTotal: number; read: (path: string) => string | undefined; niceOf: (pid: number) => number | undefined }
export interface LimitFinding { key: string; excerpt: string }

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
    findings.push({ key: `${context.scope} ${foldName(unit.Id!)} ${limit.directive}`,
      excerpt: `${context.scope} unit ${unit.Id} sets ${limit.directive} (${limit.prop}=${value}) ${source ? `in ${source}` : "at runtime"}` });
  }
  const pid = Number(unit.MainPID);
  if (unit.ActiveState === "active" && pid > 0 && unit.Nice === "0") {
    const nice = context.niceOf(pid);
    if (nice) findings.push({ key: `${context.scope} ${foldName(unit.Id!)} nice`, excerpt: `${context.scope} unit ${unit.Id}: its main process ${pid} runs at nice ${nice}, which the unit does not set` });
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

type Exec = (file: string, args: readonly string[], options?: { input?: string; timeoutMs?: number; cwd?: string }) => Promise<string>;
const exec: Exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, cwd: options.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim().slice(0, 300)}`)) : resolve(stdout));
  if (options.input !== undefined) child.stdin!.end(options.input);
});

const PROBE = join(HERE, "box-parity-probe.py");
const probeArg = (host: "mac" | "box", rows: readonly Row[], boxTip: string | undefined, known: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ host, rows, boxTip: boxTip ?? null, known })).toString("base64");

async function probeBox(rows: readonly Row[]): Promise<ProbeOutput> {
  return JSON.parse(await exec("python3", [PROBE, probeArg("box", rows, undefined, {})], { timeoutMs: 80_000 })) as ProbeOutput;
}

async function probeMac(rows: readonly Row[], boxTip: string | undefined, known: Record<string, unknown>): Promise<ProbeOutput> {
  const script = await readFile(PROBE, "utf8");
  const text = await exec("timeout", [String(MAC_TIMEOUT_S), "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=40", MAC, "/usr/bin/python3", "-", probeArg("mac", rows, boxTip, known)],
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
    for (const unit of units) findings.push(...unitLimits(unit, { scope, defaultTasksMax, memTotal, read, niceOf }));
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

/**
 * Commits on the box's sieun/dev that the Mac's sieun/dev lacks. Since 10-18 11:23Z the box holds the shared tip and the Mac follows it. Counted
 * on the box when it holds the Mac tip, else on the Mac when the Mac holds the box tip. Commits only the Mac has are named but not counted.
 */
async function macBehind(boxTip: string | undefined, mac: Checkout): Promise<{ behind: number; excerpt: string } | { error: string }> {
  if (!boxTip) return { error: `the box has no sieun/dev in ${REPO}` };
  if (!mac.tip) return { error: `the Mac gave no sieun/dev tip: ${mac.error ?? "no answer"}` };
  const where = `box ${boxTip.slice(0, 10)}, Mac ${mac.tip.slice(0, 10)}`;
  const counts = await exec("git", ["-C", REPO, "rev-list", "--left-right", "--count", `${boxTip}...${mac.tip}`]).then(text => text.trim().split(/\s+/).map(Number), () => undefined);
  const [behind, ahead] = counts?.length === 2 ? counts as [number, number] : mac.boxOnly !== undefined ? [mac.boxOnly, mac.macOnly ?? 0] : [undefined, undefined];
  if (behind === undefined) return { error: `neither checkout holds the other's tip (${where}), so the count needs a fetch this read-only run does not do` };
  return { behind, excerpt: `auto-sns-agent sieun/dev: ${where}; the Mac lacks ${behind} of the box's commits${ahead ? ` and holds ${ahead} the box lacks` : ""}${counts ? "" : " (counted on the Mac)"}` };
}

const settle = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

export async function measure(rows: readonly Row[], known: Record<string, unknown>): Promise<{ output: PrecheckOutput; versions?: Record<string, unknown> }> {
  const at = Date.now();
  const boxTip = await exec("git", ["-C", REPO, "rev-parse", "sieun/dev"]).then(text => text.trim(), () => undefined);
  const [mac, box, panel, limits, outside, guard] = await Promise.all([
    settle(probeMac(rows, boxTip, known)), settle(probeBox(rows)), settle(panelOutcomes(rows)), settle(resourceLimits()), settle(outsideSsh()),
    exec("systemctl", ["show", "ssh-public-guard.service", "-p", "ActiveState,Result"]).then(text => Object.fromEntries(text.trim().split("\n").map(line => line.split("="))) as Record<string, string>, () => ({})),
  ]);
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const sourceError = (excerpt: string) => flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) });

  if (mac instanceof Error) sourceError(`the Mac read over ssh failed, so tool rows and the Mac's checkout are not measured: ${mac.message}`);
  else if (box instanceof Error) sourceError(`the box probe failed: ${box.message}`);
  else {
    const result = judgeRows(rows, mac, box, panel instanceof Error ? new Map() : panel);
    if (panel instanceof Error) sourceError(`the Skills and tools checks did not run: ${panel.message}`);
    metrics.tool_rows_off = result.off.length;
    for (const { row, why } of result.off) flagged.push({ at, kind: "tool_row_off", item: row.id, excerpt: `${row.tool}: ${why}${row.note ? ` (${row.note})` : ""}`.slice(0, 600) });
    for (const { row, why } of result.intended) flagged.push({ at, kind: "intended", item: row.id, excerpt: `${row.tool}: ${why}`.slice(0, 600) });
    for (const { row, why } of result.byDesign) flagged.push({ at, kind: "by_design", item: row.id, excerpt: `${row.tool}: ${why}`.slice(0, 600) });
    flagged.push({ at, kind: "rows", excerpt: `${result.matched} of ${rows.length} rows match; the Mac read took ${mac.ms} ms and the box probe ${box.ms} ms` });
  }

  if (!(mac instanceof Error)) {
    const count = await macBehind(boxTip, mac.checkout);
    if ("behind" in count) {
      metrics.mac_behind_box = count.behind;
      flagged.push({ at, kind: "checkout", excerpt: count.excerpt });
    } else sourceError(`checkout: ${count.error}`);
  }

  if (limits instanceof Error) sourceError(`resource limits: ${limits.message}`);
  else {
    const byKey = new Map<string, string[]>();
    for (const finding of limits) byKey.set(finding.key, [...byKey.get(finding.key) ?? [], finding.excerpt]);
    metrics.resource_limits_set = byKey.size;
    for (const [key, excerpts] of byKey) flagged.push({ at, kind: "resource_limit", item: key, excerpt: `${excerpts[0]}${excerpts.length > 1 ? ` (and ${excerpts.length - 1} more like it)` : ""}`.slice(0, 600) });
  }

  const ssh = publicSsh(outside, guard);
  if (ssh.value === undefined) sourceError(`public ssh: ${ssh.excerpt}`);
  else metrics.public_ssh_open = ssh.value;
  flagged.push({ at, kind: "public_ssh", excerpt: ssh.excerpt.slice(0, 600) });
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
