import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { loadHosts, roleUrl } from "../../src/hosts.ts";

/**
 * The Code health report duty's precheck (`node --import tsx scripts/duties/code-health-report.ts`). No model call.
 * The owner asked on 2026-10-15 for "daily Git reports and keep track of metrics", and checks it by opening the daily report page and
 * seeing today's numbers for both repos. auto-sns-agent's scripts/dev/code-health-daily.mjs writes them under the systemd user timer
 * code-health.timer (06:00 KST) on the wiki host, into apps/llm-wiki/content/.wiki/code-health.duckdb, the page, and a dated copy on the store box.
 * - report_days_7d reads the store: days of the last 7 KST days with metric rows for both repos.
 * - ranked_metrics_shown reads the page the wiki serves and counts the 10 tracked metrics whose page rows show the newest store day's numbers, with
 *   code_health_page.py's own formatting: the 8 the agent-code-metrics page ranks for both repos, plus auto-sns-agent's tests and CI (sieun-pi has
 *   no GitHub CI). Tests count only when that day's test load holds every suite the CI plan expects: expectedSuites() of auto-sns-agent's
 *   scripts/ci/junit-suites.mjs at PAGE_MODULE_REF, the junit suite of each test task of plan.mjs JOBS. So a load that read 2 of 12 suites, as the
 *   16:50Z run on 10-19 did, misses, and a suite that stops printing stays missing until the plan drops its task. Until 2026-10-30 the expected list
 *   was the suites of the last 7 days' loads, so a suite that stopped printing dropped out of it on its own. CI counts only when that day has
 *   ci-guarantees rows. The owner asked on 2026-10-15:
 *   "now the same system will monitor and report test stats, CI stats."
 * - backup_age_h reads the newest dated copy on the store box.
 * - source_errors reads the step lines of the last run in the timer's log.
 * An input it cannot read sets its metric to UNMEASURED, so the run misses and the flagged items say why.
 */

export const UNMEASURED = 999_999;
export const REPOS = ["auto-sns-agent", "sieun-pi"] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHECKOUT = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const STORE = join(CHECKOUT, "apps/llm-wiki/content/.wiki/code-health.duckdb");
const PAGE_PATH = "/page/domains/devops/agent-code-metrics/daily-report";
const LOG = join(homedir(), ".local/state/virev/code-health.log");
const STORE_BOX = "root@100.84.91.26";
const BACKUP_DIR = "backups/code-health";
/**
 * The 8 metrics the agent-code-metrics wiki page ranks, in its order, then tests and CI, each with the store metrics of its page rows, or the
 * top files list, and the repos it covers. New complex functions show as the count of functions over complexity 15, whose 7-day move is the new ones.
 */
export interface Tracked { name: string; rows: readonly string[] | "hotspots"; repos?: readonly string[]; check?: "suites" | "ci" }
export const TRACKED: readonly Tracked[] = [
  { name: "hotspots", rows: "hotspots" },
  { name: "change size", rows: ["big_commit_share_30d"] },
  { name: "14-day rework", rows: ["rework_share_7d"] },
  { name: "new complex functions", rows: ["functions_over_ccn15"] },
  { name: "new copied blocks", rows: ["new_clones_1d"] },
  { name: "new unused exports and import cycles", rows: ["new_unused_exports_1d", "new_import_cycles_1d"] },
  { name: "test files edited", rows: ["test_files_edited_1d", "suppressions_added_1d"] },
  { name: "lines of code", rows: ["source_lines"] },
  { name: "tests (full suite set)", rows: ["tests_total_1d", "tests_pass_rate_1d"], repos: ["auto-sns-agent"], check: "suites" },
  { name: "CI", rows: ["ci_land_success_successpct_7d", "ci_queue_wait_heavy_p50_1d", "ci_queue_wait_light_p50_1d"], repos: ["auto-sns-agent"], check: "ci" },
];
/** Where the page module and the CI plan's suite table are read from: us-metal02's dev branch (c119). */
export const PAGE_MODULE_REF = "origin/dev/sieun";
/** The CI plan's junit suite table in auto-sns-agent, a module with no imports, so it loads from a git object. */
export const SUITES_MODULE = "scripts/ci/junit-suites.mjs";
/** The steps one code-health-daily.mjs run logs, in its order. */
export const STEPS = REPOS.flatMap(repo => [`run ${repo}`, `missing ${repo}`]).concat(["load-ci", "load-tests", "page", "backup"]);

const kstDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ms));
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

export interface PageRow { repo: string; label: string; now: string }
export interface Hotspot { repo: string; path: string }
/**
 * One store day as the helper prints it: repos with rows, backfilled repos, the table rows and top files code_health_page.py would render for it,
 * the junit suites of its test load, and its count of ci-guarantees rows.
 */
export interface StoreDay { repos: string[]; backfilled: string[];
  rows: (PageRow & { metric: string })[]; hotspots: Hotspot[]; suites: string[]; ciRows: number }
/** The timer's state from systemd: when it last fired and whether its run is going now. */
export interface TimerState { lastTrigger: number | null; running: boolean }
export interface StepLine { at?: string; step: string; ok: boolean; error?: string }

/**
 * The last day the window ends on: today (KST) once today has rows for both repos or the timer fired today and its run ended,
 * else yesterday, so a run before 06:00 KST or during the timer's run does not count today as missing.
 */
export function windowEnd(days: Record<string, StoreDay>, timer: TimerState, now: number): string {
  const today = kstDay(now);
  const done = REPOS.every(repo => days[today]?.repos.includes(repo));
  const fired = timer.lastTrigger !== null && kstDay(timer.lastTrigger) === today && !timer.running;
  return done || fired ? today : addDays(today, -1);
}

/** The 7 days ending on `end`, each with the repos that have no rows. */
export function reportDays(days: Record<string, StoreDay>, end: string): { day: string; missing: string[] }[] {
  return Array.from({ length: 7 }, (_, n) => addDays(end, -n)).map(day => ({ day, missing: REPOS.filter(repo => !days[day]?.repos.includes(repo)) }));
}

const cellText = (cell: string): string => cell.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
/** The cells of each table row in `html` from the `<h2 id="${id}">` heading to the next h2. */
function sectionRows(html: string, id: string): { cells: string[]; at: number }[] {
  const start = html.indexOf(`<h2 id="${id}">`);
  if (start < 0) return [];
  const end = html.indexOf("<h2", start + 1);
  const section = html.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/<tr>(.*?)<\/tr>/gs)].map(row => ({ cells: [...row[1]!.matchAll(/<td>(.*?)<\/td>/gs)].map(cell => cellText(cell[1]!)), at: start + row.index! }));
}

/** The repo and label of each row of the page's code health tables, one table per repo under its h3, with the "Now and trend" number and the arrow left out. */
export function pageRows(html: string): PageRow[] {
  const repos = [...html.matchAll(/<h3 id="table-([^"]+)">/g)].map(match => ({ repo: match[1]!, at: match.index! }));
  return sectionRows(html, "table").filter(row => row.cells.length === 5).flatMap(row => {
    const repo = repos.filter(heading => heading.at < row.at).at(-1)?.repo;
    return repo ? [{ repo, label: row.cells[0]!, now: row.cells[3]!.replace(/\s*[↑↓→]$/, "") }] : [];
  });
}

/** The repo and path of each row of the page's top files table. */
export function pageHotspots(html: string): Hotspot[] {
  return sectionRows(html, "hotspots").filter(row => row.cells.length === 5).map(row => ({ repo: row.cells[0]!, path: row.cells[1]! }));
}

/** The newest store day with rows for both repos, or null. */
export function newestDay(days: Record<string, StoreDay>): string | null {
  return Object.keys(days).sort().reverse().find(day => REPOS.every(repo => days[day]!.repos.includes(repo))) ?? null;
}

/**
 * Each tracked metric with what keeps it off the page: a page row that is missing, empty or not the store day's number for a repo, a repo
 * whose top files on the page are not that day's, a suite the CI plan expects that the day's test load lacks, or a day with no ci-guarantees rows.
 * `suites` is null when the plan's suite list could not be read. An empty list means the page shows it for every repo it covers.
 */
export function rankedGaps(page: PageRow[], hotspots: Hotspot[], day: StoreDay, suites: readonly string[] | null): { name: string; gaps: string[] }[] {
  const held = (suites ?? []).filter(suite => day.suites.includes(suite)).length;
  return TRACKED.map(({ name, rows, repos = REPOS, check }) => ({ name, gaps: [
    ...(check === "suites" && !suites ? [`auto-sns-agent: no expected suite list from ${SUITES_MODULE}`] : []),
    ...(check === "suites" ? (suites ?? []).filter(suite => !day.suites.includes(suite)).map(suite => `auto-sns-agent suite ${suite}: the CI plan expects it, not in this day's test load (${held} of ${suites!.length} expected suites)`) : []),
    ...(check === "ci" && !day.ciRows ? ["auto-sns-agent: no ci-guarantees rows for this day (load-ci)"] : []),
    ...repos.flatMap(repo => {
    if (rows === "hotspots") {
      const want = day.hotspots.filter(row => row.repo === repo).map(row => row.path);
      const got = hotspots.filter(row => row.repo === repo).map(row => row.path);
      return want.length && want.join("\n") === got.join("\n") ? [] : [`${repo} top files: page has ${got.length}, store has ${want.length}${want.length && got.length ? " different ones" : ""}`];
    }
    return rows.flatMap(metric => {
      const want = day.rows.find(row => row.repo === repo && row.metric === metric);
      if (!want?.now) return [`${repo} ${metric}: no number in the store`];
      const got = page.find(row => row.repo === repo && row.label === want.label);
      return got?.now === want.now ? [] : [`${repo} "${want.label}": page shows ${got ? `"${got.now}"` : "no row"}, store has "${want.now}"`];
    });
  })] }));
}

/** The step lines of the last run in the timer's log: from the last `run auto-sns-agent` line on. Other lines are skipped. */
export function lastRun(log: string): StepLine[] {
  const lines = log.split("\n").flatMap((line): StepLine[] => {
    if (!line.startsWith("{")) return [];
    try {
      const value = JSON.parse(line) as Partial<StepLine>;
      return typeof value.step === "string" && typeof value.ok === "boolean" ? [value as StepLine] : [];
    } catch { return []; }
  });
  const start = lines.map(line => line.step).lastIndexOf(STEPS[0]!);
  return start < 0 ? [] : lines.slice(start);
}

/** The failed steps of a run, plus the expected steps it never logged once it has ended. */
export function failedSteps(run: StepLine[], running: boolean): string[] {
  const failed = run.filter(line => !line.ok).map(line => `${line.step}: ${line.error ?? "failed"}`.slice(0, 300));
  if (!running) for (const step of STEPS) if (!run.some(line => line.step === step)) failed.push(`${step}: not logged by the run`);
  return failed;
}

const HELPER = String.raw`
import datetime as dt, importlib.util, json, os, shutil, sys, tempfile
module, store, today, count = sys.argv[1], sys.argv[2], dt.date.fromisoformat(sys.argv[3]), int(sys.argv[4])
spec = importlib.util.spec_from_file_location("code_health_page", module)
ch = importlib.util.module_from_spec(spec)
sys.modules["code_health_page"] = ch
spec.loader.exec_module(ch)
import duckdb
work = tempfile.mkdtemp(prefix="code-health-duty-")
copy = os.path.join(work, "store.duckdb")
shutil.copyfile(store, copy)
if os.path.exists(store + ".wal"):
    shutil.copyfile(store + ".wal", copy + ".wal")
con = duckdb.connect(copy, read_only=True)
days = {}
for n in range(count):
    day = today - dt.timedelta(days=n)
    q = lambda sql: con.execute(sql, [day]).fetchall()
    days[str(day)] = {
        "repos": [r for (r,) in q("SELECT DISTINCT repo FROM metrics WHERE day = ? ORDER BY repo")],
        "backfilled": [r for (r,) in q("SELECT DISTINCT repo FROM metrics WHERE day = ? AND metric = 'backfilled' AND value = 1")],
        "rows": [{"repo": r["repo"], "metric": r["metric"], "label": r["label"], "now": ch.shown(r["value"], r["unit"])} for r in ch.headline(con, day)],
        "hotspots": [{"repo": r["repo"], "path": r["path"]} for r in ch.hotspots(con, day)],
        "suites": [s for (s,) in con.execute("SELECT DISTINCT scope FROM metrics WHERE day = ? AND repo = 'auto-sns-agent' AND run_id = ? AND metric = 'tests_total_1d' AND scope <> '' ORDER BY scope", [day, f"{ch.TEST_SOURCE}-{day}"]).fetchall()],
        "ciRows": con.execute("SELECT count(*) FROM metrics WHERE day = ? AND repo = 'auto-sns-agent' AND run_id = ? AND metric LIKE 'ci_%'", [day, f"ci-guarantees-{day}"]).fetchone()[0],
    }
con.close()
shutil.rmtree(work, ignore_errors=True)
print(json.dumps(days))
`;

export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

/** Store days from today back 15 days, so a newest day with rows for both repos is found after a week of missed days, read from a copy of the store so the timer's write lock never blocks the read. */
async function storeDays(exec: Exec, now: number): Promise<Record<string, StoreDay>> {
  const module = join(tmpdir(), `code-health-page-${process.pid}.py`);
  await writeFile(module, await exec("git", ["-C", CHECKOUT, "show", `${PAGE_MODULE_REF}:apps/llm-wiki/scripts/code_health_page.py`], 20_000));
  try {
    // measured 12 s on us-metal02 on 2026-10-18 for 9 days
    const out = await exec("uv", ["run", "-q", "--no-project", "--with", "duckdb", "python", "-c", HELPER, module, STORE, kstDay(now), "16"], 120_000);
    return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, StoreDay>;
  } finally {
    await rm(module, { force: true });
  }
}

async function timerState(exec: Exec): Promise<TimerState> {
  const out = await exec("systemctl", ["--user", "show", "code-health.timer", "code-health.service", "--timestamp=unix", "-p", "LastTriggerUSec", "-p", "ActiveState"], 20_000);
  const trigger = /^LastTriggerUSec=@(\d+)/m.exec(out);
  const states = [...out.matchAll(/^ActiveState=(\S+)/gm)].map(match => match[1]);
  return { lastTrigger: trigger ? Number(trigger[1]) * 1000 : null, running: states[1] === "activating" || states[1] === "active" };
}

/** The newest dated copy on the store box and its mtime. BSD stat on the store box, GNU stat as the fallback. */
async function newestBackup(exec: Exec): Promise<{ file: string; at: number }> {
  const script = `cd ${BACKUP_DIR} && f=$(ls -t *.duckdb | head -1) && echo "$f $(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")"`;
  const out = (await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", STORE_BOX, script], 60_000)).trim();
  const [file, at] = out.split(" ");
  if (!file || !Number(at)) throw new Error(`no backup in ${STORE_BOX}:${BACKUP_DIR} (${out || "empty"})`);
  return { file, at: Number(at) * 1000 };
}

let suiteLoads = 0;
/** expectedSuites() of the CI plan's suite table at PAGE_MODULE_REF, loaded from a temp copy of the git object. */
export async function planSuites(exec: Exec): Promise<string[]> {
  // A name of its own per load, since import() caches a module by its URL.
  const module = join(tmpdir(), `junit-suites-${process.pid}-${++suiteLoads}.mjs`);
  await writeFile(module, await exec("git", ["-C", CHECKOUT, "show", `${PAGE_MODULE_REF}:${SUITES_MODULE}`], 20_000));
  try {
    const table = await import(pathToFileURL(module).href) as { expectedSuites?: () => unknown };
    const suites = table.expectedSuites?.();
    if (!Array.isArray(suites) || !suites.length || !suites.every(suite => typeof suite === "string")) throw new Error(`${SUITES_MODULE} expectedSuites() gave ${JSON.stringify(suites)}`);
    return suites as string[];
  } finally {
    await rm(module, { force: true });
  }
}

export async function measure(exec: Exec, fetchPage: () => Promise<string>, readLog: () => Promise<string>, now: number,
  readPlanSuites: () => Promise<string[]> = () => planSuites(exec)): Promise<PrecheckOutput> {
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: string, excerpt: string): void => { flagged.push({ at: now, kind, excerpt: excerpt.slice(0, 400) }); };
  const metrics = { report_days_7d: UNMEASURED, backup_age_h: UNMEASURED, source_errors: UNMEASURED, ranked_metrics_shown: UNMEASURED };
  const timer = await timerState(exec).catch((error: unknown) => { flag("source_error", `systemctl: ${message(error)}`); return { lastTrigger: null, running: false }; });
  flag("timer", `code-health.timer last fired ${timer.lastTrigger ? new Date(timer.lastTrigger).toISOString() : "never on this host"}, run going now: ${timer.running}`);

  const days = await storeDays(exec, now).catch((error: unknown) => { flag("source_error", `store ${STORE}: ${message(error)}`); return null; });
  if (days) {
    const window = reportDays(days, windowEnd(days, timer, now));
    metrics.report_days_7d = window.filter(day => day.missing.length === 0).length;
    for (const day of window.filter(day => day.missing.length)) flag("missing_day", `${day.day} has no rows for ${day.missing.join(" and ")}`);
    const backfilled = window.filter(day => days[day.day]?.backfilled.length).map(day => day.day);
    flag("days", `${window.at(-1)!.day} to ${window[0]!.day}: ${metrics.report_days_7d} of 7 days have rows for both repos; backfilled days: ${backfilled.join(", ") || "none"}`);
    try {
      const html = await fetchPage();
      const page = pageRows(html);
      const newest = newestDay(days);
      const suites = await readPlanSuites().catch((error: unknown) => { flag("source_error", `CI plan suites ${PAGE_MODULE_REF}:${SUITES_MODULE}: ${message(error)}`); return null; });
      const ranked = newest ? rankedGaps(page, pageHotspots(html), days[newest]!, suites) : TRACKED.map(({ name }) => ({ name, gaps: ["no store day of the last 16 has rows for both repos"] }));
      metrics.ranked_metrics_shown = ranked.filter(metric => !metric.gaps.length).length;
      const held = newest && suites ? suites.filter(suite => days[newest]!.suites.includes(suite)).length : 0;
      flag("ranked", `${metrics.ranked_metrics_shown} of ${TRACKED.length} tracked metrics show ${newest ?? "the newest day"}'s numbers on the page; its test load holds ${held} of the ${suites?.length ?? 0} suites the CI plan expects (${suites?.join(", ") || "none"})`);
      for (const metric of ranked.filter(metric => metric.gaps.length)) flag("ranked_missing", `${metric.name}: ${metric.gaps.join("; ")}`);
    } catch (error) { flag("source_error", `page ${PAGE_PATH}: ${message(error)}`); }
  }

  try {
    const backup = await newestBackup(exec);
    metrics.backup_age_h = Math.round((now - backup.at) / HOUR * 10) / 10;
    flag("backup", `newest store box copy ${BACKUP_DIR}/${backup.file}, written ${new Date(backup.at).toISOString()}`);
  } catch (error) { flag("source_error", `store box: ${message(error)}`); }

  try {
    const run = lastRun(await readLog().catch((error: unknown) => { if (timer.running) return ""; throw error; }));
    if (!run.length && timer.running) {
      metrics.source_errors = 0;
      flag("run", "the timer's first run is going now and has logged no step yet");
      return { metrics, flagged };
    }
    if (!run.length) throw new Error("no run in the log yet");
    const failed = failedSteps(run, timer.running);
    metrics.source_errors = failed.length;
    flag("run", `last run started ${run[0]!.at ?? "at an unknown time"} with ${run.length} step lines, ${failed.length} failed`);
    for (const text of failed) flag("failed_step", text);
  } catch (error) { flag("source_error", `log ${LOG}: ${message(error)}`); }
  return { metrics, flagged };
}

const exec: Exec = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message.split("\n")[0]} ${String(stderr).trim().split("\n").slice(-2).join(" | ")}`)) : resolve(stdout));
});

async function main(): Promise<void> {
  const wiki = roleUrl(await loadHosts(), "wiki");
  if (!wiki) { process.stderr.write("code-health-report: no host holds the wiki role in hosts.json\n"); process.exit(2); }
  const fetchPage = async (): Promise<string> => {
    // measured 0.7 s through the tailnet URL on 2026-10-18
    const response = await fetch(wiki + PAGE_PATH, { signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error(`GET ${wiki}${PAGE_PATH} gave ${response.status}`);
    return response.text();
  };
  const output = await measure(exec, fetchPage, () => readFile(LOG, "utf8"), Date.now());
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
