import { realpathSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Fixes reach prod duty's precheck (`node --import tsx scripts/duties/fixes-reach-prod.ts`) for the auto-sns-agent chat (Engage reads,
 * Watchlist). No model call, no browser. It reads what the owner would check: GitHub's compare of auto-sns-agent main...staging (main is what
 * prod runs, since promote.yml moves main only after every prod deploy and check passes), the staging and prod crawlers' /health versions, and
 * the newest land.yml, staging-deploy.yml and promote.yml runs with the job and step that failed, and the newest promotable staging sha.
 * promote.yml ships staging's head or an older staging land given as its sha input, and its gates need two things on that sha: the newest
 * deploy/staging status is a success ("gate / staging serves this sha"), and the full verify of that sha, the verify-dev probe run
 * staging-check.yml dispatches, passes the promote's critical set for the sha's deploy scope ("gate / staging CI green"). The precheck walks the
 * staging-only commits newest first and judges each with auto-sns-agent's own scripts/ci (promote-preflight.mjs stagingCheckMiss over
 * promote-critical.mjs promoteJudge, and deploy-staging.mjs scopeOf), loaded from its checkout, so a verify red only on a warn-only task reads
 * promotable here as it does in promote.yml.
 * Incident: on 10-28 staging 68132a1f87 was pinned for promote 21 with a critical-green staging check, while its full verify 40656926422 was red
 * only on the warn-only linux (rest) //#ci:guards, and this precheck flagged no_promotable_staging_sha because it took the run's conclusion and read
 * only staging's head.
 * The headline, oldest_fix_wait_h, is how long the oldest commit on staging and not on main has waited, from its committer time, which is when
 * land.yml squashed it onto staging. failed_promotes_24h counts promote.yml runs started in the last 24 h that ended in failure after the newest
 * successful promote, since a later green promote passed the gate an earlier failure hit (10-25: 40169054833 and 40170404510 failed, their fixes
 * bc5a9a24e1 and a96b170082 landed, and 40191052854 passed, yet the count read 2 until 10-26 06:48Z).
 * commits_on_staging_only is the compare's ahead_by. An unreadable compare fails the run, because the headline cannot be read without it; a
 * failed run or health read is flagged as a source_error and counts failed_promotes_24h as at least 1.
 * Incident: promotes 6, 7, 8, 9, 10, 12, 13 and 14 each failed at a gate, and on 10-19 seven board steps of the chat waited a day or more for
 * one promote while land 37 sat on staging from 10-17 22:58Z.
 * Incident: from 10-23 00:41Z every land that reached basics failed at "basics / search build, types and lint of the squash", and the staging
 * deploy of staging's head 6e71eb0478 failed at "gate / staging release.env sets every variable compose requires" (run 39856360527), but the
 * precheck flagged neither, because 53 of the newest 60 land runs were cancelled by newer ones and it took the newest finished run of each branch.
 * Incident: on 10-24 at 01:44Z and again near 07:00Z the release owner (session 01a10810) corrected d4's "every gate is green" report, because
 * runs read staging_deploy_passed on 3b0fcfee0b as release clearance while its full verify, run 40067724892, had failed.
 */

export const REPO = "sieu-n/auto-sns-agent";
export const CRAWLERS = { staging: "https://crawler-staging.virev.ai/health", prod: "https://crawler.virev.ai/health" } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Conclusions that mean a run stopped on a fault; `cancelled` is a person or a newer run stopping it, so it is not counted. */
const FAILED = ["failure", "timed_out", "startup_failure"];
/** Conclusions that say nothing about the gate: a newer run cancelled it, or its jobs never ran. */
const UNDECIDED = ["cancelled", "skipped"];
/** 89 of the newest 100 land.yml runs on 10-23 04:53Z were cancelled, so gh's default of 20 can hold no decided run of a branch. */
const LAND_RUNS = 100;
/** The commit status contexts promote.yml's gates read on the staging sha (deploy-staging.mjs, release-evidence.mjs STAGING_CHECK). */
export const DEPLOY_STATUS = "deploy/staging";
export const VERIFY_STATUS = "verify-dev/probe";

export interface Commit { sha: string; at: number; title: string }
export interface Compare { mainSha: string; aheadBy: number; behindBy: number; commits: Commit[] }
export interface Run { id: number; status: string; conclusion: string; createdAt: number; branch: string; sha: string; url: string; title?: string }
export interface FailedJob { name: string; steps: string[] }
export interface Health { world: string; sha?: string; error?: string }
export interface Status { state: string; url: string }
/** The newest github-actions[bot] status of each gate context on a staging sha. */
export interface HeadStatuses { sha: string; deploy?: Status; verify?: Status }

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;
/** A staging sha's full verify judged as promote.yml judges it: miss is null when it passes the critical set, else why not; run is the verify run. */
export interface VerifyVerdict { miss: string | null; run?: number }
/** auto-sns-agent's own promote rules: judges the full verify of a staging sha against the promote's critical set for its deploy scope from main. */
export type VerifyJudge = (sha: string, mainSha: string) => Promise<VerifyVerdict>;
export interface ReachDeps { exec: Exec; fetch: typeof fetch; now: () => number; judgeVerify: VerifyJudge }

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

const RUN_FIELDS = "databaseId,status,conclusion,createdAt,headBranch,headSha,url,displayTitle";
interface RunRow { databaseId: number; status: string; conclusion: string; createdAt: string; headBranch: string; headSha: string; url: string; displayTitle?: string }
const runOf = (row: RunRow): Run => ({ id: row.databaseId, status: row.status, conclusion: row.conclusion, createdAt: Date.parse(row.createdAt),
  branch: row.headBranch, sha: row.headSha, url: row.url, ...(row.displayTitle ? { title: row.displayTitle } : {}) });

export async function readRuns(deps: ReachDeps, workflow: string, filters: readonly string[] = []): Promise<Run[]> {
  const out = await deps.exec("gh", ["run", "list", "--repo", REPO, "--workflow", workflow, ...filters, "--json", RUN_FIELDS]);
  return (JSON.parse(out) as RunRow[]).map(runOf);
}

/** The API lists a commit's statuses newest first, so the first of each context is the one promote.yml's gates take. */
export async function readHeadStatuses(deps: ReachDeps, sha: string): Promise<HeadStatuses> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/commits/${sha}/statuses?per_page=100`, "--jq",
    `[.[] | select(.creator.login == "github-actions[bot]") | {context, state, url: .target_url}]`]);
  const rows = JSON.parse(out) as { context: string; state: string; url: string }[];
  const newest = (context: string): Status | undefined => {
    const row = rows.find(item => item.context === context);
    return row ? { state: row.state, url: row.url } : undefined;
  };
  const deploy = newest(DEPLOY_STATUS);
  const verify = newest(VERIFY_STATUS);
  return { sha, ...(deploy ? { deploy } : {}), ...(verify ? { verify } : {}) };
}

/** The commit a full verify tested, from its run name "probe <sha>" (auto-sns-agent scripts/ci/is-probe.mjs). */
export const testedSha = (run: Run): string | undefined => /^probe ([0-9a-f]{40})$/.exec(run.title ?? "")?.[1];

/** A job with a failed step counts even when gh gives the job no conclusion, as land run 39915261080's "land / light" read on 10-23. */
export async function readFailedJobs(deps: ReachDeps, id: number): Promise<FailedJob[]> {
  const out = await deps.exec("gh", ["run", "view", String(id), "--repo", REPO, "--json", "jobs"]);
  const jobs = (JSON.parse(out) as { jobs: { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[] }).jobs;
  return jobs.map(job => ({ job, steps: (job.steps ?? []).filter(step => FAILED.includes(step.conclusion)).map(step => step.name) }))
    .filter(({ job, steps }) => FAILED.includes(job.conclusion) || steps.length > 0)
    .map(({ job, steps }) => ({ name: job.name, steps }));
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

const decided = (runs: readonly Run[]): Run[] =>
  runs.filter(run => run.status === "completed" && !UNDECIDED.includes(run.conclusion)).sort((a, b) => b.createdAt - a.createdAt);

/** The newest run that passed or failed, skipping cancelled and skipped ones, which say nothing about the gate. */
export const newestDecided = (runs: readonly Run[]): Run | undefined => decided(runs)[0];

/** The newest promote that passed: a failure before it was a gate a later promote passed, so failed_promotes_24h stops counting it. */
const newestPassed = (runs: readonly Run[]): Run | undefined => decided(runs).find(run => run.conclusion === "success");

/** The newest decided run of each head branch: a land runs per dev branch, so each branch's newest result is its land's state. */
export const newestPerBranch = (runs: readonly Run[]): Run[] => {
  const seen = new Map<string, Run>();
  for (const run of decided(runs)) if (!seen.has(run.branch)) seen.set(run.branch, run);
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
  /** The newest successful land.yml run, read on its own because cancelled runs crowd it out of the land list. */
  landPassed?: Run;
  /** staging-deploy.yml runs on the staging branch. */
  stagingDeploys?: Run[];
  /** The staging-only commits judged for a promote, newest first, down to the first promotable one. */
  candidates?: Candidate[];
  /** verify-dev.yml probe runs on staging, the full verifies. */
  fullVerifies?: Run[];
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
  const passed = newestPassed(reading.promotes ?? []);
  const openFailed = recentFailed.filter(run => !passed || run.createdAt > passed.createdAt);
  for (const run of reading.promotes ?? []) {
    if (run.status !== "completed") flagged.push({ at: now, kind: "promote_in_flight", item: String(run.id), excerpt: `promote run ${run.id} is ${run.status}, started ${iso(run.createdAt)}: ${run.url}` });
  }
  const newestPromote = newestDecided(reading.promotes ?? []);
  if (newestPromote) {
    const failed = FAILED.includes(newestPromote.conclusion);
    flagged.push({ at: now, kind: failed ? "promote_failed" : "promote_last", item: String(newestPromote.id),
      excerpt: `the newest decided promote, run ${newestPromote.id} from ${iso(newestPromote.createdAt)}, ended ${newestPromote.conclusion}` +
        (failed ? ` in ${jobWords(reading.failedJobs.get(newestPromote.id) ?? [])}` : "") + `: ${newestPromote.url}` });
  }
  for (const run of recentFailed) {
    if (run === newestPromote) continue;
    const after = openFailed.includes(run) ? "" : `; promote run ${passed!.id} passed its gates after it`;
    flagged.push({ at: now, kind: "promote_failed_24h", item: String(run.id), excerpt: `promote run ${run.id} from ${iso(run.createdAt)} ended ${run.conclusion} in ${jobWords(reading.failedJobs.get(run.id) ?? [])}${after}` });
  }
  for (const run of newestPerBranch(reading.lands ?? [])) {
    if (!FAILED.includes(run.conclusion)) continue;
    flagged.push({ at: now, kind: "land_failed", item: String(run.id),
      excerpt: `the newest decided land of ${run.branch}, run ${run.id} from ${iso(run.createdAt)}, ended ${run.conclusion} in ${jobWords(reading.failedJobs.get(run.id) ?? [])}: ${run.url}` });
  }
  const head = compare.commits.at(-1);
  const headWords = head ? `staging's head ${short(head.sha)} landed ${iso(head.at)}, ${hours(now, head.at)} h ago` : `staging's head is main's tip ${short(compare.mainSha)}`;
  if (reading.landPassed) {
    const run = reading.landPassed;
    flagged.push({ at: now, kind: "land_last_success", item: String(run.id),
      excerpt: `the newest successful land is run ${run.id} of ${run.branch} from ${iso(run.createdAt)}, ${hours(now, run.createdAt)} h ago, and ${headWords}: ${run.url}` });
  }
  flagged.push(...stagingDeployFlags(reading.stagingDeploys, reading.failedJobs, stagingHead, now));
  flagged.push(...promotableFlags(reading.candidates, reading.fullVerifies, reading.failedJobs, stagingHead, now));

  const unread = reading.promotes ? 0 : 1;
  const metrics: Record<string, number> = {
    oldest_fix_wait_h: oldest ? hours(now, oldest.at) : 0,
    failed_promotes_24h: Math.max(openFailed.length, unread),
    commits_on_staging_only: compare.aheadBy,
  };
  const lastFailed = openFailed.map(run => run.createdAt).sort((a, b) => b - a)[0];
  return { metrics, flagged, ...(lastFailed ? { lastEventAt: { failed_promotes_24h: lastFailed } } : {}) };
}

/** The newest staging deploy: a failed one names its job and step and whether it was staging's head, and the newest pass names the sha a walk can take. */
export function stagingDeployFlags(runs: readonly Run[] | undefined, failedJobs: ReadonlyMap<number, FailedJob[]>, stagingHead: string, now: number): FlaggedSlice[] {
  if (!runs) return [];
  const flagged: FlaggedSlice[] = [];
  for (const run of runs) {
    if (run.status !== "completed") flagged.push({ at: now, kind: "staging_deploy_in_flight", item: String(run.id), excerpt: `staging deploy run ${run.id} of ${short(run.sha)} is ${run.status}, started ${iso(run.createdAt)}: ${run.url}` });
  }
  const newest = newestDecided(runs);
  if (newest && FAILED.includes(newest.conclusion)) {
    const which = newest.sha === stagingHead ? "staging's head" : "not staging's head";
    flagged.push({ at: now, kind: "staging_deploy_failed", item: String(newest.id),
      excerpt: `the newest decided staging deploy, run ${newest.id} of ${short(newest.sha)} (${which}) from ${iso(newest.createdAt)}, ${hours(now, newest.createdAt)} h ago, ended ${newest.conclusion} in ${jobWords(failedJobs.get(newest.id) ?? [])}: ${newest.url}` });
  }
  const passed = decided(runs).find(run => run.conclusion === "success");
  const label = "staging deploy passed (not release clearance)";
  flagged.push(passed
    ? { at: now, kind: "staging_deploy_passed", item: passed.sha,
      excerpt: `${label}: the newest staging sha whose staging deploy passed is ${short(passed.sha)}, run ${passed.id} from ${iso(passed.createdAt)}, ${hours(now, passed.createdAt)} h ago: ${passed.url}` }
    : { at: now, kind: "staging_deploy_passed", excerpt: `${label}: none of the ${runs.length} listed staging deploys passed` });
  return flagged;
}

/** One staging sha judged for a promote: refusals is empty when promote.yml's gates would take it; verifyRun is its full verify. */
export interface Candidate { sha: string; refusals: string[]; verifyRun?: number }

/** Why promote.yml's gates would refuse a staging sha: its deploy/staging status, then its full verify against the promote's critical set. */
export async function judgeCandidate(statuses: HeadStatuses, mainSha: string, judgeVerify: VerifyJudge): Promise<Candidate> {
  const { sha, deploy } = statuses;
  if (!deploy) return { sha, refusals: [`it has no ${DEPLOY_STATUS} status`] };
  if (deploy.state !== "success") return { sha, refusals: [`its newest ${DEPLOY_STATUS} status is ${deploy.state}`] };
  const verdict = await judgeVerify(sha, mainSha);
  return { sha, refusals: verdict.miss ? [verdict.miss] : [], ...(verdict.run ? { verifyRun: verdict.run } : {}) };
}

const candidateWords = (candidate: Candidate) => `${short(candidate.sha)}: ${candidate.refusals.join(", and ")}`;

/** promotable names the newest staging sha both gates pass; otherwise no_promotable_staging_sha says why for each sha read, with the newest finished full verify and its red jobs. */
export function promotableFlags(candidates: readonly Candidate[] | undefined, verifies: readonly Run[] | undefined, failedJobs: ReadonlyMap<number, FailedJob[]>, stagingHead: string, now: number): FlaggedSlice[] {
  const probes = (verifies ?? []).filter(run => testedSha(run));
  const flagged: FlaggedSlice[] = [];
  for (const run of probes) {
    if (run.status !== "completed") flagged.push({ at: now, kind: "full_verify_in_flight", item: String(run.id), excerpt: `full verify run ${run.id} of ${short(testedSha(run))} is ${run.status}, started ${iso(run.createdAt)}: ${run.url}` });
  }
  const passing = (candidates ?? []).find(candidate => !candidate.refusals.length);
  const refused = (candidates ?? []).filter(candidate => candidate.refusals.length);
  if (passing) {
    const where = passing.sha === stagingHead ? "staging's head" : `staging sha, under staging's head ${short(stagingHead)}, so promote it with --sha ${passing.sha}`;
    const newer = refused.length ? `; newer staging shas are not promotable: ${refused.map(candidateWords).join("; ")}` : "";
    flagged.push({ at: now, kind: "promotable", item: passing.sha,
      excerpt: `promotable: ${short(passing.sha)} is the newest promotable ${where}: it has a successful ${DEPLOY_STATUS} status and its full verify` +
        `${passing.verifyRun ? `, run ${passing.verifyRun},` : ""} passes promote.yml's critical set${newer}` });
    return flagged;
  }
  const newest = newestDecided(probes);
  const verifyWords = newest
    ? `the newest finished full verify is run ${newest.id} of ${short(testedSha(newest))} from ${iso(newest.createdAt)}, which ended ${newest.conclusion}` +
      (FAILED.includes(newest.conclusion) ? ` in ${jobWords(failedJobs.get(newest.id) ?? [])}` : "") + `: ${newest.url}`
    : "no finished full verify is listed";
  const why = candidates ? (refused.length ? refused.map(candidateWords).join("; ") : "staging has no commit main lacks") : "the staging shas' gate statuses could not be read";
  flagged.push({ at: now, kind: "no_promotable_staging_sha", item: stagingHead,
    excerpt: `no promotable staging sha: promote.yml's gates refuse every staging sha main lacks, ${why}; ${verifyWords}` });
  return flagged;
}

/** Judges staging's commits main lacks, newest first, and stops at the first promotable one, the newest sha a promote can take. */
export async function readCandidates(deps: ReachDeps, compare: Compare): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const commit of [...compare.commits].reverse()) {
    const candidate = await judgeCandidate(await readHeadStatuses(deps, commit.sha), compare.mainSha, deps.judgeVerify);
    candidates.push(candidate);
    if (!candidate.refusals.length) break;
  }
  return candidates;
}

/** The account's home from the passwd entry, not $HOME, since the release's scoped checks run with a fresh HOME. */
export const AUTO_SNS = process.env.LLM_WIKI_REPO || join(userInfo().homedir, "Documents/Github/auto-sns-agent");
interface CiRun { id: number; status: string; conclusion: string | null }
export type GhRead = (args: readonly string[]) => Promise<string>;
export type GitRaw = (...args: string[]) => string;
export interface PromoteCi {
  githubReader(): GhRead;
  stagingCheckOf(read: GhRead, sha: string): Promise<CiRun | null>;
  jobsOf(read: GhRead, run: CiRun): Promise<unknown[]>;
  stagingCheckMiss(sha: string, check: (CiRun & { jobs?: unknown[] }) | null, what: string, flags: Record<string, boolean>): string | null;
  scopeOf(paths: string[]): Record<string, boolean>;
  changedPaths(io: { gitRaw: GitRaw }, base: string, head: string): string[];
}

/** auto-sns-agent's own scripts/ci modules the verify judge runs, loaded from its checkout. */
export async function loadPromoteCi(repo = AUTO_SNS): Promise<PromoteCi> {
  const load = async (file: string) => await import(pathToFileURL(join(repo, "scripts/ci", file)).href) as Partial<PromoteCi>;
  return Object.assign({}, ...await Promise.all(["release-evidence.mjs", "promote-preflight.mjs", "deploy-staging.mjs"].map(load))) as PromoteCi;
}

export const gitIn = (repo: string): GitRaw => (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });

/** The verify judge promote.yml's gate and the release owner's preflight use: the deploy scope of main..sha (deploy-staging.mjs), the sha's full
 *  verify with its jobs and turbo task lines (release-evidence.mjs), and stagingCheckMiss over promoteJudge (promote-preflight.mjs,
 *  promote-critical.mjs). The checkout fetches staging and main only when it lacks a sha the diff needs. */
export function verifyJudge(ci: PromoteCi, read: GhRead, git: GitRaw): VerifyJudge {
  const has = (sha: string) => { try { git("cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
  return async (sha, mainSha) => {
    if (!has(sha) || !has(mainSha)) git("fetch", "--quiet", "origin", "staging", "main");
    const flags = ci.scopeOf(ci.changedPaths({ gitRaw: git }, mainSha, sha));
    const check = await ci.stagingCheckOf(read, sha);
    const judged = check?.status === "completed" && check.conclusion !== "success" ? { ...check, jobs: await ci.jobsOf(read, check) } : check;
    const miss = ci.stagingCheckMiss(sha, judged, "sha", flags);
    return { miss: miss ? miss.split(". Dispatch once")[0]! : null, ...(check ? { run: check.id } : {}) };
  };
}

export async function measureReach(deps: ReachDeps): Promise<PrecheckOutput> {
  const now = deps.now();
  const errors: string[] = [];
  const fail = (what: string) => (error: unknown): undefined => { errors.push(`${what}: ${message(error)}`); return undefined; };
  const comparing = readCompare(deps);
  const judging = comparing.then(compare => readCandidates(deps, compare)).catch(fail("staging sha gates"));
  const [compare, candidates, fullVerifies, promotes, lands, landsPassed, stagingDeploys, ...health] = await Promise.all([
    comparing,
    judging,
    readRuns(deps, "verify-dev.yml", ["--branch", "staging", "--event", "workflow_dispatch"]).catch(fail("verify-dev.yml full verify runs")),
    readRuns(deps, "promote.yml").catch(fail("promote.yml runs")),
    readRuns(deps, "land.yml", ["--limit", String(LAND_RUNS)]).catch(fail("land.yml runs")),
    readRuns(deps, "land.yml", ["--status", "success", "--limit", "1"]).catch(fail("successful land.yml runs")),
    readRuns(deps, "staging-deploy.yml", ["--branch", "staging"]).catch(fail("staging-deploy.yml runs")),
    readHealth(deps, "staging"),
    readHealth(deps, "prod"),
  ]);
  const newestDeploy = newestDecided(stagingDeploys ?? []);
  const newestVerify = newestDecided((fullVerifies ?? []).filter(run => testedSha(run)));
  const failedRuns = [...(promotes ?? []).filter(run => run.createdAt >= now - DAY_MS), ...newestPerBranch(promotes ?? []), ...newestPerBranch(lands ?? []),
    ...(newestDeploy ? [newestDeploy] : []), ...(newestVerify ? [newestVerify] : [])]
    .filter(run => FAILED.includes(run.conclusion));
  const failedJobs = new Map<number, FailedJob[]>();
  await Promise.all([...new Set(failedRuns.map(run => run.id))].map(async id => {
    const jobs = await readFailedJobs(deps, id).catch(fail(`jobs of run ${id}`));
    if (jobs) failedJobs.set(id, jobs);
  }));
  return reachMetrics({ compare, ...(promotes ? { promotes } : {}), ...(lands ? { lands } : {}), ...(landsPassed?.[0] ? { landPassed: landsPassed[0] } : {}),
    ...(stagingDeploys ? { stagingDeploys } : {}), ...(candidates ? { candidates } : {}), ...(fullVerifies ? { fullVerifies } : {}), failedJobs, health, errors }, now);
}

const exec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8" },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 2).join(" ")}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("fixes-reach-prod: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measureReach({ exec, fetch, now: Date.now, judgeVerify: await loadPromoteCi().then(ci => verifyJudge(ci, ci.githubReader(), gitIn(AUTO_SNS))) }), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
