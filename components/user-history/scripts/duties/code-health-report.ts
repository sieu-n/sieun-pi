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
 * - report_age_h reads the page the wiki serves and finds the store day whose numbers it shows, with code-health.py's own formatting.
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
/** The steps one code-health-daily.mjs run logs, in its order. */
export const STEPS = REPOS.flatMap(repo => [`run ${repo}`, `missing ${repo}`]).concat(["load-ci", "load-tests", "page", "backup"]);

const kstDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ms));
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

/** One store day as the helper prints it: repos with rows, runs, backfilled repos, and the page rows code-health.py would render for it. */
export interface StoreDay { repos: string[]; runs: { run_id: string; repo: string; ranAt: number | null }[]; backfilled: string[];
  rows: { repo: string; label: string; now: string }[] }
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

/** The repo and label of each row of the page's code health table, with its "Now and trend" number and the arrow left out. */
export function pageRows(html: string): { repo: string; label: string; now: string }[] {
  const start = html.indexOf('<h2 id="table">');
  const table = start < 0 ? "" : html.slice(start, html.indexOf("</table>", start));
  const text = (cell: string): string => cell.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
  return [...table.matchAll(/<tr>(.*?)<\/tr>/gs)].map(row => [...row[1]!.matchAll(/<td>(.*?)<\/td>/gs)].map(cell => text(cell[1]!)))
    .filter(cells => cells.length === 6).map(cells => ({ repo: cells[0]!, label: cells[1]!, now: cells[4]!.replace(/\s*[↑↓→]$/, "") }));
}

/** The newest store day whose rows for both repos are the rows the page shows, or null when the page shows no day of the store. */
export function shownDay(page: { repo: string; label: string; now: string }[], days: Record<string, StoreDay>): string | null {
  const key = (row: { repo: string; label: string; now: string }): string => `${row.repo}\t${row.label}\t${row.now}`;
  const shown = new Set(page.map(key));
  if (!REPOS.every(repo => page.some(row => row.repo === repo))) return null;
  const match = Object.keys(days).sort().reverse().find(day => {
    const rows = days[day]!.rows.filter(row => REPOS.includes(row.repo as (typeof REPOS)[number]));
    return rows.length > 0 && rows.length === page.length && rows.every(row => shown.has(key(row)));
  });
  return match ?? null;
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
spec = importlib.util.spec_from_file_location("code_health", module)
ch = importlib.util.module_from_spec(spec)
sys.modules["code_health"] = ch
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
        "runs": [{"run_id": a, "repo": b, "ranAt": c} for a, b, c in q("SELECT run_id, repo, epoch_ms(ran_at) FROM runs WHERE day = ?")],
        "backfilled": [r for (r,) in q("SELECT DISTINCT repo FROM metrics WHERE day = ? AND metric = 'backfilled' AND value = 1")],
        "rows": [{"repo": r["repo"], "label": r["label"], "now": ch.shown(r["value"], r["unit"])} for r in ch.headline(con, day)],
    }
con.close()
shutil.rmtree(work, ignore_errors=True)
print(json.dumps(days))
`;

export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

/** Store days from today back 8 days, read from a copy of the store so the timer's write lock never blocks the read. */
async function storeDays(exec: Exec, now: number): Promise<Record<string, StoreDay>> {
  const module = join(tmpdir(), `code-health-${process.pid}.py`);
  await writeFile(module, await exec("git", ["-C", CHECKOUT, "show", "origin/sieun/dev:apps/llm-wiki/scripts/code-health.py"], 20_000));
  try {
    // measured 12 s on us-metal02 on 2026-10-18 for 9 days
    const out = await exec("uv", ["run", "-q", "--no-project", "--with", "duckdb", "python", "-c", HELPER, module, STORE, kstDay(now), "9"], 120_000);
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

export async function measure(exec: Exec, fetchPage: () => Promise<string>, readLog: () => Promise<string>, now: number): Promise<PrecheckOutput> {
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: string, excerpt: string): void => { flagged.push({ at: now, kind, excerpt: excerpt.slice(0, 400) }); };
  const metrics = { report_days_7d: UNMEASURED, report_age_h: UNMEASURED, backup_age_h: UNMEASURED, source_errors: UNMEASURED };
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
      const page = pageRows(await fetchPage());
      const day = shownDay(page, days);
      if (!day) flag("page", `the page's ${page.length} table rows match no store day of the last 9 for both repos`);
      else {
        const ranAt = Math.max(Date.parse(`${day}T06:00:00+09:00`), ...days[day]!.runs.filter(run => REPOS.some(repo => run.run_id.startsWith(`${repo}-`))).map(run => run.ranAt ?? 0));
        metrics.report_age_h = Math.round((now - ranAt) / HOUR * 10) / 10;
        flag("page", `the page shows ${day}, from runs that ended ${new Date(ranAt).toISOString()}; newest store day with both repos is ${Object.keys(days).sort().reverse().find(d => REPOS.every(repo => days[d]!.repos.includes(repo))) ?? "none"}`);
      }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
