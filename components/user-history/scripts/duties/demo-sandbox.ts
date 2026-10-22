import { execFile, spawn } from "node:child_process";
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
 *   off of internal fake database". This script reads the walk's Playwright JSON report from WALK_FILE and its stderr from WALK_ERR_FILE,
 *   and starts the next walk itself, detached (WALK_COMMAND), when the last one started over WALK_REFRESH_MS ago and none is running, so the
 *   next run reads a fresh walk. Until 10-22 only a missed run's duty job ran the walk, so a run on target never refreshed it: the 21:25Z run on
 *   10-21 read a 19.6 h old walk and started nothing, and the push run at 02:56Z on 10-22 found it 25 h old and went red with no page at fault.
 * - slowest_page_ms: the slowest app page in the last offline walk, timed in the page itself (offline.spec.ts writes one `page-timing`
 *   annotation per page and scenario, with each of its 3 tries). A page's time is the slower of its fastest in-app switch (the click to the
 *   first frame whose <main> shows new text) and the lowest long-task time of its full loads (pageMs). The walk's browser runs on us-metal02, so
 *   load on that box only adds time to a try: on 10-20, at load 242 on 80 cores, one try read 12.7 s of long tasks for a page that loads in
 *   under 2 s. The fastest try is the page's own cost, and the box_load slice names the box's load during the walk. The load's own wall time is
 *   left out, since every module of a cold load crosses the 195 ms link to the Mac. It replaced health_ms on 10-19, because /health answered in 25 ms while the owner
 *   found switching "infuriatingly slow" (10-09) and Creators slow to load (10-19, 2.3 s of long tasks before 7966ebbfd). A down server fails the
 *   walk, so walk_problems covers it. A page that never showed or a scenario test with no timings reads as PAGE_TIMEOUT_MS. A missing or stale
 *   walk gives no reading: slowest_page_ms is left out, so the duty shows it as not measured, and a `gap` slice names the walk's state.
 * - restarts_24h: times in 24 h the dev server went down without anyone asking for it (crashes and other exit codes, dev-guard memory
 *   kills), from pm2.log, so it measures whether the sandbox stays up. A crash loop counts once. A deliberate `pm2 restart` or `pm2 stop`
 *   by an agent or a person, and a restart that a vite config edit asks for ("config changed, exiting so pm2 starts a fresh dev server"),
 *   are planned, so they are run detail (owner via frontend bro, 10-19: count only unplanned exits).
 * - ssr_timeouts_24h: times in 24 h a page hung on "transport invoke timed out", from the pm2 error log. Error lines less than
 *   EVENT_GAP_MS apart are one event, since one hung request logs 3 to 20 lines.
 * Run detail, written to the output but not judged: configure_ms, dev_tree_mb, demo_worlds and heap_used_mb (from /__demo/health), headless_chrome, guard_restarts_24h, config_restarts_24h,
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
/** How long a probe waits for an answer: the 30 s timeout every 5180 health check uses. */
export const ANSWER_TIMEOUT_MS = 30_000;
/** What a page that never showed reads as: offline.spec.ts gives up on a page after SHOW_TIMEOUT_MS, the same 30 s. */
export const PAGE_TIMEOUT_MS = 30_000;
/** Above this, /configure is flagged as slow in the run detail (10-13 measure: 1155 ms for a warm page under load 257 to 357). */
export const CONFIGURE_SLOW_MS = 3000;
/** Above this, the dev tree is flagged in the run detail: 2.9 GB warm size after a restart (p79, p85); dev-guard kills it over 4096 MB. */
export const MEMORY_FLAG_MB = 3000;
/** A fixed world id (`<scenario>.<12 hex>`, lib/demo-env/world.ts), so the probe reuses one demo world instead of seeding a new one each run. */
export const PROBE_WORLD = "kbeauty-brand.000000000000";
export const PM2_NAME = "virev-demo";
/** The dev server's own report: its live demo worlds and its memory in MB (auto-sns-agent 2033e09cf, 10-19). */
export const DEMO_HEALTH_URL = `${BASE_URL}/__demo/health`;
interface DemoHealth { worlds?: number; memory?: { rssMb?: number; heapUsedMb?: number; heapTotalMb?: number; externalMb?: number } }
/** Where the duty job saves the offline walk's Playwright JSON report, relative to the repo. */
export const WALK_FILE = ".cache/duties/virev-demo-offline.json";
/** Where the duty's walk command sends its stderr, relative to the repo, so a command that never starts the walk leaves its reason here. */
export const WALK_ERR_FILE = ".cache/duties/virev-demo-offline.err";
/**
 * A stderr line that means the walk command itself broke and the walk never ran. From 10-18 to 10-19 a plain `ssh mac` PATH lacked node, so
 * playwright's shebang gave `env: node: No such file or directory` (exit 127) on 17 runs in a row, which showed only as walk_stale. Since 10-19 the walk's
 * browser runs on us-metal02 through apps/virev-demo/scripts/shot-browser.mjs, whose own failures start with `shot-browser: `.
 */
const WALK_COMMAND_BROKE = /No such file or directory|command not found|Cannot find module|ERR_MODULE_NOT_FOUND|^shot-browser: /;
/**
 * The precheck starts a walk when the last one started longer ago than this. A daily run (06:25 KST) then always finds a walk that started at
 * most a day plus this long ago, since a run either starts one or found one under this age. 30 min keeps a burst of push runs (10-20: runs at
 * 10:48, 11:16 and 11:32Z) from walking more than once per half hour; one walk took 520 s on 10-22.
 */
export const WALK_REFRESH_MS = 30 * 60_000;
/**
 * A walk older than this is stale. The duty runs daily, and the walk a daily run starts is a day old at the next one, plus the scheduler's lag
 * (21:25:02Z and 21:25:27Z on 10-20 and 10-21) and up to WALK_REFRESH_MS when a run within that window had already started it. A 24 h limit
 * left the daily walk a coin flip at each run.
 */
export const WALK_STALE_MS = 25 * 3_600_000;
/** The offline walk as the precheck starts it, run with `sh -c` from apps/virev-demo; its browser runs on us-metal02 through shot-browser.mjs. */
export const WALK_COMMAND = `PLAYWRIGHT_JSON_OUTPUT_FILE=$PWD/../../${WALK_FILE} node scripts/shot-browser.mjs --run ../../node_modules/.bin/playwright test tests/e2e/offline.spec.ts --reporter=json 2> ../../${WALK_ERR_FILE}`;
/** The pids of running offline walks, from `ps -axo pid=,ppid=,args=`. */
export function runningWalks(ps: string): number[] {
  return ps.split("\n").map(line => /^\s*(\d+)\s+\d+\s+(.*)$/.exec(line)).filter(match => match !== null)
    .filter(match => match[2]!.includes("tests/e2e/offline.spec.ts")).map(match => Number(match[1]));
}
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
  /** Starts WALK_COMMAND detached, so it outlives this run, and returns its pid. */
  startWalk: () => number;
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

interface Annotation { type?: string; description?: string }
interface WalkResult { status?: string; errors?: { message?: string }[]; error?: { message?: string }; annotations?: Annotation[] }
interface WalkSpec { title?: string; file?: string; tests?: { results?: WalkResult[]; annotations?: Annotation[] }[] }
interface WalkSuite { file?: string; specs?: WalkSpec[]; suites?: WalkSuite[] }
export interface WalkReport { stats?: { startTime?: string }; suites?: WalkSuite[] }

/** One timed try of a switch or a load, in ms: `ms` until the page showed, null when it never showed within the spec's 30 s, and the long-task ms in that span. */
export interface PageTry { ms: number | null; long_ms: number }
/** One page of one scenario as offline.spec.ts times it: each try of its in-app switch and of its full load. */
export interface PageTiming { scenario: string; path: string; switches: PageTry[]; loads: PageTry[] }

/** The fastest of `tries` by `cost`, or PAGE_TIMEOUT_MS when no try showed the page. */
const fastest = (tries: readonly PageTry[], cost: (shown: PageTry & { ms: number }) => number): number =>
  Math.min(PAGE_TIMEOUT_MS, ...tries.filter((entry): entry is PageTry & { ms: number } => entry.ms !== null).map(cost));

/**
 * A page's time: the slower of its fastest switch and the lowest long-task time of its loads, since load on the walk's box only adds time to a
 * try. PAGE_TIMEOUT_MS when every switch or every load never showed.
 */
export function pageMs(timing: PageTiming): number {
  return Math.max(fastest(timing.switches, entry => entry.ms), fastest(timing.loads, entry => entry.long_ms));
}

/** One read of the 1-minute load and core count of the host that ran the walk's browser, or the error that read gave. */
export type BoxLoad = { scenario: string; pass: string; host: string; load1: number; cores: number } | { scenario: string; pass: string; host: string; error: string };

/** The box_load slice: the load range of the walk's browser host over the walk, so a slow page reads against how busy the box was. */
export function boxLoadLine(loads: readonly BoxLoad[]): string {
  const read = loads.filter((entry): entry is Extract<BoxLoad, { load1: number }> => "load1" in entry);
  const failed = loads.filter((entry): entry is Extract<BoxLoad, { error: string }> => "error" in entry);
  const reads = (count: number) => `${count} read${count === 1 ? "" : "s"}`;
  const errors = failed.length ? `; ${reads(failed.length)} failed: ${failed[0]!.error}` : "";
  if (!read.length) return `no load read of the walk's browser host in the walk report${errors}`;
  const values = read.map(entry => entry.load1);
  const range = Math.min(...values) === Math.max(...values) ? `${values[0]}` : `${Math.min(...values)} to ${Math.max(...values)}`;
  const hosts = [...new Set(read.map(entry => `${entry.host} (${entry.cores} cores)`))].join(", ");
  return `the walk's browser ran on ${hosts} at 1-min load ${range} over ${reads(read.length)}, one at the start of each timed pass${errors}`;
}

/**
 * The offline walk's outcome from Playwright's JSON report: when it started, each outside request it saw (the spec's `<page> -> <url>`
 * entries in the failed `expect(seen.outside)`), the tests that failed for another reason, whose outside count is unknown, every page
 * timing, and the scenario tests (titles with `: every browser and server request`) that left none.
 */
export function readWalk(report: WalkReport): { at: number; tests: number; outside: string[]; otherFailures: string[]; pages: PageTiming[]; untimed: string[]; boxLoads: BoxLoad[] } {
  const specs: WalkSpec[] = [];
  const collect = (suite: WalkSuite) => { for (const spec of suite.specs ?? []) if ((spec.file ?? suite.file ?? "").endsWith("offline.spec.ts")) specs.push(spec); suite.suites?.forEach(collect); };
  report.suites?.forEach(collect);
  const outside = new Set<string>();
  const otherFailures: string[] = [];
  const pages: PageTiming[] = [];
  const untimed: string[] = [];
  const boxLoads: BoxLoad[] = [];
  for (const spec of specs) {
    const last = spec.tests?.flatMap(test => test.results ?? []).at(-1);
    const notes = (last?.annotations ?? spec.tests?.at(-1)?.annotations ?? []).filter(note => note.description);
    // A page-timing from before the walk kept its tries (10-20) has no switches or loads, so it reads as a page that never showed.
    const timings = notes.filter(note => note.type === "page-timing").map(note => JSON.parse(note.description!) as Partial<PageTiming> & Pick<PageTiming, "scenario" | "path">)
      .map(timing => ({ scenario: timing.scenario, path: timing.path, switches: timing.switches ?? [], loads: timing.loads ?? [] }));
    pages.push(...timings);
    boxLoads.push(...notes.filter(note => note.type === "box-load").map(note => JSON.parse(note.description!) as BoxLoad));
    if (!timings.length && (spec.title ?? "").includes(": every browser and server request")) untimed.push(spec.title!);
    if (!last || last.status === "passed" || last.status === "skipped") continue;
    const text = [...(last.errors ?? []), ...(last.error ? [last.error] : [])].map(error => error.message ?? "").join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    const found = [...text.matchAll(/"([^"\n]* -> (?:https?|wss?):\/\/[^"\n]*)"/g)].map(match => match[1]!);
    if (found.length) found.forEach(entry => outside.add(entry));
    else otherFailures.push(`${spec.title ?? "a test"}: ${last.status}: ${text.split("\n").find(line => line.trim()) ?? "no error text"}`);
  }
  const at = report.stats?.startTime ? Date.parse(report.stats.startTime) : NaN;
  return { at, tests: specs.length, outside: [...outside], otherFailures, pages, untimed, boxLoads };
}

const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "Z";

/** A page's tries as the slowest_page slice shows them: `switch 1200/980/1010, load long tasks 850/12692/900`, a dash for a try that never showed. */
export function triesText(timing: PageTiming): string {
  const list = (tries: readonly PageTry[], cost: (entry: PageTry) => number) => tries.map(entry => entry.ms === null ? "-" : String(cost(entry))).join("/") || "none";
  return `switch ${list(timing.switches, entry => entry.ms!)}, load long tasks ${list(timing.loads, entry => entry.long_ms)}`;
}

/**
 * slowest_page_ms from one walk's timings: the slowest page over both scenarios, with its path and scenario, and each page's slowest time,
 * slowest first, with that scenario's tries. A scenario test that left no timings reads as PAGE_TIMEOUT_MS, since its pages may be the slow ones.
 */
export function slowestPage(pages: readonly PageTiming[], untimed: readonly string[]): { ms: number; name: string; perPage: { path: string; scenario: string; ms: number; tries: string }[] } {
  const worst = new Map<string, { path: string; scenario: string; ms: number; tries: string }>();
  for (const timing of pages) {
    const ms = pageMs(timing);
    if (ms > (worst.get(timing.path)?.ms ?? -1)) worst.set(timing.path, { path: timing.path, scenario: timing.scenario, ms, tries: triesText(timing) });
  }
  const perPage = [...worst.values()].sort((a, b) => b.ms - a.ms);
  if (untimed.length) return { ms: PAGE_TIMEOUT_MS, name: `no page timings from ${untimed.join("; ")}`, perPage };
  if (!perPage.length) return { ms: PAGE_TIMEOUT_MS, name: "no page timings in the walk", perPage };
  return { ms: perPage[0]!.ms, name: `${perPage[0]!.path} (${perPage[0]!.scenario})`, perPage };
}

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
  const metrics = { walk_problems: 0, restarts_24h: 0, ssr_timeouts_24h: 0,
    configure_ms: 0, dev_tree_mb: 0, demo_worlds: 0, heap_used_mb: 0, headless_chrome: 0, guard_restarts_24h: 0, config_restarts_24h: 0, planned_restarts_24h: 0, outside_requests: 0, source_errors: 0 };
  const sourceError = (kind: string, excerpt: string) => { metrics.source_errors++; flagged.push({ at, kind, excerpt }); };
  const readOrError = async (path: string): Promise<string | Error> => { try { return await deps.read(path); } catch (error) { return error instanceof Error ? error : new Error(String(error)); } };

  // configure_ms (detail).
  const configureUrl = `${BASE_URL}/configure?world=${PROBE_WORLD}`;
  const configure = await probe(deps, configureUrl);
  metrics.configure_ms = configure.status === 200 ? configure.ms : ANSWER_TIMEOUT_MS;
  if (configure.status !== 200) flagged.push({ at, kind: "down", excerpt: `GET ${configureUrl} gave ${configure.error ?? `HTTP ${configure.status}`} after ${configure.ms} ms` });
  else flagged.push({ at, kind: configure.ms > CONFIGURE_SLOW_MS ? "slow" : "answer", excerpt: `GET ${configureUrl} gave 200 in ${configure.ms} ms` });

  // demo_worlds and heap_used_mb (detail), so the dev server's growth shows before a restart.
  try {
    const response = await deps.fetch(DEMO_HEALTH_URL, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json() as DemoHealth;
    if (typeof health.worlds !== "number" || typeof health.memory?.heapUsedMb !== "number") throw new Error(`no worlds or memory.heapUsedMb in ${JSON.stringify(health).slice(0, 200)}`);
    metrics.demo_worlds = health.worlds;
    metrics.heap_used_mb = health.memory.heapUsedMb;
    flagged.push({ at, kind: "demo_memory", excerpt: `${DEMO_HEALTH_URL}: ${health.worlds} worlds, heap ${health.memory.heapUsedMb} of ${health.memory.heapTotalMb ?? "?"} MB, rss ${health.memory.rssMb ?? "?"} MB` });
  } catch (error) { sourceError("source", `${DEMO_HEALTH_URL}: ${error instanceof Error ? error.message : String(error)}`); }

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
  let psArgs: string | Error = new Error("ps did not run");
  try {
    psArgs = await deps.exec("ps", ["-axo", "pid=,ppid=,args="]);
    const chrome = headlessChrome(psArgs);
    metrics.headless_chrome = chrome.browsers;
    flagged.push({ at, kind: "headless_chrome", excerpt: `${chrome.browsers} headless Chrome browsers run on this host in ${chrome.processes} processes; shot scripts run theirs on us-metal02 through apps/virev-demo/scripts/shot-browser.mjs` });
  } catch (error) {
    if (error instanceof Error) psArgs = error;
    sourceError("source", `ps for headless Chrome: ${error instanceof Error ? error.message : String(error)}`);
  }

  // walk_problems (the headline) and outside_requests (detail).
  const walkText = await readOrError(join(deps.repo, WALK_FILE));
  let slowestPageMs: number | undefined;
  let walkAt = Number.NaN;
  const noReading = (state: string) => flagged.push({ at, kind: "gap", excerpt: `slowest_page_ms has no reading, since ${state}` });
  try {
    if (walkText instanceof Error) throw walkText;
    const walk = readWalk(JSON.parse(walkText) as WalkReport);
    walkAt = walk.at;
    metrics.outside_requests = walk.outside.length;
    metrics.walk_problems = walk.outside.length + walk.otherFailures.length;
    for (const entry of walk.outside) flagged.push({ at, kind: "outside_request", excerpt: entry });
    for (const failure of walk.otherFailures) flagged.push({ at, kind: "walk_failed", excerpt: `offline walk failed before its outside check: ${failure}` });
    if (!walk.tests) {
      metrics.walk_problems++;
      flagged.push({ at, kind: "walk_missing", excerpt: `${WALK_FILE} has no offline.spec.ts result` });
      noReading("the walk report has no offline.spec.ts result");
    } else if (!Number.isFinite(walk.at) || at - walk.at > WALK_STALE_MS) {
      metrics.walk_problems++;
      const started = `the last offline walk in ${WALK_FILE} started ${Number.isFinite(walk.at) ? iso(walk.at) : "at an unknown time"}, over ${WALK_STALE_MS / 3_600_000} h ago`;
      flagged.push({ at, kind: "walk_stale", excerpt: started });
      noReading(started);
    } else {
      flagged.push({ at, kind: "walk", excerpt: `offline walk started ${iso(walk.at)}: ${walk.tests} tests, ${walk.outside.length} outside requests, ${walk.otherFailures.length} other failures` });
      const slowest = slowestPage(walk.pages, walk.untimed);
      slowestPageMs = slowest.ms;
      flagged.push({ at, kind: "slowest_page", excerpt: `slowest app page ${slowest.name}: ${slowest.ms} ms, the fastest of its tries; every page: ${slowest.perPage.map(page => `${page.path} ${page.ms} (${page.tries})`).join("; ") || "none"}` });
      flagged.push({ at, kind: "box_load", excerpt: boxLoadLine(walk.boxLoads) });
    }
  } catch (error) {
    metrics.walk_problems++;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const excerpt = missing ? `no offline walk result yet at ${WALK_FILE}` : `${WALK_FILE}: ${error instanceof Error ? error.message : String(error)}`;
    flagged.push({ at, kind: "walk_missing", excerpt });
    noReading(excerpt);
  }

  // The next walk, started here and read by the next run.
  if (!(at - walkAt <= WALK_REFRESH_MS)) {
    if (psArgs instanceof Error) flagged.push({ at, kind: "walk_start", excerpt: `started no walk, since ps could not tell whether one runs: ${psArgs.message}` });
    else if (runningWalks(psArgs).length) flagged.push({ at, kind: "walk_start", excerpt: `an offline walk already runs (pids ${runningWalks(psArgs).join(", ")}), so this run started none` });
    else {
      try { flagged.push({ at, kind: "walk_start", excerpt: `started the next offline walk (pid ${deps.startWalk()}), detached, for the next run to read` }); }
      catch (error) { flagged.push({ at, kind: "walk_command", excerpt: `the walk could not start: ${error instanceof Error ? error.message : String(error)}` }); }
    }
  }
  const broke = await walkCommandBroke(deps);
  if (broke) flagged.push({ at, kind: "walk_command", excerpt: `the walk command failed at ${iso(broke.at)}, after the last walk report, so the walk never ran: ${broke.line} (${WALK_ERR_FILE})` });

  return { metrics: slowestPageMs === undefined ? metrics : { ...metrics, slowest_page_ms: slowestPageMs }, flagged, lastEventAt };
}

const exec: Exec = (file, args, env) => new Promise((resolve, reject) => {
  // No timeout or buffer size of its own: the runner's precheck hard stop (precheckHardStopMs) ends a hung run, and the outputs measured 2026-10-12 (pm2 jlist 40 KB,
  // ps 13 KB) fit Node's default buffer.
  execFile(file, [...args], { encoding: "utf8", env: { ...process.env, ...env } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Runs WALK_COMMAND in its own session with no stdio, so it outlives this run and the `ssh mac` that started it. PATH comes from the precheck's command. */
function startWalk(): number {
  const child = spawn("sh", ["-c", WALK_COMMAND], { cwd: join(REPO, "apps/virev-demo"), detached: true, stdio: "ignore" });
  child.once("error", error => process.stderr.write(`demo-sandbox: the walk did not start: ${error.message}\n`));
  child.unref();
  if (!child.pid) throw new Error(`sh -c did not start in ${join(REPO, "apps/virev-demo")}`);
  return child.pid;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("demo-sandbox: OUTPUT_FILE is not set\n"); process.exit(2); }
  const home = join(REPO, ".cache/pm2-dev");
  const result = await measureSandbox({ fetch, exec, now: Date.now, read: path => readFile(path, "utf8"), mtime: async path => (await stat(path)).mtimeMs, repo: REPO, platform: process.platform,
    pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home, zone: await pm2Zone(home) }, startWalk });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
