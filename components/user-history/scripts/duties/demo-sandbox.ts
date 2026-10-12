import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { footprintMb, treePids } from "./local-dev-uptime.ts";

/**
 * The Demo sandbox works duty's precheck (`node --import tsx scripts/duties/demo-sandbox.ts`) for the frontend chat: whether the 5180 demo
 * (apps/virev-demo in auto-sns-agent) answers, how long /configure takes, its dev tree memory, the dev-guard memory restarts and SSR
 * "transport invoke timed out" errors in its pm2 error log, and the outside requests in the last offline walk. No model call, no browser.
 * The offline walk (tests/e2e/offline.spec.ts) is a browser check, so the duty job runs it behind the load gate and writes Playwright's JSON
 * report to WALK_FILE; this script only reads that report. Pages with no `?line=` render the default line, Staging, so the walk covers Staging.
 * A source it cannot read adds 1 to source_errors and a flagged slice; its own metrics then read 0, and source_errors carries the miss.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const BASE_URL = "http://localhost:5180";
/**
 * How long a probe waits for an answer. Measured 2026-10-10 (sessions/2026/10/10/0344-demo-5180-speed/data/measurements.json, entry_chain_curl):
 * a warm /app page answered 200 in 1155 ms with the Mac at load average 257 to 357. Incident 2026-10-12 22:38 to 22:40 KST (duty proposals page,
 * section 5): /health, /__demo/health and /configure gave no answer in 60 s while vite listened. 10 s is the proposal's limit, about 8 times the
 * measured answer, so a slow but working server answers and a hung one reads as down. Without a limit a hung server would hold the precheck
 * until the runner kills it, and the run would record no metrics.
 */
export const ANSWER_TIMEOUT_MS = 10_000;
/** The configure_ms target, from the same measurement: 1155 ms for a warm page under load 257 to 357, and the owner's "switching between tabs/apps/views is infuriatingly slow". */
export const CONFIGURE_TARGET_MS = 3000;
/**
 * The dev_tree_mb target. Board steps p79 and p85 (frontend chat, 2026-10-12) measured 2.9 GB as the warm size after a restart and 3.0 GB
 * within 5 minutes; dev-guard restarts the tree over 4096 MB (memCapMb in scripts/dev/dev-apps.cjs). A reading over 3000 MB means the tree
 * grows past its warm size toward the guard's restart, which is what step p86 fixes.
 */
export const MEMORY_TARGET_MB = 3000;
/** A fixed world id (`<scenario>.<12 hex>`, lib/demo-env/world.ts), so the probe reuses one demo world instead of seeding a new one each run. */
export const PROBE_WORLD = "kbeauty-brand.000000000000";
export const PM2_NAME = "virev-demo";
/** Where the duty job saves the offline walk's Playwright JSON report, relative to the repo. */
export const WALK_FILE = ".cache/duties/virev-demo-offline.json";
/** The proposal runs the offline walk once a day, so a report older than a day is stale. */
export const WALK_STALE_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

export type Exec = (file: string, args: readonly string[], env?: Record<string, string>) => Promise<string>;
export interface SandboxDeps {
  fetch: typeof fetch;
  exec: Exec;
  now: () => number;
  /** A file's text, or a thrown error when it cannot be read. */
  read: (path: string) => Promise<string>;
  repo: string;
  pm2: { bin: string; home: string };
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

/** The local time pm2 writes at the start of each log line (`2026-10-12T22:38:26: ...`), or null. */
export function logTime(line: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): /.exec(line);
  return match ? new Date(match[1]!).getTime() : null;
}

/**
 * dev-guard memory restarts over the last 24 h and SSR transport timeouts over the last hour, from the pm2 error log. The windows are the
 * proposal's metrics guard_restarts_24h (target at most 1) and ssr_timeouts_1h (target 0). Incident: this log shows 7 dev-guard restarts
 * on 2026-10-12 (11:32 to 20:51 KST) and the SSR timeouts of the 22:38 hang; step p86's goal is that the guard stops restarting 5180.
 */
export function countLog(text: string, now: number): { guardRestarts: string[]; ssrTimeouts: string[] } {
  const guardRestarts: string[] = [];
  const ssrTimeouts: string[] = [];
  for (const line of text.split("\n")) {
    const guard = line.includes(`[dev-guard] ${PM2_NAME}: dev tree memory`);
    const timeout = !guard && line.includes("transport invoke timed out");
    if (!guard && !timeout) continue;
    const at = logTime(line);
    if (at === null || at > now) continue;
    if (guard && now - at <= 24 * HOUR_MS) guardRestarts.push(line);
    if (timeout && now - at <= HOUR_MS) ssrTimeouts.push(line);
  }
  return { guardRestarts, ssrTimeouts };
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

export async function measureSandbox(deps: SandboxDeps): Promise<PrecheckOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  // Targets in demo-sandbox.duty.json and their sources: health_ok at least 1 and configure_ms at most CONFIGURE_TARGET_MS (see ANSWER_TIMEOUT_MS),
  // guard_restarts_24h at most 1 and ssr_timeouts_1h 0 (see countLog), dev_tree_mb at most MEMORY_TARGET_MB, outside_requests 0 (the owner:
  // "no external connection should work off of internal fake database"; offline.spec.ts fails on any), source_errors 0 (an unread source is a miss).
  const metrics: Record<string, number> = { health_ok: 0, configure_ms: 0, guard_restarts_24h: 0, ssr_timeouts_1h: 0, dev_tree_mb: 0, outside_requests: 0, source_errors: 0 };
  const sourceError = (kind: string, excerpt: string) => { metrics.source_errors = (metrics.source_errors ?? 0) + 1; flagged.push({ at, kind, excerpt }); };

  const configureUrl = `${BASE_URL}/configure?world=${PROBE_WORLD}`;
  const [health, configure] = await Promise.all([probe(deps, `${BASE_URL}/health`), probe(deps, configureUrl)]);
  metrics.health_ok = health.status === 200 ? 1 : 0;
  metrics.configure_ms = configure.ms;
  if (health.status !== 200) flagged.push({ at, kind: "down", excerpt: `GET ${BASE_URL}/health gave ${health.error ?? `HTTP ${health.status}`} after ${health.ms} ms` });
  if (configure.status !== 200) flagged.push({ at, kind: "down", excerpt: `GET ${configureUrl} gave ${configure.error ?? `HTTP ${configure.status}`} after ${configure.ms} ms` });
  else if (configure.ms > CONFIGURE_TARGET_MS) flagged.push({ at, kind: "slow", excerpt: `GET ${configureUrl} answered 200 in ${configure.ms} ms` });

  const logPath = join(deps.pm2.home, "logs", `${PM2_NAME}-error.log`);
  try {
    const { guardRestarts, ssrTimeouts } = countLog(await deps.read(logPath), at);
    metrics.guard_restarts_24h = guardRestarts.length;
    metrics.ssr_timeouts_1h = ssrTimeouts.length;
    if (guardRestarts.length) flagged.push({ at, kind: "guard_restarts", excerpt: `${guardRestarts.length} dev-guard restarts in 24 h, last: ${guardRestarts.at(-1)}` });
    if (ssrTimeouts.length) flagged.push({ at, kind: "ssr_timeouts", excerpt: `${ssrTimeouts.length} SSR timeout errors in 1 h, last: ${ssrTimeouts.at(-1)}` });
  } catch (error) { sourceError("source", `${logPath}: ${error instanceof Error ? error.message : String(error)}`); }

  try {
    const text = await deps.exec(deps.pm2.bin, ["jlist"], { PM2_HOME: deps.pm2.home });
    const proc = (JSON.parse(text.slice(text.indexOf("["))) as Pm2Process[]).find(candidate => candidate.name === PM2_NAME);
    if (!proc?.pid) sourceError("source", `pm2 has no live ${PM2_NAME} process (status ${proc?.pm2_env?.status ?? "missing"}), so its memory is unknown`);
    else {
      const pids = treePids(await deps.exec("ps", ["-axo", "pid=,ppid="]), proc.pid);
      metrics.dev_tree_mb = footprintMb(await deps.exec("footprint", ["--noCategories", "-f", "bytes", ...pids.flatMap(pid => ["-p", String(pid)])]));
      if (metrics.dev_tree_mb > MEMORY_TARGET_MB) flagged.push({ at, kind: "memory", excerpt: `${PM2_NAME} dev tree (pids ${pids.join(", ")}) holds ${metrics.dev_tree_mb} MB` });
    }
  } catch (error) { sourceError("source", `pm2 or footprint (PM2_HOME ${deps.pm2.home}): ${error instanceof Error ? error.message : String(error)}`); }

  const walkPath = join(deps.repo, WALK_FILE);
  try {
    const walk = readWalk(JSON.parse(await deps.read(walkPath)) as WalkReport);
    metrics.outside_requests = walk.outside.length;
    if (!walk.tests) sourceError("walk", `${WALK_FILE} has no offline.spec.ts result`);
    else if (!Number.isFinite(walk.at) || at - walk.at > WALK_STALE_MS) sourceError("walk_stale", `the last offline walk in ${WALK_FILE} started ${Number.isFinite(walk.at) ? new Date(walk.at).toISOString() : "at an unknown time"}, over 24 h ago`);
    for (const entry of walk.outside) flagged.push({ at, kind: "outside_request", excerpt: entry });
    for (const failure of walk.otherFailures) sourceError("walk_failed", `offline walk failed before its outside check: ${failure}`);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    sourceError("walk", missing ? `no offline walk result yet at ${WALK_FILE}` : `${WALK_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { metrics, flagged };
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
  const result = await measureSandbox({ fetch, exec, now: Date.now, read: path => readFile(path, "utf8"), repo: REPO,
    pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home: join(REPO, ".cache/pm2-dev") } });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
