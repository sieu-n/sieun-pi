import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";
import { parseEnv } from "./local-dev-uptime.ts";

/**
 * The slack green guy's Slack Green tests duty's precheck (`node --import tsx scripts/duties/slack-green-tests.ts`). No model call, all reads.
 * The owner, 11-13 (c222): "your duty is to check ab test results as they clear every day. NEVER CHANGE SHIT UNLESS PROVEN". So a change reaches
 * all users only after its 50/50 test proves it, and every test gets a call once it clears.
 * The call lives in PostHog itself: a test is called when its experiment in project 226805 has an end date (the duty job ends it with its
 * conclusion from the owner's PostHog tab in Aside). The repo's PostHog keys have no experiment:read or feature_flag:read scope, so the precheck
 * reads system.experiments and system.feature_flags through HogQL, which query:read allows.
 * Its headline, tests_overdue, counts live tests past their read date. A test is live when it started, has no end date, is not archived and its
 * flag is not deleted. Its read date is, first match wins: a "Read date: YYYY-MM-DD" line in the experiment description, the test's read_date in
 * ~/work/slack-green-ab-tests/tests.json (the ab-results-page job's table, 11-13), or 28 days after the start. A test in tests.json with no
 * PostHog experiment (an email cohort test) counts too once its read date passes, until an experiment named with its key records its call.
 * Each live test gets one slice with each arm's people, and how many of them signed up or connected Slack within 7 days of their first
 * exposure or paid within 28 days (`armsQuery`, the ab-results-page method), with a two-sided Fisher exact p of each test arm against control.
 * The duty job reads the experiment description for the test's own primary metric.
 */

export const HEADLINE = "tests_overdue";
export const PROJECT = "226805";
export const DEFAULT_READ_DAYS = 28;
const DAY_MS = 86_400_000;
export const TESTS_FILE = join(homedir(), "work/slack-green-ab-tests/tests.json");
const REPO = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");

export interface Experiment { id: number; name: string; flag: string | null; start: string | null; end: string | null; archived: boolean; flagDeleted: boolean; description: string }
export interface ArmRow { flag: string; arm: string; n: number; signed_up: number; workspace_added: number; paid: number; last_new: string }
/** One row of tests.json; only these fields are read. */
export interface TableTest { flag: string; experiment_id: number | null; read_date: string | null }
export type Query = (hogql: string) => Promise<unknown[][]>;

const OUTCOMES = ["signed_up", "workspace_added", "paid"] as const;
const LABEL = { signed_up: "signed up in 7 days", workspace_added: "connected in 7 days", paid: "paid in 28 days" } as const;
const day = (iso: string) => iso.slice(0, 10);
const pct = (part: number, whole: number) => whole ? Math.round(1000 * part / whole) / 10 : 0;

/** ln(n!) by summing logs; n stays in the low thousands here. */
function logFactorial(n: number): number { let sum = 0; for (let i = 2; i <= n; i++) sum += Math.log(i); return sum; }
/** Two-sided Fisher exact p for a 2x2 table [a b; c d], summing every table with the same margins that is no likelier than this one. */
export function fisherP(a: number, b: number, c: number, d: number): number {
  const row1 = a + b, col1 = a + c, n = a + b + c + d;
  const base = logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n);
  const prob = (x: number) => Math.exp(base - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(n - row1 - col1 + x));
  const seen = prob(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x++) { const q = prob(x); if (q <= seen * (1 + 1e-7)) p += q; }
  return Math.min(1, Math.round(p * 1000) / 1000);
}

/** The read date of a test and where it came from. */
export function readDate(experiment: Experiment, table: readonly TableTest[]): { date: string; from: string } {
  const line = /Read date:\s*(\d{4}-\d{2}-\d{2})/i.exec(experiment.description);
  if (line) return { date: line[1]!, from: "the experiment description" };
  const row = table.find(test => test.experiment_id === experiment.id || (experiment.flag && test.flag === experiment.flag));
  if (row?.read_date) return { date: row.read_date, from: "tests.json" };
  return { date: day(new Date(Date.parse(experiment.start!) + DEFAULT_READ_DAYS * DAY_MS).toISOString()), from: `${DEFAULT_READ_DAYS} days after the start` };
}

/** A read date has passed once its day began in Asia/Seoul, PostHog's project timezone. */
const passed = (date: string, now: number) => Date.parse(`${date}T00:00:00+09:00`) <= now;

const pastWords = (days: number) => days === 0 ? "due today" : `${days} day${days === 1 ? "" : "s"} past it`;

export const isLive = (e: Experiment) => Boolean(e.start) && !e.end && !e.archived && !e.flagDeleted;

/** One line per arm against control, and the smallest p of any outcome for any test arm. */
export function armWords(rows: readonly ArmRow[]): { words: string; minP: number | null } {
  const control = rows.find(row => row.arm === "control");
  let minP: number | null = null;
  const parts = rows.map(row => {
    const rates = OUTCOMES.map(key => `${row[key]} ${LABEL[key]} (${pct(row[key], row.n)}%)`).join(", ");
    if (!control || row === control) return `${row.arm} ${row.n} people: ${rates}`;
    const ps = OUTCOMES.map(key => {
      const p = fisherP(row[key], row.n - row[key], control[key], control.n - control[key]);
      minP = minP === null ? p : Math.min(minP, p);
      return `${LABEL[key]} ${p}`;
    });
    return `${row.arm} ${row.n} people: ${rates}; p against control: ${ps.join(", ")}`;
  });
  return { words: parts.length ? parts.join("; ") : "no exposures from real people", minP };
}

export function testsMetrics(experiments: readonly Experiment[], arms: readonly ArmRow[], table: readonly TableTest[], now: number):
  { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  const flagged: FlaggedSlice[] = [];
  let overdue = 0, live = 0, proven = 0;
  for (const experiment of experiments.filter(isLive).sort((a, b) => a.start!.localeCompare(b.start!))) {
    live += 1;
    const read = readDate(experiment, table);
    const late = passed(read.date, now);
    if (late) overdue += 1;
    const rows = arms.filter(row => row.flag === experiment.flag);
    const { words, minP } = armWords(rows);
    if (minP !== null && minP < 0.05) proven += 1;
    const lastNew = rows.map(row => row.last_new).sort().at(-1);
    flagged.push({ at: now, kind: late ? "overdue_test" : "running_test", item: experiment.flag ?? String(experiment.id),
      sig: `${experiment.id}:${late}`,
      excerpt: `${experiment.flag ?? experiment.name} (experiment ${experiment.id}, started ${day(experiment.start!)}, read ${read.date} from ${read.from}` +
        `${late ? `, ${pastWords(Math.floor((now - Date.parse(`${read.date}T00:00:00+09:00`)) / DAY_MS))} with no call` : ""}` +
        `${lastNew ? `, newest first exposure ${day(lastNew)}` : ""}): ${words}` });
  }
  for (const test of table) {
    if (test.experiment_id !== null || experiments.some(e => e.flag === test.flag || e.name.includes(test.flag))) continue;
    if (!test.read_date || !passed(test.read_date, now)) continue;
    overdue += 1;
    flagged.push({ at: now, kind: "overdue_test", item: test.flag, sig: `${test.flag}:outside`,
      excerpt: `${test.flag} has no PostHog experiment and its read date ${test.read_date} (tests.json) passed: make an experiment named with ${test.flag}, then end it with the call` });
  }
  return { metrics: { [HEADLINE]: overdue, tests_live: live, tests_live_p_under_005: proven, source_errors: 0 }, flagged };
}

const EXPERIMENTS = `SELECT e.id, e.name, f.key, e.start_date, e.end_date, e.archived, f.deleted, e.description
FROM system.experiments AS e LEFT JOIN system.feature_flags AS f ON f.id = e.feature_flag_id ORDER BY e.id`;

/**
 * QA and internal people, by the email on their person, the same regex as the ab-results-page table (tests.json `qa_email_regex`, 11-13), so
 * the duty and the page read the same numbers. On 11-13 the duty's first version counted any conversion after exposure with the project test
 * filters and read sg-exp-home-1 at 20 of 478 against 10 of 438 signups (p 0.14) while the page read 19 of 483 against 7 of 442 (p 0.045).
 */
export const QA_EMAILS = "(?i)sgqa|sg-qa|@slack\\.green|resend\\.dev|sieun|virev|example\\.com|konti|testmail";
/** What a conversion is: signed up or connected Slack within 7 days of first exposure, paid within 28 days, from 2 minutes before it. */
export const WINDOW_DAYS = { signed_up: 7, workspace_added: 7, paid: 28 } as const;
const PAID = "event IN ('subscription_purchased', 'cli_license_purchased') OR (event = 'subscription_created' AND toString(properties.trialing) != 'true') " +
  "OR (event = 'payment_succeeded' AND toFloat(properties.amount) > 0)";

/**
 * People per arm by their first exposure, people who saw two arms left out, and how many of them converted inside each outcome's window.
 * The method of the ab-results-page table, so a call reads the same numbers the owner sees there.
 */
export function armsQuery(flags: readonly string[], since: string): string {
  const list = flags.map(flag => `'${flag.replace(/'/g, "")}'`).join(", ");
  const within = (kind: string, days: number) =>
    `max(if(mm.kind = '${kind}' AND mm.timestamp >= ex.t0 - INTERVAL 2 MINUTE AND mm.timestamp <= ex.t0 + INTERVAL ${days} DAY, 1, 0))`;
  return `SELECT flag, arm, count(), sum(su), sum(ws), sum(pd), toString(max(t0)) FROM (
  SELECT ex.person_id AS pid, ex.flag AS flag, ex.arm AS arm, ex.t0 AS t0, ${within("signup", WINDOW_DAYS.signed_up)} AS su,
    ${within("connect", WINDOW_DAYS.workspace_added)} AS ws, ${within("paid", WINDOW_DAYS.paid)} AS pd
  FROM (SELECT person_id, properties.$feature_flag AS flag, argMin(toString(properties.$feature_flag_response), timestamp) AS arm, min(timestamp) AS t0,
      count(DISTINCT toString(properties.$feature_flag_response)) AS narms
    FROM events WHERE event = '$feature_flag_called' AND properties.$feature_flag IN (${list}) AND properties.$feature_flag_response IS NOT NULL
      AND timestamp >= toDateTime('${since}')
      AND person_id NOT IN (SELECT id FROM persons WHERE match(coalesce(toString(properties.email), ''), '${QA_EMAILS.replace(/\\/g, "\\\\")}'))
    GROUP BY person_id, flag) AS ex
  LEFT JOIN (SELECT person_id, timestamp, multiIf(event = 'user_signed_up', 'signup', event = 'workspace_added', 'connect', 'paid') AS kind FROM events
    WHERE timestamp >= toDateTime('${since}') AND (event IN ('user_signed_up', 'workspace_added') OR ${PAID})) AS mm ON mm.person_id = ex.person_id
  WHERE ex.narms = 1
  GROUP BY ex.person_id, ex.flag, ex.arm, ex.t0)
GROUP BY flag, arm ORDER BY flag, arm`;
}

export function toExperiment(row: unknown[]): Experiment {
  return { id: Number(row[0]), name: String(row[1] ?? ""), flag: row[2] ? String(row[2]) : null, start: row[3] ? String(row[3]) : null,
    end: row[4] ? String(row[4]) : null, archived: Boolean(row[5]), flagDeleted: Boolean(row[6]), description: String(row[7] ?? "") };
}

export async function measureTests(query: Query, table: readonly TableTest[], tableError: string | undefined, now: number): Promise<PrecheckOutput> {
  const at = now;
  let experiments: Experiment[];
  try { experiments = (await query(EXPERIMENTS)).map(toExperiment); }
  catch (error) {
    return { metrics: { [HEADLINE]: 0, source_errors: 1 }, flagged: [{ at, kind: "source_error", excerpt: `PostHog system.experiments read failed: ${message(error)}` }] };
  }
  const live = experiments.filter(isLive);
  const flags = live.map(e => e.flag).filter((flag): flag is string => Boolean(flag));
  let arms: ArmRow[] = [];
  let armsError: string | undefined;
  if (flags.length) {
    const since = live.map(e => day(e.start!)).sort()[0]!;
    try {
      arms = (await query(armsQuery(flags, since))).map(row => ({ flag: String(row[0]), arm: String(row[1]), n: Number(row[2]), signed_up: Number(row[3]),
        workspace_added: Number(row[4]), paid: Number(row[5]), last_new: String(row[6]) }));
    } catch (error) { armsError = message(error); }
  }
  const { metrics, flagged } = testsMetrics(experiments, arms, table, now);
  if (armsError) { metrics.source_errors! += 1; flagged.unshift({ at, kind: "source_error", excerpt: `the arm counts query failed, so no arm numbers this run: ${armsError}` }); }
  if (tableError) flagged.push({ at, kind: "source_note", excerpt: `${TESTS_FILE} not read (${tableError}); read dates come from experiment descriptions or ${DEFAULT_READ_DAYS} days after the start` });
  return { metrics, flagged };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/phx_[A-Za-z0-9]+/g, "phx_***");

/** A HogQL query through PostHog's query API, failing on any non-200 or query error. */
export function posthogQuery(key: string, project: string, host = "https://us.posthog.com"): Query {
  return async hogql => {
    const response = await fetch(`${host}/api/projects/${project}/query/`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
      signal: AbortSignal.timeout(PRECHECK_TARGET_MS / 3),
    });
    const body = await response.json() as { results?: unknown[][]; error?: string; detail?: string };
    if (!response.ok || !body.results) throw new Error(`HTTP ${response.status}: ${String(body.detail ?? body.error ?? "no results").slice(0, 300)}`);
    return body.results;
  };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-tests: OUTPUT_FILE is not set\n"); process.exit(2); }
  const env = await readFile(join(REPO, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({} as Record<string, string>));
  const key = env.POSTHOG_PERSONAL_API_KEY;
  let result: PrecheckOutput;
  if (!key) result = { metrics: { [HEADLINE]: 0, source_errors: 1 }, flagged: [{ at: Date.now(), kind: "source_error", excerpt: `POSTHOG_PERSONAL_API_KEY is not set in ${REPO}/scripts/seo-agent/.env` }] };
  else {
    let table: TableTest[] = [];
    let tableError: string | undefined;
    try { table = (JSON.parse(await readFile(TESTS_FILE, "utf8")) as { tests?: TableTest[] }).tests ?? []; } catch (error) { tableError = message(error); }
    result = await measureTests(posthogQuery(key, env.POSTHOG_PROJECT_ID || PROJECT, env.POSTHOG_HOST || undefined), table, tableError, Date.now());
  }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
