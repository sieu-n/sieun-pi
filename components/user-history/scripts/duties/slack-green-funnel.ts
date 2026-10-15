import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TIMEOUT_MS } from "../../src/shared/chat-duties.ts";
import { parseEnv } from "./local-dev-uptime.ts";

/**
 * The slack green guy's Visitors become paying users duty's precheck (`node --import tsx scripts/duties/slack-green-funnel.ts`). No model call.
 * Its headline is the share of on-topic real visitors who start Pro or buy the CLI within 28 days of their first visit, in the cohort that
 * entered 56 to 28 days ago. It also measures the p48 conversion goals over the last 28 full days in PostHog's project timezone (Asia/Seoul),
 * with slack-green's own scripts/seo-agent/conversion_targets.py, and the real people who got a home page test flag (sg-exp-home*) in the last 24 h.
 * conversion_targets.py is on origin/main once PR #236 merges and only on its branch until then. The precheck never runs code from the
 * slack-green checkout (it sits on a feature branch): it fetches the remote ref, `git archive`s scripts/seo-agent and scripts/posthog into a
 * temp folder, and runs slack-green-funnel.py there with the PostHog key from scripts/seo-agent/.env. All reads; it sends nothing.
 * `--weeks N` prints the raw report with N weekly rows to stdout for the duty job, and writes no output file.
 */

const REPO = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");
const SCRIPT = "scripts/seo-agent/conversion_targets.py";
/** Where conversion_targets.py is read from, first match wins: main after PR #236 merges, the PR's branch before. */
export const REFS = [{ branch: "main", label: "origin/main" }, { branch: "feature/on-topic-visit-target", label: "PR #236 branch" }] as const;
/** The window: conversion_targets.py's default --days 28, the window the p48 goal and the funnel dashboard tile use. */
export const DAYS = 28;
/**
 * The duty JSON's targets and where each comes from (JSON has no comments):
 * - on_topic_visit_to_paid_pct >= 1 is the headline. The owner asked to improve the whole conversion funnel, visitor to paying user, so it
 *   divides by on-topic real visitors, not signups. It is a matured cohort: visitors whose first real page was 56 to 28 days ago, and the
 *   ones who signed up and then started Pro or bought the CLI within 28 days of that visit. PostHog has real pageviews from 2026-06 on, so
 *   the cohort is measurable. On 2026-10-15 it read 0.56% (8 of 1,426, entries 08-20 to 09-17), the cohort before it 0.43% (6 of 1,405);
 *   1% is about double the best one. The owner's p48 goals multiply to 0.2% (2% signup times 10% paid), which this cohort already passes.
 * - on_topic_visit_to_signup_pct >= 2 and signup_to_workspace_pct >= 60 are the owner's p48 goal on the chat's board over the last 28 full
 *   days, the same TARGETS as conversion_targets.py; they move within days of a change, the headline only 4 to 8 weeks later.
 * - home_test_reach_pct >= 90: the share of real people who opened the English home page signed out in the last 24 h (the visitors the
 *   home test is for: landing-ab-wrapper.tsx sends the exposure only on locale en and never on ?noredirect=true, the signed-in path) who got an
 *   sg-exp-home exposure. A count failed on quiet days: PostHog shows 7 to 11 real home visitors a day on the weekends of 09-26, 10-03 and
 *   10-10, so 20 a day missed even with every visitor in the test, while a share holds on any traffic. sg-exp-home-1 went live 10-14 22:51 KST
 *   and about 21 of 24 eligible visitors got it since, so 90% passes a working test and misses one that drops visitors.
 *   The 24 h people count and the 7-day eligible and exposed counts stay in the detail as home_test_people_24h and the home_test slice.
 * signup_to_paid_pct and source_errors stay in the output for the run's detail file and are not declared. A source that fails sets the
 * headline to 0, a miss, with a source_error slice that says to fix the precheck first.
 * The duty JSON sets timeoutMs 120000, the runner's own cap PRECHECK_TIMEOUT_MS; the first cold run took 74.6 s (2026-10-12, PostHog query
 * cache empty), later runs 10 s for the queries and 17.2 s in all.
 */
export const HEADLINE = "on_topic_visit_to_paid_pct";

/** One window of conversion_targets.py's window_report. Rates are percents, null when the part they divide by is 0. */
export interface WindowReport {
  start: string; end: string; visitors: number; signed_up: number; workspace_added: number; pro_or_cli: number;
  on_topic_visitors: number; on_topic_signed_up: number; off_topic_share: number | null;
  on_topic_visit_to_signup: number | null; visit_to_signup: number | null; signup_to_workspace: number | null; signup_to_pro_or_cli: number | null;
  entry_classes: Record<string, { visitors: number; signed_up: number; workspace_added: number; pro_or_cli: number; visit_to_signup: number | null }>;
}
export interface HomeTest { eligible: number; eligible_exposed: number; exposed: number; eligible_7d: number; eligible_exposed_7d: number; home_visitors: number; flags: string[] }
/** The headline cohort: real visitors who entered from `start` to `end` (exclusive), followed to `follow_end` for `follow_days`. */
export interface CohortReport {
  start: string; end: string; follow_end: string; follow_days: number; on_topic_visitors: number; on_topic_signed_up: number; on_topic_paid: number;
  entry_classes: Record<string, { visitors: number; signed_up: number; paid: number }>;
}
/** What slack-green-funnel.py prints. */
export interface FunnelReport {
  window: WindowReport | null; window_error: string | null; home: HomeTest | null; home_error: string | null;
  cohort?: CohortReport | null; cohort_error?: string | null; weeks?: (WindowReport | null)[];
}
export interface FunnelState { metrics: Record<string, number>; at: number }

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], options?: { cwd?: string; env?: Record<string, string> }) => Promise<string>;
export interface FunnelDeps { exec: Exec; now: () => number; repo: string; python: string; wrapper: string; env: Record<string, string>; weeks?: number }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/phx_[A-Za-z0-9]+/g, "phx_***");
const pct = (part: number, whole: number): number => Math.round(10000 * part / whole) / 100;
const SOURCES = 3;

/**
 * The metrics from one report. Each source that failed (the cohort query, the 28-day query, the home test query, or a cohort or window with
 * no real visitors) adds 1 to source_errors and a source_error slice, and any failure sets the headline to 0, so an unmeasured run is a miss
 * and never a made-up good value. A script that did not run at all counts every source. A null signup rate with real visitors means 0
 * signups, a real 0.
 */
export function funnelMetrics(report: FunnelReport | null, at: number, sourceError?: string): { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  const metrics: Record<string, number> = { [HEADLINE]: 0, on_topic_visit_to_signup_pct: 0, signup_to_workspace_pct: 0, home_test_reach_pct: 0, home_test_people_24h: 0, signup_to_paid_pct: 0, source_errors: 0 };
  const flagged: FlaggedSlice[] = [];
  const fail = (excerpt: string, item = "p48") => {
    metrics.source_errors! += 1;
    flagged.push({ at, kind: "source_error", item, excerpt: `${excerpt}; fix the precheck first, ${HEADLINE} reads 0 until it is fixed` });
  };
  if (!report) {
    fail(`slack-green-funnel.py did not run: ${sourceError ?? "no report"}`);
    metrics.source_errors = SOURCES;
    return { metrics, flagged };
  }
  const cohort = report.cohort;
  let headline = 0;
  if (!cohort || report.cohort_error) fail(`the 28-day paid cohort query failed: ${report.cohort_error ?? "no rows"}`);
  else if (!cohort.on_topic_visitors) fail(`PostHog gave 0 on-topic real visitors who entered ${cohort.start} to ${cohort.end}, so the pageview tracking or the query is broken`);
  else {
    headline = pct(cohort.on_topic_paid, cohort.on_topic_visitors);
    flagged.push({ at, kind: "cohort", item: "p48", excerpt: `on-topic real visitors who entered ${cohort.start} to ${cohort.end} (end exclusive, Asia/Seoul), followed to ` +
      `${cohort.follow_end}: ${cohort.on_topic_visitors} visitors, ${cohort.on_topic_signed_up} signed up, ${cohort.on_topic_paid} started Pro or bought the CLI ` +
      `within ${cohort.follow_days} days; by entry class ` + Object.entries(cohort.entry_classes).map(([name, row]) => `${name} ${row.visitors}/${row.signed_up}/${row.paid}`).join(", ") +
      " (visitors/signups/paid)" });
  }
  const window = report.window;
  if (!window || report.window_error) fail(`the ${DAYS}-day funnel query failed: ${report.window_error ?? "no rows"}`);
  else if (!window.visitors) fail(`PostHog gave 0 real visitors for ${window.start} to ${window.end}, so the pageview tracking or the query is broken`);
  else {
    metrics.on_topic_visit_to_signup_pct = window.on_topic_visit_to_signup ?? 0;
    metrics.signup_to_workspace_pct = window.signup_to_workspace ?? 0;
    metrics.signup_to_paid_pct = window.signup_to_pro_or_cli ?? 0;
    flagged.push({ at, kind: "window", item: "p48", excerpt: `${window.start} to ${window.end} (end exclusive, Asia/Seoul): ${window.visitors} real visitors, ` +
      `${window.on_topic_visitors} on-topic, ${window.signed_up} signups (${window.on_topic_signed_up} on-topic), ${window.workspace_added} connected a workspace, ` +
      `${window.pro_or_cli} started Pro or bought the CLI; off-topic blog share ${window.off_topic_share ?? 0}%, all-visitor signup rate ${window.visit_to_signup ?? 0}%` });
    for (const [name, row] of Object.entries(window.entry_classes)) {
      flagged.push({ at, kind: "entry_class", item: "p48", excerpt: `${name}: ${row.visitors} visitors, ${row.signed_up} signups (${row.visit_to_signup ?? 0}%), ` +
        `${row.workspace_added} workspaces, ${row.pro_or_cli} Pro or CLI` });
    }
  }
  const home = report.home;
  if (!home || report.home_error) fail(`the 24 h home test query failed: ${report.home_error ?? "no rows"}`, "p54");
  else if (!home.eligible) fail("PostHog gave 0 real signed-out English home visitors in 24 h, so the pageview tracking or the query is broken", "p54");
  else {
    metrics.home_test_reach_pct = pct(home.eligible_exposed, home.eligible);
    metrics.home_test_people_24h = home.exposed;
    flagged.push({ at, kind: "home_test", item: "p54", excerpt: `last 24 h: ${home.eligible_exposed} of ${home.eligible} real signed-out English home visitors got a home test ` +
      `exposure (${home.flags.length ? home.flags.join(", ") : "no sg-exp-home flag was called"}); ${home.exposed} real people got one anywhere, out of ` +
      `${home.home_visitors} real home visitors in any locale; last 7 days: ${home.eligible_exposed_7d} of ${home.eligible_7d}` });
  }
  metrics[HEADLINE] = metrics.source_errors ? 0 : headline;
  return { metrics, flagged };
}

/** A slice that says how each metric moved since the last run, or nothing on the first run. */
export function trend(previous: FunnelState | undefined, metrics: Record<string, number>, at: number): FlaggedSlice[] {
  if (!previous) return [];
  const moved = Object.entries(metrics).filter(([key]) => key !== "source_errors" && previous.metrics[key] !== undefined)
    .map(([key, value]) => `${key} ${previous.metrics[key]} to ${value}`);
  return moved.length ? [{ at, kind: "since_last_run", excerpt: `since ${new Date(previous.at).toISOString()}: ${moved.join(", ")}` }] : [];
}

/** Fetches main, then the PR branch only when main lacks conversion_targets.py, and gives the first ref that has it. A failed fetch keeps the old ref. */
export async function pickRef(deps: Pick<FunnelDeps, "exec" | "repo">): Promise<{ ref: string; label: string; notes: string[] } | { error: string; notes: string[] }> {
  const notes: string[] = [];
  for (const { branch, label } of REFS) {
    const ref = `refs/remotes/origin/${branch}`;
    try { await deps.exec("git", ["-C", deps.repo, "fetch", "--quiet", "origin", `+refs/heads/${branch}:${ref}`]); }
    catch (error) { notes.push(`git fetch of ${branch} failed, using the last fetched ref: ${message(error)}`); }
    try { await deps.exec("git", ["-C", deps.repo, "cat-file", "-e", `${ref}:${SCRIPT}`]); return { ref, label, notes }; }
    catch { notes.push(`${label} has no ${SCRIPT}`); }
  }
  return { error: `no ref has ${SCRIPT}: ${notes.join("; ")}`, notes };
}

/** Extracts the scripts from the ref into a temp folder and runs slack-green-funnel.py there. Throws when the script cannot run. */
export async function readFunnel(deps: FunnelDeps, ref: string): Promise<FunnelReport> {
  const dir = await mkdtemp(join(tmpdir(), "sg-funnel-"));
  try {
    const tar = join(dir, "scripts.tar");
    await deps.exec("git", ["-C", deps.repo, "archive", `--output=${tar}`, ref, "scripts/seo-agent", "scripts/posthog"]);
    await deps.exec("tar", ["-xf", tar, "-C", dir]);
    const key = deps.env.POSTHOG_PERSONAL_API_KEY;
    if (!key) throw new Error(`POSTHOG_PERSONAL_API_KEY is not set in ${deps.repo}/scripts/seo-agent/.env`);
    const stdout = await deps.exec(deps.python, [deps.wrapper, join(dir, "scripts/seo-agent"), String(DAYS), String(deps.weeks ?? 0)],
      { cwd: dir, env: { POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: deps.env.POSTHOG_PROJECT_ID || "226805", ...(deps.env.POSTHOG_HOST ? { POSTHOG_HOST: deps.env.POSTHOG_HOST } : {}) } });
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as FunnelReport;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function measureFunnel(deps: FunnelDeps, previous: FunnelState | undefined): Promise<{ output: PrecheckOutput; state?: FunnelState }> {
  const at = deps.now();
  const picked = await pickRef(deps);
  const notes: FlaggedSlice[] = picked.notes.map(excerpt => ({ at, kind: "source_note", excerpt }));
  if ("error" in picked) {
    const { metrics, flagged } = funnelMetrics(null, at, picked.error);
    return { output: { metrics, flagged: [...flagged, ...notes] } };
  }
  let report: FunnelReport | null = null;
  let failure: string | undefined;
  try { report = await readFunnel(deps, picked.ref); } catch (error) { failure = message(error); }
  const { metrics, flagged } = funnelMetrics(report, at, failure);
  const source: FlaggedSlice = { at, kind: "script_ref", excerpt: `conversion_targets.py read from ${picked.label} (${picked.ref}) with git archive, not from the slack-green checkout` };
  return { output: { metrics, flagged: [source, ...notes, ...flagged, ...trend(previous, metrics, at)] }, ...(metrics.source_errors ? {} : { state: { metrics, at } }) };
}

/** The first python 3 that exists: $PYTHON, Homebrew's, uv's 3.11, then python3 on PATH. */
function python(): string {
  return process.env.PYTHON || ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", join(homedir(), ".local/bin/python3.11")].find(path => existsSync(path)) || "python3";
}

/**
 * Each command stops 10 s before the runner's PRECHECK_TIMEOUT_MS, so a hung PostHog query still ends as a source error with every metric
 * written. 10 s covers the rest of a run: the first full run took 17.2 s, of which the python queries took 10.2 s, so git, tar and node took 7 s.
 */
const COMMAND_TIMEOUT_MS = PRECHECK_TIMEOUT_MS - 10_000;
const exec: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, cwd: options?.cwd, env: { ...process.env, ...options?.env } },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args[0] ?? ""}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});

async function main(): Promise<void> {
  const at = process.argv.indexOf("--weeks");
  const weeks = at >= 0 ? Number(process.argv[at + 1]) || 4 : 0;
  const env = await readFile(join(REPO, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({}));
  const deps: FunnelDeps = { exec, now: Date.now, repo: REPO, python: python(), wrapper: join(import.meta.dirname, "slack-green-funnel.py"), env, weeks };
  if (weeks) {
    const picked = await pickRef(deps);
    if ("error" in picked) throw new Error(picked.error);
    process.stdout.write(JSON.stringify(await readFunnel(deps, picked.ref), null, 2) + "\n");
    return;
  }
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-funnel: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as FunnelState, () => undefined) : undefined;
  const result = await measureFunnel(deps, previous?.metrics ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && result.state) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
