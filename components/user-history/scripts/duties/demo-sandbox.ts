import { execFile } from "node:child_process";
import { readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Demo sandbox works duty's precheck (`node --import tsx scripts/duties/demo-sandbox.ts`) for the frontend chat: the 5180 demo
 * (apps/virev-demo in auto-sns-agent). No model call, no browser. Its judged metrics (owner c75, 10-15: one headline plus at most 3):
 * - walk_problems, the headline: problems in the last offline walk of the 6 apps (tests/e2e/offline.spec.ts walks search, discover,
 *   analytics, campaigns, inbox and connections in two scenarios, plus the marketing pages). Each outside request counts 1, each test that
 *   failed for another reason counts 1, and a missing walk or one over a day old counts 1. The owner: "no external connection should work
 *   off of internal fake database". The walk is a browser check, so the duty job runs it behind the load gate and writes Playwright's JSON
 *   report to WALK_FILE; this script only reads that report.
 * - health_ms: how long 5180 /health took to answer 200, at most 3 s. No answer or a non-200 reads as the full 30 s wait.
 * - restarts_24h: times the dev server went down and restarted in 24 h (crashes, dev-guard memory kills, pm2 restarts by hand), from
 *   pm2.log. A crash loop counts once. A restart that a vite config edit asks for ("config changed, exiting so pm2 starts a fresh dev
 *   server") is development, so it is run detail.
 * - ssr_timeouts_24h: times in 24 h a page hung on "transport invoke timed out", from the pm2 error log. Error lines less than
 *   EVENT_GAP_MS apart are one event, since one hung request logs 3 to 20 lines.
 *   walk_problems also counts box drift: the walk runs on us-metal02's 5180, so its tree has to match the owner's Mac tree (readBoxSync).
 * Run detail, written to the output but not judged: configure_ms, dev_tree_mb, guard_restarts_24h, config_restarts_24h,
 * outside_requests, box_drift and source_errors. A source this check cannot read adds 1 to the metric it feeds, because an unread source cannot
 * show a clean day, plus 1 to source_errors and a flagged slice.
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
  repo: string;
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
 * (outLog undefined: unknown, so it counts); anything else is a crash. Restarts are the non-config exits grouped into events, so the crash loop
 * of 10-15 04:26 KST (about 30 exits with code 2 in 40 s, materialize refusing hand edits) counts once.
 */
export function restarts(pm2Log: string, outLog: string | undefined, now: number, zone: string): { events: RestartEvent[]; config: Exit[] } {
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
  const events = group(exits.filter(exit => exit.kind !== "config"))
    .map(members => ({ at: members[0]!.at, exits: members, kinds: [...new Set(members.map(exit => exit.kind))] }));
  return { events, config: exits.filter(exit => exit.kind === "config") };
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

export async function measureSandbox(deps: SandboxDeps): Promise<PrecheckOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  const metrics = { walk_problems: 0, health_ms: 0, restarts_24h: 0, ssr_timeouts_24h: 0,
    configure_ms: 0, dev_tree_mb: 0, guard_restarts_24h: 0, config_restarts_24h: 0, outside_requests: 0, box_drift: 0, source_errors: 0 };
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
    const { events, config } = restarts(pm2Log, typeof outLog === "string" ? outLog : undefined, at, deps.pm2.zone);
    metrics.restarts_24h = events.length;
    metrics.config_restarts_24h = config.length;
    for (const event of events) {
      const codes = [...new Set(event.exits.map(exit => exit.code))].join(", ");
      flagged.push({ at, kind: "restart", excerpt: `${iso(event.at)}: ${event.kinds.join(" and ")}, ${event.exits.length} exit${event.exits.length === 1 ? "" : "s"} (code ${codes})` });
    }
    if (config.length) flagged.push({ at, kind: "config_restart", excerpt: `${config.length} restarts asked for by vite config edits (not counted): ${config.map(exit => iso(exit.at)).join(", ")}` });
  }

  // dev_tree_mb (detail).
  try {
    const text = await deps.exec(deps.pm2.bin, ["jlist"], { PM2_HOME: deps.pm2.home });
    const proc = (JSON.parse(text.slice(text.indexOf("["))) as Pm2Process[]).find(candidate => candidate.name === PM2_NAME);
    if (!proc?.pid) sourceError("source", `pm2 has no live ${PM2_NAME} process (status ${proc?.pm2_env?.status ?? "missing"}), so its memory is unknown`);
    else {
      const pids = treePids(await deps.exec("ps", ["-axo", "pid=,ppid="]), proc.pid);
      metrics.dev_tree_mb = footprintMb(await deps.exec("footprint", ["--noCategories", "-f", "bytes", ...pids.flatMap(pid => ["-p", String(pid)])]));
      flagged.push({ at, kind: metrics.dev_tree_mb > MEMORY_FLAG_MB ? "memory" : "memory_ok", excerpt: `${PM2_NAME} dev tree (pids ${pids.join(", ")}) holds ${metrics.dev_tree_mb} MB` });
    }
  } catch (error) { sourceError("source", `pm2 or footprint (PM2_HOME ${deps.pm2.home}): ${error instanceof Error ? error.message : String(error)}`); }

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

  // Box drift from the owner's Mac tree adds to walk_problems; box_drift is detail.
  const sync = readBoxSync(await readOrError(join(deps.repo, SYNC_FILE)), at);
  metrics.walk_problems += sync.problems;
  metrics.box_drift = sync.drift;
  flagged.push({ at, kind: sync.kind, excerpt: sync.excerpt });
  return { metrics, flagged };
}

/** Where the owner's Mac demo sync watcher (~/.local/share/virev-demo-sync on the Mac) writes its drift check, relative to the repo. */
export const SYNC_FILE = ".cache/duties/virev-demo-sync.json";
/** The watcher checks every 5 min, so a status older than 30 min means it stopped or the Mac is offline. */
export const SYNC_STALE_MS = 30 * 60_000;
const SYNC_FIX = "on the Mac (ssh mac): launchctl print gui/501/ai.virev.demo-box-sync, ~/.local/share/virev-demo-sync/sync.log and the README.md there";
export interface SyncStatus { ok?: boolean; checked_at?: string; drift?: number | null; consecutive_drift_runs?: number; alert?: boolean; drift_files?: string[]; error?: string }

/**
 * Whether this box's demo tree matches the owner's Mac tree, from the Mac sync watcher's status file. The walk runs on this box's 5180, so a
 * drifted tree walks code the owner never sees. Drift that stayed above 0 for two checks in a row counts its files (a failed check counts 1),
 * and a missing, unreadable or stale status counts 1. One check with drift does not count, since the watcher heals it before the next.
 */
export function readBoxSync(text: string | Error, now: number): { problems: number; drift: number; kind: string; excerpt: string } {
  if (text instanceof Error) return { problems: 1, drift: 0, kind: "box_sync_missing", excerpt: `${SYNC_FILE}: ${text.message}; check ${SYNC_FIX}` };
  let status: SyncStatus;
  try { status = JSON.parse(text) as SyncStatus; }
  catch (error) { return { problems: 1, drift: 0, kind: "box_sync_missing", excerpt: `${SYNC_FILE} is not JSON (${error instanceof Error ? error.message : String(error)}); check ${SYNC_FIX}` }; }
  const checked = Date.parse(status.checked_at ?? "");
  const drift = status.drift ?? 0;
  if (!Number.isFinite(checked) || now - checked > SYNC_STALE_MS) {
    return { problems: 1, drift, kind: "box_sync_stale", excerpt: `the Mac sync watcher last checked ${Number.isFinite(checked) ? iso(checked) : "at an unknown time"}, over 30 min ago; check ${SYNC_FIX}` };
  }
  if (status.alert) {
    const what = status.ok === false ? `the check failed: ${status.error ?? "no error text"}` : `${drift} files: ${(status.drift_files ?? []).slice(0, 5).join(", ")}`;
    return { problems: Math.max(1, drift), drift, kind: "box_drift", excerpt: `the box demo tree differs from the Mac for ${status.consecutive_drift_runs ?? 2} checks in a row (${what}); check ${SYNC_FIX}` };
  }
  return { problems: 0, drift, kind: "box_sync", excerpt: `the box demo tree matches the Mac (drift ${drift} at ${iso(checked)})` };
}

const exec: Exec = (file, args, env) => new Promise((resolve, reject) => {
  // No timeout or buffer size of its own: the runner's precheck timeout ends a hung run, and the outputs measured 2026-10-12 (pm2 jlist 40 KB,
  // ps 13 KB) fit Node's default buffer.
  execFile(file, [...args], { encoding: "utf8", env: { ...process.env, ...env } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("demo-sandbox: OUTPUT_FILE is not set\n"); process.exit(2); }
  const home = join(REPO, ".cache/pm2-dev");
  const result = await measureSandbox({ fetch, exec, now: Date.now, read: path => readFile(path, "utf8"), repo: REPO,
    pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home, zone: await pm2Zone(home) } });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
