import { execFile } from "node:child_process";
import { readFile, readlink, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Demo sandbox works duty's precheck (`node --import tsx scripts/duties/demo-sandbox.ts`) for the frontend chat: the 5180 demo
 * (apps/virev-demo in auto-sns-agent). No model call, no browser. Since 10-19 the demo runs only on the owner's Mac (owner: "for demo frontend
 * for now it should all be here"), so the duty's precheck command runs this script from the Mac's sieun-pi checkout over `ssh mac`. Its judged metrics (owner c75, 10-15: one headline plus at most 3):
 * - walk_problems, the headline: problems in the last offline walk of the 6 apps (tests/e2e/offline.spec.ts walks search, discover,
 *   analytics, campaigns, inbox and connections in two scenarios, plus the marketing pages). Each outside request counts 1, each test that
 *   failed for another reason counts 1, and a missing walk or one over a day old counts 1. The owner: "no external connection should work
 *   off of internal fake database". The walk is a browser check, so the duty job runs it behind the load gate and writes Playwright's JSON
 *   report to WALK_FILE and its stderr to WALK_ERR_FILE; this script only reads those files.
 * - health_ms: how long 5180 /health took to answer 200, at most 3 s. No answer or a non-200 reads as the full 30 s wait.
 * - restarts_24h: times in 24 h the dev server went down without anyone asking for it (crashes and other exit codes, dev-guard memory
 *   kills), from pm2.log, so it measures whether the sandbox stays up. A crash loop counts once. A deliberate `pm2 restart` or `pm2 stop`
 *   by an agent or a person, and a restart that a vite config edit asks for ("config changed, exiting so pm2 starts a fresh dev server"),
 *   are planned, so they are run detail (owner via frontend bro, 10-19: count only unplanned exits).
 * - ssr_timeouts_24h: times in 24 h a page hung on "transport invoke timed out", from the pm2 error log. Error lines less than
 *   EVENT_GAP_MS apart are one event, since one hung request logs 3 to 20 lines.
 * Run detail, written to the output but not judged: configure_ms, dev_tree_mb, headless_chrome, guard_restarts_24h, config_restarts_24h,
 * planned_restarts_24h, outside_requests and source_errors. A source this check cannot read adds 1 to the metric it feeds, because an unread source cannot
 * show a clean day, plus 1 to source_errors and a flagged slice. `lastEventAt` names the newest restart and SSR timeout, so a miss streak whose
 * events stopped is not called stuck (`MetricStreak.quietSince`).
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");

/** Every live pid under `root`, `root` included, from `ps -axo pid=,ppid=`. */
export function treePids(ps: string, root: number): number[] {
  const kids = new Map<number, number[]>();
  const alive = new Set<number>();
  for (const line of ps.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    alive.add(pid);
    kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid]);
  }
  const tree: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (!alive.has(pid) || tree.includes(pid)) continue;
    tree.push(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return tree;
}

/** The sum of `phys_footprint` in `footprint -f bytes` output, in MB: the memory macOS counts, compressed and swapped pages included. */
export function footprintMb(output: string): number {
  const bytes = [...output.matchAll(/phys_footprint: (\d+) B/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  return Math.round(bytes / 1024 / 1024);
}

/**
 * The sum of `Pss` and `SwapPss` over `/proc/<pid>/smaps_rollup` texts, in MB: the Linux count nearest to phys_footprint, with swapped pages
 * included and pages shared inside the tree counted once. The pm2 daemon runs every dev app in one systemd unit (auto-sns-dev-pm2.service on
 * us-metal02), so the unit's memory.current is the whole stack, not this tree.
 */
export function pssMb(rollups: readonly string[]): number {
  const kb = rollups.flatMap(text => [...text.matchAll(/^(?:Pss|SwapPss):\s+(\d+) kB$/gm)]).reduce((sum, match) => sum + Number(match[1]), 0);
  return Math.round(kb / 1024);
}

/** How the dev tree's memory is read on the host the precheck measures: footprint on macOS, smaps_rollup on Linux. */
export async function treeMb(deps: Pick<SandboxDeps, "exec" | "read" | "platform">, pids: readonly number[]): Promise<number> {
  if (deps.platform === "darwin") return footprintMb(await deps.exec("footprint", ["--noCategories", "-f", "bytes", ...pids.flatMap(pid => ["-p", String(pid)])]));
  const rollups = await Promise.all(pids.map(pid => deps.read(`/proc/${pid}/smaps_rollup`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return "";
    throw error;
  })));
  if (!rollups.some(Boolean)) throw new Error(`no /proc/<pid>/smaps_rollup could be read for pids ${pids.join(", ")}`);
  return pssMb(rollups);
}

/**
 * The headless Chrome browsers on the host (a Chrome process with --headless and no --type=) and every process under them. On 10-19 about 18
 * shot browsers from demo jobs ran on the Mac at once, its load hit 78 and /health went unanswered for 120 s, so the run detail shows a pile-up.
 */
export function headlessChrome(ps: string): { browsers: number; processes: number } {
  const browsers = ps.split("\n").map(line => /^\s*(\d+)\s+\d+\s+(.*)$/.exec(line)).filter(match => match !== null)
    .filter(match => /chrom/i.test(match[2]!) && /\s--headless(?:[=\s]|$)/.test(match[2]!) && !match[2]!.includes("--type="))
    .map(match => Number(match[1]));
  return { browsers: browsers.length, processes: new Set(browsers.flatMap(pid => treePids(ps, pid))).size };
}

export const BASE_URL = "http://localhost:5180";
/** How long a probe waits for an answer: the 30 s timeout every 5180 health check uses. The health_ms target is 3 s inside it. */
export const ANSWER_TIMEOUT_MS = 30_000;
/** The health_ms target: 5180 /health answers within 3 s (the duty brief, 10-15). A warm /configure answered in 58 ms on 10-15 09:20Z. */
export const HEALTH_TARGET_MS = 3000;
/** Above this, /configure is flagged as slow in the run detail (10-13 measure: 1155 ms for a warm page under load 257 to 357). */
export const CONFIGURE_SLOW_MS = 3000;
/** Above this, the dev tree is flagged in the run detail: 2.9 GB warm size after a restart (p79, p85); dev-guard kills it over 4096 MB. */
export const MEMORY_FLAG_MB = 3000;
/** A fixed world id (`<scenario>.<12 hex>`, lib/demo-env/world.ts), so the probe reuses one demo world instead of seeding a new one each run. */
export const PROBE_WORLD = "kbeauty-brand.000000000000";
export const PM2_NAME = "virev-demo";
/** Where the duty job saves the offline walk's Playwright JSON report, relative to the repo. */
export const WALK_FILE = ".cache/duties/virev-demo-offline.json";
/** Where the duty's walk command sends its stderr, relative to the repo, so a command that never starts the walk leaves its reason here. */
export const WALK_ERR_FILE = ".cache/duties/virev-demo-offline.err";
/**
 * A stderr line that means the walk command itself broke and the walk never ran. From 10-18 to 10-19 a plain `ssh mac` PATH lacked node, so
 * playwright's shebang gave `env: node: No such file or directory` (exit 127) on 17 runs in a row, which showed only as walk_stale.
 */
const WALK_COMMAND_BROKE = /No such file or directory|command not found|Cannot find module|ERR_MODULE_NOT_FOUND/;
/** The duty runs the offline walk once a day, so a report older than a day is stale. */
export const WALK_STALE_MS = 24 * 3_600_000;
/** The window for restarts and SSR timeouts: the duty runs daily (c66), so each run counts the whole day. */
const DAY_MS = 24 * 3_600_000;
/** Log lines of one kind closer than this are one event: a crash loop restarts every 1 to 2 s, and one hung request logs for up to a minute. */
export const EVENT_GAP_MS = 120_000;
/** The file changes the out log shows in this window before a hang go into its flagged line, to tell an edit burst from memory pressure. */
const EDITS_WINDOW_MS = 180_000;

export type Exec = (file: string, args: readonly string[], env?: Record<string, string>) => Promise<string>;
export interface SandboxDeps {
  fetch: typeof fetch;
  exec: Exec;
  now: () => number;
  /** A file's text, or a thrown error when it cannot be read. */
  read: (path: string) => Promise<string>;
  /** A file's modification time in ms, or a thrown error when it cannot be read. */
  mtime: (path: string) => Promise<number>;
  repo: string;
  /** The OS of the host whose pm2 and processes this run measures, which picks how dev_tree_mb is read (treeMb). */
  platform: NodeJS.Platform;
  /** `zone` is the IANA time zone of the pm2 daemon that writes the logs (pm2Zone), which may differ from this process's TZ. */
  pm2: { bin: string; home: string; zone: string };
}
interface Pm2Process { name?: string; pid?: number; pm2_env?: { status?: string } }

/** Whether `url` answered and how long it took; a timeout or a network error is status 0. */
export async function probe(deps: Pick<SandboxDeps, "fetch" | "now">, url: string): Promise<{ status: number; ms: number; error?: string }> {
  const start = deps.now();
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    await response.arrayBuffer();
    return { status: response.status, ms: deps.now() - start };
  } catch (error) {
    return { status: 0, ms: deps.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}

const isZone = (zone: string): boolean => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } };

/**
 * The time zone pm2 writes its log times in: the pm2 daemon's own TZ (from /proc on Linux), else the zone of the host's /etc/localtime, else UTC.
 * Never this process's TZ: the chat service on us-metal02 runs with TZ=Asia/Seoul while the box and its pm2 run in UTC, so on 10-18 the d1 run
 * read the 02:17:26 UTC restart as 17:17:26Z the day before.
 */
export async function pm2Zone(home: string, read: (path: string) => Promise<string> = path => readFile(path, "utf8"), link: (path: string) => Promise<string> = readlink): Promise<string> {
  try {
    const pid = (await read(join(home, "pm2.pid"))).trim();
    const tz = (await read(`/proc/${pid}/environ`)).split("\0").find(entry => entry.startsWith("TZ="))?.slice(3).replace(/^:/, "");
    if (tz && isZone(tz)) return tz;
  } catch { /* no /proc (macOS) or no pm2.pid: the daemon runs in the host's zone */ }
  try {
    const zone = /zoneinfo\/(.+)$/.exec(await link("/etc/localtime"))?.[1];
    if (zone && isZone(zone)) return zone;
  } catch { /* no /etc/localtime */ }
  return "UTC";
}

/** How far `zone` is ahead of UTC at the instant `at`, in ms. */
function zoneOffset(at: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
}

/** The wall time pm2 writes at the start of each log line (`2026-10-12T22:38:26: ...`) in the writer's `zone`, or null. */
export function logTime(line: string, zone: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): /.exec(line);
  if (!match) return null;
  const wall = Date.parse(`${match[1]}Z`);
  const guess = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(guess, zone);
}

/** The timed lines of a pm2 log within the last 24 h that pass `keep`. */
function recentLines(text: string, now: number, zone: string, keep: (line: string) => boolean): { at: number; line: string }[] {
  const lines: { at: number; line: string }[] = [];
  for (const line of text.split("\n")) {
    if (!keep(line)) continue;
    const at = logTime(line, zone);
    if (at === null || at > now || now - at > DAY_MS) continue;
    lines.push({ at, line });
  }
  return lines;
}

/** Groups times (ascending) into events whose members are less than EVENT_GAP_MS apart. */
function group<T extends { at: number }>(items: T[]): T[][] {
  const events: T[][] = [];
  for (const item of items) {
    const last = events.at(-1);
    if (last && item.at - last.at(-1)!.at < EVENT_GAP_MS) last.push(item);
    else events.push([item]);
  }
  return events;
}

export interface TimeoutEvent { first: number; last: number; lines: number; sample: string }
/** SSR "transport invoke timed out" events over the last 24 h in the pm2 error log, oldest first. */
export function ssrTimeouts(errorLog: string, now: number, zone: string): TimeoutEvent[] {
  return group(recentLines(errorLog, now, zone, line => line.includes("transport invoke timed out")))
    .map(lines => ({ first: lines[0]!.at, last: lines.at(-1)!.at, lines: lines.length, sample: lines.at(-1)!.line.slice(0, 300) }));
}

/** dev-guard memory kill lines over the last 24 h in the pm2 error log. */
export function guardKills(errorLog: string, now: number, zone: string): string[] {
  return recentLines(errorLog, now, zone, line => line.includes(`[dev-guard] ${PM2_NAME}: dev tree memory`)).map(entry => entry.line);
}

/** File changes vite logged in the out log in the EDITS_WINDOW_MS before `at`. */
export function editsBefore(outLog: string, at: number, zone: string): number {
  let count = 0;
  for (const line of outLog.split("\n")) {
    if (!/\] \((?:ssr|client)\) (?:page reload|hmr update) /.test(line)) continue;
    const time = logTime(line, zone);
    if (time !== null && time <= at && at - time <= EDITS_WINDOW_MS) count++;
  }
  return count;
}

export type ExitKind = "guard" | "command" | "config" | "crash";
export interface Exit { at: number; code: number; kind: ExitKind }
export interface RestartEvent { at: number; exits: Exit[]; kinds: ExitKind[] }
/**
 * The dev server's exits over the last 24 h from pm2.log (`App [virev-demo:4] exited with code [97] via signal [SIGINT]`; pm2 starts it again
 * after each). Code 97 is a dev-guard memory kill (scripts/dev/dev-guard.mjs); a `Stopping app:virev-demo` up to 15 s before is a pm2 restart by
 * hand; a code 0 exit with vite's `config changed, exiting so pm2 starts a fresh dev server` in the out log up to 5 s before is a config edit
 * (outLog undefined: unknown, so it counts); anything else is a crash. Restarts are the unplanned exits (guard and crash) grouped into events,
 * so the crash loop of 10-15 04:26 KST (about 30 exits with code 2 in 40 s, materialize refusing hand edits) counts once. Hand restarts and
 * config edits are planned and come back in `planned`.
 */
export function restarts(pm2Log: string, outLog: string | undefined, now: number, zone: string): { events: RestartEvent[]; config: Exit[]; planned: Exit[] } {
  const stops = recentLines(pm2Log, now, zone, line => line.includes(`Stopping app:${PM2_NAME} `)).map(entry => entry.at);
  const configs = outLog === undefined ? [] : recentLines(outLog, now, zone, line => line.includes("config changed, exiting so pm2 starts a fresh dev server")).map(entry => entry.at);
  const exits: Exit[] = recentLines(pm2Log, now, zone, line => line.includes(`App [${PM2_NAME}:`) && line.includes("] exited with code [")).map(({ at, line }) => {
    const code = Number(/exited with code \[(-?\d+)\]/.exec(line)?.[1] ?? NaN);
    const kind: ExitKind = code === 97 ? "guard"
      : stops.some(stop => stop <= at && at - stop <= 15_000) ? "command"
      : code === 0 && configs.some(config => config <= at && at - config <= 5_000) ? "config"
      : "crash";
    return { at, code, kind };
  });
  const events = group(exits.filter(exit => exit.kind === "crash" || exit.kind === "guard"))
    .map(members => ({ at: members[0]!.at, exits: members, kinds: [...new Set(members.map(exit => exit.kind))] }));
  return { events, config: exits.filter(exit => exit.kind === "config"), planned: exits.filter(exit => exit.kind === "command") };
}

interface WalkResult { status?: string; errors?: { message?: string }[]; error?: { message?: string } }
interface WalkSpec { title?: string; file?: string; tests?: { results?: WalkResult[] }[] }
interface WalkSuite { file?: string; specs?: WalkSpec[]; suites?: WalkSuite[] }
export interface WalkReport { stats?: { startTime?: string }; suites?: WalkSuite[] }

/**
 * The offline walk's outcome from Playwright's JSON report: when it started, each outside request it saw (the spec's `<page> -> <url>`
 * entries in the failed `expect(seen.outside)`), and the tests that failed for another reason, whose outside count is unknown.
 */
export function readWalk(report: WalkReport): { at: number; tests: number; outside: string[]; otherFailures: string[] } {
  const specs: WalkSpec[] = [];
  const collect = (suite: WalkSuite) => { for (const spec of suite.specs ?? []) if ((spec.file ?? suite.file ?? "").endsWith("offline.spec.ts")) specs.push(spec); suite.suites?.forEach(collect); };
  report.suites?.forEach(collect);
  const outside = new Set<string>();
  const otherFailures: string[] = [];
  for (const spec of specs) {
    const last = spec.tests?.flatMap(test => test.results ?? []).at(-1);
    if (!last || last.status === "passed" || last.status === "skipped") continue;
    const text = [...(last.errors ?? []), ...(last.error ? [last.error] : [])].map(error => error.message ?? "").join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    const found = [...text.matchAll(/"([^"\n]* -> (?:https?|wss?):\/\/[^"\n]*)"/g)].map(match => match[1]!);
    if (found.length) found.forEach(entry => outside.add(entry));
    else otherFailures.push(`${spec.title ?? "a test"}: ${last.status}: ${text.split("\n").find(line => line.trim()) ?? "no error text"}`);
  }
  const at = report.stats?.startTime ? Date.parse(report.stats.startTime) : NaN;
  return { at, tests: specs.length, outside: [...outside], otherFailures };
}

const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "Z";

/** The first WALK_COMMAND_BROKE line of WALK_ERR_FILE when that file is newer than WALK_FILE (or WALK_FILE is missing), else null. */
export async function walkCommandBroke(deps: Pick<SandboxDeps, "read" | "mtime" | "repo">): Promise<{ at: number; line: string } | null> {
  const errPath = join(deps.repo, WALK_ERR_FILE);
  const [text, errAt, walkAt] = await Promise.all([deps.read(errPath).catch(() => ""), deps.mtime(errPath).catch(() => NaN), deps.mtime(join(deps.repo, WALK_FILE)).catch(() => 0)]);
  const line = text.split("\n").find(entry => WALK_COMMAND_BROKE.test(entry))?.trim();
  return line && errAt > walkAt ? { at: errAt, line } : null;
}

export async function measureSandbox(deps: SandboxDeps): Promise<PrecheckOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  const lastEventAt: Record<string, number> = {};
  const metrics = { walk_problems: 0, health_ms: 0, restarts_24h: 0, ssr_timeouts_24h: 0,
    configure_ms: 0, dev_tree_mb: 0, headless_chrome: 0, guard_restarts_24h: 0, config_restarts_24h: 0, planned_restarts_24h: 0, outside_requests: 0, source_errors: 0 };
  const sourceError = (kind: string, excerpt: string) => { metrics.source_errors++; flagged.push({ at, kind, excerpt }); };
  const readOrError = async (path: string): Promise<string | Error> => { try { return await deps.read(path); } catch (error) { return error instanceof Error ? error : new Error(String(error)); } };

  // health_ms (judged) and configure_ms (detail).
  const configureUrl = `${BASE_URL}/configure?world=${PROBE_WORLD}`;
  const [health, configure] = await Promise.all([probe(deps, `${BASE_URL}/health`), probe(deps, configureUrl)]);
  metrics.health_ms = health.status === 200 ? health.ms : ANSWER_TIMEOUT_MS;
  metrics.configure_ms = configure.status === 200 ? configure.ms : ANSWER_TIMEOUT_MS;
  if (health.status !== 200) flagged.push({ at, kind: "down", excerpt: `GET ${BASE_URL}/health gave ${health.error ?? `HTTP ${health.status}`} after ${health.ms} ms` });
  else flagged.push({ at, kind: health.ms > HEALTH_TARGET_MS ? "slow" : "answer", excerpt: `GET ${BASE_URL}/health gave 200 in ${health.ms} ms` });
  if (configure.status !== 200) flagged.push({ at, kind: "down", excerpt: `GET ${configureUrl} gave ${configure.error ?? `HTTP ${configure.status}`} after ${configure.ms} ms` });
  else flagged.push({ at, kind: configure.ms > CONFIGURE_SLOW_MS ? "slow" : "answer", excerpt: `GET ${configureUrl} gave 200 in ${configure.ms} ms` });

  // ssr_timeouts_24h (judged) and guard_restarts_24h (detail) from the error log; restarts_24h (judged) from pm2.log and the out log.
  const logs = join(deps.pm2.home, "logs");
  const [errorLog, outLog, pm2Log] = await Promise.all([readOrError(join(logs, `${PM2_NAME}-error.log`)), readOrError(join(logs, `${PM2_NAME}-out.log`)), readOrError(join(deps.pm2.home, "pm2.log"))]);
  if (outLog instanceof Error) sourceError("source", `${PM2_NAME}-out.log: ${outLog.message}; config restarts count as restarts and hangs show no edit count`);
  if (errorLog instanceof Error) {
    metrics.ssr_timeouts_24h = 1;
    sourceError("source", `${PM2_NAME}-error.log: ${errorLog.message}; ssr_timeouts_24h reads 1 because an unread log cannot show a clean day`);
  } else {
    const events = ssrTimeouts(errorLog, at, deps.pm2.zone);
    metrics.ssr_timeouts_24h = events.length;
    if (events.length) lastEventAt.ssr_timeouts_24h = Math.max(...events.map(event => event.last));
    for (const event of events) {
      const edits = typeof outLog === "string" ? `, ${editsBefore(outLog, event.first, deps.pm2.zone)} file changes in the 3 min before` : "";
      flagged.push({ at, kind: "ssr_timeout", excerpt: `${event.lines} timeout lines ${iso(event.first)} to ${iso(event.last)}${edits}; last: ${event.sample}` });
    }
    const kills = guardKills(errorLog, at, deps.pm2.zone);
    metrics.guard_restarts_24h = kills.length;
    for (const kill of kills) flagged.push({ at, kind: "guard_restart", excerpt: kill });
  }
  if (pm2Log instanceof Error) {
    metrics.restarts_24h = 1;
    sourceError("source", `pm2.log: ${pm2Log.message}; restarts_24h reads 1 because an unread log cannot show a clean day`);
  } else {
    const { events, config, planned } = restarts(pm2Log, typeof outLog === "string" ? outLog : undefined, at, deps.pm2.zone);
    metrics.restarts_24h = events.length;
    if (events.length) lastEventAt.restarts_24h = Math.max(...events.map(event => event.at));
    metrics.config_restarts_24h = config.length;
    metrics.planned_restarts_24h = planned.length;
    for (const event of events) {
      const codes = [...new Set(event.exits.map(exit => exit.code))].join(", ");
      flagged.push({ at, kind: "restart", excerpt: `${iso(event.at)}: ${event.kinds.join(" and ")}, ${event.exits.length} exit${event.exits.length === 1 ? "" : "s"} (code ${codes})` });
    }
    if (config.length) flagged.push({ at, kind: "config_restart", excerpt: `${config.length} restarts asked for by vite config edits (not counted): ${config.map(exit => iso(exit.at)).join(", ")}` });
    if (planned.length) flagged.push({ at, kind: "planned_restart", excerpt: `${planned.length} deliberate pm2 restarts or stops (not counted): ${planned.map(exit => iso(exit.at)).join(", ")}` });
  }

  // dev_tree_mb (detail).
  try {
    const text = await deps.exec(deps.pm2.bin, ["jlist"], { PM2_HOME: deps.pm2.home });
    const proc = (JSON.parse(text.slice(text.indexOf("["))) as Pm2Process[]).find(candidate => candidate.name === PM2_NAME);
    if (!proc?.pid) sourceError("source", `pm2 has no live ${PM2_NAME} process (status ${proc?.pm2_env?.status ?? "missing"}), so its memory is unknown`);
    else {
      const pids = treePids(await deps.exec("ps", ["-axo", "pid=,ppid="]), proc.pid);
      metrics.dev_tree_mb = await treeMb(deps, pids);
      flagged.push({ at, kind: metrics.dev_tree_mb > MEMORY_FLAG_MB ? "memory" : "memory_ok", excerpt: `${PM2_NAME} dev tree (pids ${pids.join(", ")}) holds ${metrics.dev_tree_mb} MB` });
    }
  } catch (error) { sourceError("source", `pm2 or the ${deps.platform === "darwin" ? "footprint" : "smaps_rollup"} read (PM2_HOME ${deps.pm2.home}): ${error instanceof Error ? error.message : String(error)}`); }

  // headless_chrome (detail).
  try {
    const chrome = headlessChrome(await deps.exec("ps", ["-axo", "pid=,ppid=,args="]));
    metrics.headless_chrome = chrome.browsers;
    flagged.push({ at, kind: "headless_chrome", excerpt: `${chrome.browsers} headless Chrome browsers run on this host in ${chrome.processes} processes; shot scripts run theirs on us-metal02 through apps/virev-demo/scripts/shot-browser.mjs` });
  } catch (error) { sourceError("source", `ps for headless Chrome: ${error instanceof Error ? error.message : String(error)}`); }

  // walk_problems (the headline) and outside_requests (detail).
  const walkText = await readOrError(join(deps.repo, WALK_FILE));
  try {
    if (walkText instanceof Error) throw walkText;
    const walk = readWalk(JSON.parse(walkText) as WalkReport);
    metrics.outside_requests = walk.outside.length;
    metrics.walk_problems = walk.outside.length + walk.otherFailures.length;
    for (const entry of walk.outside) flagged.push({ at, kind: "outside_request", excerpt: entry });
    for (const failure of walk.otherFailures) flagged.push({ at, kind: "walk_failed", excerpt: `offline walk failed before its outside check: ${failure}` });
    if (!walk.tests) { metrics.walk_problems++; flagged.push({ at, kind: "walk_missing", excerpt: `${WALK_FILE} has no offline.spec.ts result` }); }
    else if (!Number.isFinite(walk.at) || at - walk.at > WALK_STALE_MS) {
      metrics.walk_problems++;
      flagged.push({ at, kind: "walk_stale", excerpt: `the last offline walk in ${WALK_FILE} started ${Number.isFinite(walk.at) ? iso(walk.at) : "at an unknown time"}, over 24 h ago` });
    } else flagged.push({ at, kind: "walk", excerpt: `offline walk started ${iso(walk.at)}: ${walk.tests} tests, ${walk.outside.length} outside requests, ${walk.otherFailures.length} other failures` });
  } catch (error) {
    metrics.walk_problems++;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    flagged.push({ at, kind: "walk_missing", excerpt: missing ? `no offline walk result yet at ${WALK_FILE}` : `${WALK_FILE}: ${error instanceof Error ? error.message : String(error)}` });
  }
  const broke = await walkCommandBroke(deps);
  if (broke) flagged.push({ at, kind: "walk_command", excerpt: `the walk command failed at ${iso(broke.at)}, after the last walk report, so the walk never ran: ${broke.line} (${WALK_ERR_FILE})` });

  return { metrics, flagged, lastEventAt };
}

const exec: Exec = (file, args, env) => new Promise((resolve, reject) => {
  // No timeout or buffer size of its own: the runner's precheck hard stop (precheckHardStopMs) ends a hung run, and the outputs measured 2026-10-12 (pm2 jlist 40 KB,
  // ps 13 KB) fit Node's default buffer.
  execFile(file, [...args], { encoding: "utf8", env: { ...process.env, ...env } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("demo-sandbox: OUTPUT_FILE is not set\n"); process.exit(2); }
  const home = join(REPO, ".cache/pm2-dev");
  const result = await measureSandbox({ fetch, exec, now: Date.now, read: path => readFile(path, "utf8"), mtime: async path => (await stat(path)).mtimeMs, repo: REPO, platform: process.platform,
    pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home, zone: await pm2Zone(home) } });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
