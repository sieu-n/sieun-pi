import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Fixes reach prod duty's precheck (`node --import tsx scripts/duties/fixes-reach-prod.ts`) for the auto-sns-agent chat (Engage reads,
 * Watchlist). No model call, no browser. It reads what the owner would check: GitHub's compare of auto-sns-agent main...staging (main is what
 * prod runs, since promote.yml moves main only after every prod deploy and check passes), the staging and prod crawlers' /health versions, and
 * the newest land.yml and promote.yml runs with the job and step that failed.
 * The headline, oldest_fix_wait_h, is how long the oldest commit on staging and not on main has waited, from its committer time, which is when
 * land.yml squashed it onto staging. failed_promotes_24h counts promote.yml runs started in the last 24 h that ended in failure.
 * commits_on_staging_only is the compare's ahead_by. An unreadable compare fails the run, because the headline cannot be read without it; a
 * failed run or health read is flagged as a source_error and counts failed_promotes_24h as at least 1.
 * Incident: promotes 6, 7, 8, 9, 10, 12, 13 and 14 each failed at a gate, and on 10-19 seven board steps of the chat waited a day or more for
 * one promote while land 37 sat on staging from 10-17 22:58Z.
 */

export const REPO = "sieu-n/auto-sns-agent";
export const CRAWLERS = { staging: "https://crawler-staging.virev.ai/health", prod: "https://crawler.virev.ai/health" } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Conclusions that mean a run stopped on a fault; `cancelled` is a person or a newer run stopping it, so it is not counted. */
const FAILED = ["failure", "timed_out", "startup_failure"];

export interface Commit { sha: string; at: number; title: string }
export interface Compare { mainSha: string; aheadBy: number; behindBy: number; commits: Commit[] }
export interface Run { id: number; status: string; conclusion: string; createdAt: number; branch: string; url: string }
export interface FailedJob { name: string; steps: string[] }
export interface Health { world: string; sha?: string; error?: string }

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;
export interface ReachDeps { exec: Exec; fetch: typeof fetch; now: () => number }

const short = (sha: string | undefined) => sha ? sha.slice(0, 10) : "none";
const hours = (now: number, at: number) => Math.max(0, Math.round((now - at) / HOUR_MS * 10) / 10);
const iso = (at: number) => new Date(at).toISOString().slice(0, 16) + "Z";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function readCompare(deps: ReachDeps): Promise<Compare> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/compare/main...staging`, "--jq",
    "{main: .base_commit.sha, ahead: .ahead_by, behind: .behind_by, commits: [.commits[] | {sha, at: .commit.committer.date, title: (.commit.message | split(\"\\n\")[0])}]}"]);
  const raw = JSON.parse(out) as { main: string; ahead: number; behind: number; commits: { sha: string; at: string; title: string }[] };
  return { mainSha: raw.main, aheadBy: raw.ahead, behindBy: raw.behind,
    commits: raw.commits.map(commit => ({ sha: commit.sha, at: Date.parse(commit.at), title: commit.title })).sort((a, b) => a.at - b.at) };
}

export async function readRuns(deps: ReachDeps, workflow: string): Promise<Run[]> {
  const out = await deps.exec("gh", ["run", "list", "--repo", REPO, "--workflow", workflow, "--json", "databaseId,status,conclusion,createdAt,headBranch,url"]);
  return (JSON.parse(out) as { databaseId: number; status: string; conclusion: string; createdAt: string; headBranch: string; url: string }[])
    .map(row => ({ id: row.databaseId, status: row.status, conclusion: row.conclusion, createdAt: Date.parse(row.createdAt), branch: row.headBranch, url: row.url }));
}

export async function readFailedJobs(deps: ReachDeps, id: number): Promise<FailedJob[]> {
  const out = await deps.exec("gh", ["run", "view", String(id), "--repo", REPO, "--json", "jobs"]);
  const jobs = (JSON.parse(out) as { jobs: { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[] }).jobs;
  return jobs.filter(job => FAILED.includes(job.conclusion))
    .map(job => ({ name: job.name, steps: (job.steps ?? []).filter(step => FAILED.includes(step.conclusion)).map(step => step.name) }));
}

export async function readHealth(deps: ReachDeps, world: keyof typeof CRAWLERS): Promise<Health> {
  try {
    const response = await deps.fetch(CRAWLERS[world]);
    const body = await response.text();
    if (!response.ok) return { world, error: `HTTP ${response.status}: ${body.slice(0, 120)}` };
    const sha = (JSON.parse(body) as { git_sha?: string; version?: string }).git_sha;
    return sha ? { world, sha } : { world, error: "no git_sha in the reply" };
  } catch (error) {
    return { world, error: message(error) };
  }
}

/** The newest finished run of each head branch: a land runs per dev branch, so each branch's newest result is its land's state. */
export const newestPerBranch = (runs: readonly Run[]): Run[] => {
  const seen = new Map<string, Run>();
  for (const run of [...runs].filter(run => run.status === "completed").sort((a, b) => b.createdAt - a.createdAt)) if (!seen.has(run.branch)) seen.set(run.branch, run);
  return [...seen.values()];
};

const jobWords = (jobs: readonly FailedJob[]) => jobs.length
  ? jobs.map(job => job.steps.length ? `${job.name} at step "${job.steps.join('", "')}"` : job.name).join("; ")
  : "no failed job listed";

/** Where a crawler's sha sits: main's tip, a commit only staging has, or another commit. */
export function crawlerPlace(health: Health, compare: Compare, stagingHead: string): string {
  if (!health.sha) return `the ${health.world} crawler's /health gave no version (${health.error})`;
  const at = `the ${health.world} crawler runs ${short(health.sha)}`;
  if (health.sha === stagingHead) return `${at}, staging's head`;
  if (health.sha === compare.mainSha) return `${at}, main's tip`;
  const index = compare.commits.findIndex(commit => commit.sha === health.sha);
  if (index >= 0) return `${at}, staging-only commit ${index + 1} of ${compare.aheadBy}, so it is ahead of main`;
  return `${at}, which is neither main's tip nor a staging-only commit`;
}

export interface Reading {
  compare: Compare;
  promotes?: Run[];
  lands?: Run[];
  failedJobs: Map<number, FailedJob[]>;
  health: Health[];
  errors: string[];
}

export function reachMetrics(reading: Reading, now: number): PrecheckOutput {
  const { compare } = reading;
  const flagged: FlaggedSlice[] = reading.errors.map(error => ({ at: now, kind: "source_error", excerpt: error }));
  const oldest = compare.commits[0];
  const stagingHead = compare.commits.at(-1)?.sha ?? compare.mainSha;
  if (compare.behindBy > 0) flagged.push({ at: now, kind: "staging_behind_main", excerpt: `main has ${compare.behindBy} commits staging lacks, so promote.yml's fast-forward refuses until staging takes them` });
  if (oldest) {
    flagged.push({ at: now, kind: "oldest_fix", item: oldest.sha,
      excerpt: `${short(oldest.sha)} landed on staging ${iso(oldest.at)}, ${hours(now, oldest.at)} h ago, and main lacks it: ${oldest.title.slice(0, 160)}` });
    flagged.push({ at: now, kind: "staging_only", excerpt: `${compare.aheadBy} commits on staging and not on main: ` +
      compare.commits.map(commit => `${short(commit.sha)} (${hours(now, commit.at)} h)`).join(", ") });
  } else {
    flagged.push({ at: now, kind: "in_sync", excerpt: `main ${short(compare.mainSha)} holds every staging commit` });
  }
  for (const health of reading.health) flagged.push({ at: now, kind: health.sha ? `${health.world}_crawler` : "source_error", excerpt: crawlerPlace(health, compare, stagingHead) });

  const recentFailed = (reading.promotes ?? []).filter(run => run.createdAt >= now - DAY_MS && FAILED.includes(run.conclusion));
  for (const run of reading.promotes ?? []) {
    if (run.status !== "completed") flagged.push({ at: now, kind: "promote_in_flight", item: String(run.id), excerpt: `promote run ${run.id} is ${run.status}, started ${iso(run.createdAt)}: ${run.url}` });
  }
  const newestPromote = (reading.promotes ?? []).filter(run => run.status === "completed").sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newestPromote) {
    const failed = FAILED.includes(newestPromote.conclusion);
    flagged.push({ at: now, kind: failed ? "promote_failed" : "promote_last", item: String(newestPromote.id),
      excerpt: `the newest finished promote, run ${newestPromote.id} from ${iso(newestPromote.createdAt)}, ended ${newestPromote.conclusion}` +
        (failed ? ` in ${jobWords(reading.failedJobs.get(newestPromote.id) ?? [])}` : "") + `: ${newestPromote.url}` });
  }
  for (const run of recentFailed) {
    if (run === newestPromote) continue;
    flagged.push({ at: now, kind: "promote_failed_24h", item: String(run.id), excerpt: `promote run ${run.id} from ${iso(run.createdAt)} ended ${run.conclusion} in ${jobWords(reading.failedJobs.get(run.id) ?? [])}` });
  }
  for (const run of newestPerBranch(reading.lands ?? [])) {
    if (!FAILED.includes(run.conclusion)) continue;
    flagged.push({ at: now, kind: "land_failed", item: String(run.id),
      excerpt: `the newest land of ${run.branch}, run ${run.id} from ${iso(run.createdAt)}, ended ${run.conclusion} in ${jobWords(reading.failedJobs.get(run.id) ?? [])}: ${run.url}` });
  }

  const unread = reading.promotes ? 0 : 1;
  const metrics: Record<string, number> = {
    oldest_fix_wait_h: oldest ? hours(now, oldest.at) : 0,
    failed_promotes_24h: Math.max(recentFailed.length, unread),
    commits_on_staging_only: compare.aheadBy,
  };
  const lastFailed = recentFailed.map(run => run.createdAt).sort((a, b) => b - a)[0];
  return { metrics, flagged, ...(lastFailed ? { lastEventAt: { failed_promotes_24h: lastFailed } } : {}) };
}

export async function measureReach(deps: ReachDeps): Promise<PrecheckOutput> {
  const now = deps.now();
  const errors: string[] = [];
  const fail = (what: string) => (error: unknown): undefined => { errors.push(`${what}: ${message(error)}`); return undefined; };
  const [compare, promotes, lands, ...health] = await Promise.all([
    readCompare(deps),
    readRuns(deps, "promote.yml").catch(fail("promote.yml runs")),
    readRuns(deps, "land.yml").catch(fail("land.yml runs")),
    readHealth(deps, "staging"),
    readHealth(deps, "prod"),
  ]);
  const failedRuns = [...(promotes ?? []).filter(run => run.createdAt >= now - DAY_MS), ...newestPerBranch(promotes ?? []), ...newestPerBranch(lands ?? [])]
    .filter(run => FAILED.includes(run.conclusion));
  const failedJobs = new Map<number, FailedJob[]>();
  await Promise.all([...new Set(failedRuns.map(run => run.id))].map(async id => {
    const jobs = await readFailedJobs(deps, id).catch(fail(`jobs of run ${id}`));
    if (jobs) failedJobs.set(id, jobs);
  }));
  return reachMetrics({ compare, ...(promotes ? { promotes } : {}), ...(lands ? { lands } : {}), failedJobs, health, errors }, now);
}

const exec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8" },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 2).join(" ")}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("fixes-reach-prod: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measureReach({ exec, fetch, now: Date.now }), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
