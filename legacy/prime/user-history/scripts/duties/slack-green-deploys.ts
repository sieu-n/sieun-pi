import { execFile } from "node:child_process";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";

/**
 * The deploy reader of slack green guy's Slack Green services work duty (slack-green-services.ts), which folded in the Slack green deploys
 * duty (d4) on 10-30. No model call. Since 11-04 the email worker runs on us-metal01 as the compose service slack-green-worker in
 * /srv/slack-green/compose.yml (ops guy's p737 took it off Railway), from the image ghcr.io/sieu-n/slack-green/worker:<main sha>. The
 * "Worker image" job of slack-green's ci.yml pushes that image when a main push changed the backend, so most main commits push none.
 * worker_not_live is 1 when main's newest successful Worker image push is not the sha the container runs DEPLOY_MINUTES after the push ended.
 * The duty never deploys the worker, because the metal box owner runs compose on us-metal01 (c146).
 * vercel_not_live counts main commits pushed over DEPLOY_MINUTES ago that Vercel production lacks. A commit is live there when the commit
 * Vercel runs contains it, and GitHub's compare API lists the main commits the live commit lacks, which also covers a live commit that is not
 * on main. A source that fails makes the headline at least 1, because an unmeasured state is not a good one.
 * Its one supporting metric, main_checks_failed_24h, counts the slack-green main commits whose push CI run (ci.yml) started in the last 24 h
 * and ended failed, cancelled or timed out, because main's checks broke four times from Oct 9 to Oct 18 (board step p180). Each one is
 * flagged with its failed job, step and link, and the step says whose fix it is: the runner's setup or its job-started hook (the M1 Air's disk
 * floor) is VP of CI's, any other step is the repo's.
 */

export const REPO = "sieu-n/slack-green";
const VERCEL_TEAM = "team_HkFeqFbbJa5UAIjN0IYINUS0";
const VERCEL_PROJECT = "prj_Fg9XulbXkvMu6jmDIeGK8tb2DsvG";
/**
 * How long a push may take to reach production before it counts as not live. The owner's brief asked for 20 minutes (2026-10-14). Measured:
 * 40 Vercel production builds took 1.3 min median and 1.8 min at most. The worker's clock starts when its image push ends.
 */
export const DEPLOY_MINUTES = 20;
const MINUTE = 60_000;
/** The ci.yml job that pushes ghcr.io/sieu-n/slack-green/worker:<sha> on main. */
export const WORKER_IMAGE_JOB = "Worker image";
/** At most this many main runs newer than the container's commit get their jobs read for an image push. */
const IMAGE_RUNS = 30;

/** A slack-green main commit with its committer time (the merge time for a squash merge). */
export interface Commit { sha: string; at: number }
/** One deployment as Vercel lists it. */
export interface Deploy { status: string; at: number; sha?: string | undefined }
/** Vercel production: the commit it runs, its recent deployments, and the main commits that commit lacks, oldest first. */
export interface Side { live: string; deploys: Deploy[]; behind: Commit[] }
/** A main CI run whose Worker image job pushed an image: its commit, when the job ended, and the job's link. */
export interface ImagePush { sha: string; at: number; url: string }
/** The worker's commit, and main's newest image push when the container does not run it (null when it does). */
export interface WorkerSide { live: string; newest: ImagePush | null }
/**
 * One slack-green main CI run (ci.yml) as `gh run list` gives it: `at` its start, `end` its last update, `event` push or workflow_dispatch.
 * `conclusion` is empty while the run is not done.
 */
export interface CiRun { id: number; sha: string; event: string; at: number; end: number; conclusion: string; url: string }
/** One job of a run as `gh run view --json jobs` gives it, with each step's conclusion. */
export interface CiJob { name: string; conclusion: string; completedAt?: string | undefined; url?: string | undefined; steps: { name: string; conclusion: string }[] }
/**
 * A failed main run with whose fix it is. `runner`: the runner failed before or after the repo's own steps (setup, the job-started hook that
 * holds the disk floor, or a job that never got steps), which VP of CI fixes. `repo`: a repo step failed. `unknown`: its jobs did not read.
 */
export interface CheckFailure { run: CiRun; side: "runner" | "repo" | "unknown"; job?: string | undefined; step?: string | undefined; url: string; error?: string | undefined }
export interface Sources { worker?: WorkerSide; vercel?: Side; checks?: CheckFailure[]; checkRuns?: number; errors: string[] }

const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const age = (at: number, now: number) => Math.floor((now - at) / MINUTE);

/** Vercel's missing commits split by age: `late` are past DEPLOY_MINUTES and count against the headline, `pending` are still on their way. */
export function standing(behind: readonly Commit[], now: number): { late: Commit[]; pending: Commit[] } {
  return { late: behind.filter(commit => age(commit.at, now) >= DEPLOY_MINUTES), pending: behind.filter(commit => age(commit.at, now) < DEPLOY_MINUTES) };
}

/** What Vercel did with one commit: its newest deployment's status, or that it has none. */
const fate = (deploys: readonly Deploy[], sha: string): string =>
  deploys.filter(deploy => deploy.sha === sha).sort((a, b) => b.at - a.at)[0]?.status ?? "no deployment";

const LISTED = 8;

export function describe(state: Side, commits: readonly Commit[], now: number): string {
  const listed = commits.slice(0, LISTED).map(commit => `${short(commit.sha)} (${age(commit.at, now)} min after its push, ${fate(state.deploys, commit.sha)})`);
  const more = commits.length > LISTED ? ` and ${commits.length - LISTED} more` : "";
  return `Vercel production runs ${short(state.live)}, which lacks ${listed.join(", ")}${more}`;
}

/** The worker's slice and whether it counts: its newest image push missing past DEPLOY_MINUTES is late, sooner it is pending. */
export function workerStanding(worker: WorkerSide, now: number): { late: boolean; slice: FlaggedSlice } {
  const { live, newest } = worker;
  const where = `the us-metal01 worker runs ${short(live)}`;
  if (!newest) return { late: false, slice: { at: now, kind: "worker_ok", excerpt: `${where}, main's newest Worker image` } };
  const late = age(newest.at, now) >= DEPLOY_MINUTES;
  return { late, slice: { at: now, kind: late ? "worker_not_live" : "worker_pending",
    excerpt: `${where}, but main's newest Worker image ${short(newest.sha)} was pushed ${age(newest.at, now)} min ago (${newest.url})` } };
}

/**
 * main_checks_failed_24h's `lastEventAt` is the newest end of a failed run it counts, or this run when the run list failed, and none with no failed
 * run. AI harness d9 read it as a lagging window on 10-22 because it had none.
 */
export function deployMetrics(sources: Sources, now: number): { metrics: Record<string, number>; flagged: FlaggedSlice[]; lastEventAt?: Record<string, number> } {
  const flagged: FlaggedSlice[] = sources.errors.map(error => ({ at: now, kind: "source_error",
    excerpt: `${error}. The headline counts this run as a miss until the precheck or its login is fixed.` }));
  let workerLate = 0;
  if (sources.worker) {
    const { late, slice } = workerStanding(sources.worker, now);
    workerLate = Number(late);
    flagged.push(slice);
  }
  let vercelLate = 0;
  const vercel = sources.vercel;
  if (vercel) {
    const { late, pending } = standing(vercel.behind, now);
    vercelLate = late.length;
    flagged.push(late.length
      ? { at: now, kind: "vercel_not_live", excerpt: describe(vercel, late, now) }
      : { at: now, kind: "vercel_ok", excerpt: `Vercel production runs ${short(vercel.live)}, which has every main commit over ${DEPLOY_MINUTES} min old` });
    if (pending.length) flagged.push({ at: now, kind: "vercel_pending", excerpt: describe(vercel, pending, now) });
  }
  for (const failure of sources.checks ?? []) flagged.push({ at: now, kind: `main_checks_${failure.side}`, excerpt: describeFailure(failure) });
  if (sources.checks && !sources.checks.length) flagged.push({ at: now, kind: "main_checks_ok",
    excerpt: `all ${sources.checkRuns ?? 0} finished main push CI runs of the last 24 h passed` });
  const failedCommits = sources.checks ? new Set(sources.checks.map(failure => failure.run.sha)).size : 1;
  const failedAt = !sources.checks ? now : sources.checks.length ? Math.max(...sources.checks.map(failure => failure.run.end)) : undefined;
  return { metrics: { worker_not_live: workerLate, vercel_not_live: vercelLate, main_checks_failed_24h: failedCommits, source_errors: sources.errors.length }, flagged,
    ...failedAt === undefined ? {} : { lastEventAt: { main_checks_failed_24h: failedAt } } };
}

/** Run conclusions that count as broken checks. ci.yml cancels only PR runs for a newer push, so a cancelled main run is a timeout or a stop. */
export const CHECKS_FAILED = ["failure", "cancelled", "timed_out", "startup_failure"];
export const CHECKS_WINDOW_MS = 24 * 60 * MINUTE;
/** Steps GitHub and the runner own. "Set up runner" runs the job-started hook, which fails the job when the M1 Air is under its disk floor. */
export const RUNNER_STEPS = ["Set up job", "Set up runner", "Complete runner", "Complete job"];

/** The main push runs that started in the last 24 h. A workflow_dispatch run is read only for its Worker image push. */
const dayPushRuns = (runs: readonly CiRun[], now: number): CiRun[] => runs.filter(run => run.event === "push" && run.at > now - CHECKS_WINDOW_MS);

/** The failed main push runs that started in the last 24 h, newest first. A run still going is not counted yet. */
export function failedMainRuns(runs: readonly CiRun[], now: number): CiRun[] {
  return dayPushRuns(runs, now).filter(run => CHECKS_FAILED.includes(run.conclusion)).sort((a, b) => b.at - a.at);
}

/** Whose fix a failed run is: its first failed job's first failed step names the side. A failed job with no failed step is the runner's. */
export function classifyFailure(run: CiRun, jobs: readonly CiJob[]): CheckFailure {
  const job = jobs.find(item => CHECKS_FAILED.includes(item.conclusion));
  if (!job) return { run, side: "unknown", url: run.url, error: "no job of the run failed" };
  const step = job.steps.find(item => CHECKS_FAILED.includes(item.conclusion));
  const side = !step || RUNNER_STEPS.includes(step.name) ? "runner" : "repo";
  return { run, side, job: job.name, step: step?.name, url: job.url ?? run.url };
}

export function describeFailure(failure: CheckFailure): string {
  const { run } = failure;
  const where = failure.job ? `job ${failure.job} failed at ${failure.step ? `step "${failure.step}"` : "no step (the runner never ran it)"}` : `its jobs did not read (${failure.error ?? "?"})`;
  const whose = failure.side === "runner" ? "runner side, so VP of CI fixes it" : failure.side === "repo" ? "repo side, so one fix job takes it" : "side unknown, read the run";
  return `main ${short(run.sha)}'s CI run ${run.id} ended ${run.conclusion}: ${where}; ${whose}. ${failure.url}`;
}

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;
export interface DeployDeps { exec: Exec; fetch: typeof fetch; now: () => number; vercelToken: () => Promise<string> }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***");

/** The main commits `live` lacks, oldest first: GitHub's compare of live...main, which also handles a live commit that is not on main. */
export async function readBehind(deps: DeployDeps, live: string): Promise<Commit[]> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/compare/${live}...main`, "--jq", "[.commits[] | {sha, at: .commit.committer.date}]"]);
  return (JSON.parse(out) as { sha: string; at: string }[]).map(commit => ({ sha: commit.sha, at: Date.parse(commit.at) }));
}

/** slack-green's main runs of ci.yml, pushes and dispatches, newest 100, which covers far more than a day of pushes. */
export async function readMainRuns(deps: DeployDeps): Promise<CiRun[]> {
  const out = await deps.exec("gh", ["run", "list", "--repo", REPO, "--branch", "main", "--workflow", "ci.yml", "--limit", "100",
    "--json", "databaseId,headSha,event,conclusion,createdAt,updatedAt,url"]);
  return (JSON.parse(out) as { databaseId: number; headSha: string; event: string; conclusion: string; createdAt: string; updatedAt: string; url: string }[])
    .map(row => ({ id: row.databaseId, sha: row.headSha, event: row.event, at: Date.parse(row.createdAt), end: Date.parse(row.updatedAt), conclusion: row.conclusion ?? "", url: row.url }));
}

export async function readJobs(deps: DeployDeps, run: number): Promise<CiJob[]> {
  return (JSON.parse(await deps.exec("gh", ["run", "view", String(run), "--repo", REPO, "--json", "jobs"])) as { jobs: CiJob[] }).jobs;
}

/** The failed main push runs of the last 24 h with whose fix each is; a run whose jobs do not read still counts, with side unknown. */
export async function readCheckFailures(deps: DeployDeps, runs: readonly CiRun[], now: number): Promise<{ failures: CheckFailure[]; finished: number }> {
  const finished = dayPushRuns(runs, now).filter(run => run.conclusion).length;
  const failures = await Promise.all(failedMainRuns(runs, now).map(run => readJobs(deps, run.id).then(jobs => classifyFailure(run, jobs),
    (error: unknown): CheckFailure => ({ run, side: "unknown", url: run.url, error: message(error) }))));
  return { failures, finished };
}

/**
 * main's newest Worker image push when the container at `live` lacks it, or null when the container runs it. Only the runs newer than the
 * newest run of `live` are read, at most IMAGE_RUNS, because a run that pushed nothing has a skipped Worker image job.
 */
export async function newestImagePush(deps: DeployDeps, runs: readonly CiRun[], live: string): Promise<ImagePush | null> {
  const newestFirst = [...runs].sort((a, b) => b.at - a.at);
  const own = newestFirst.findIndex(run => run.sha === live);
  const newer = (own === -1 ? newestFirst : newestFirst.slice(0, own)).slice(0, IMAGE_RUNS);
  const jobs = await Promise.all(newer.map(run => readJobs(deps, run.id)));
  for (const [index, run] of newer.entries()) {
    const job = jobs[index]!.find(item => item.name === WORKER_IMAGE_JOB && item.conclusion === "success");
    if (job) return { sha: run.sha, at: job.completedAt ? Date.parse(job.completedAt) : run.end, url: job.url ?? run.url };
  }
  if (own === -1) throw new Error(`none of main's newest ${newer.length} CI runs pushed a Worker image or ran the container's ${short(live)}`);
  return null;
}

async function vercelGet<T>(deps: DeployDeps, path: string): Promise<T> {
  const response = await deps.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM}`, { headers: { Authorization: `Bearer ${await deps.vercelToken()}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vercel ${path.split("?")[0]} gave HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T;
}

interface VercelRow { state?: string; readyState?: string; created: number; meta?: { githubCommitSha?: string } }

export async function readVercel(deps: DeployDeps): Promise<Side> {
  const project = await vercelGet<{ targets?: { production?: { meta?: { githubCommitSha?: string } } } }>(deps, `/v9/projects/${VERCEL_PROJECT}`);
  const list = await vercelGet<{ deployments: VercelRow[] }>(deps, `/v6/deployments?projectId=${VERCEL_PROJECT}&target=production&limit=20`);
  const live = project.targets?.production?.meta?.githubCommitSha;
  if (!live) throw new Error("Vercel production has no GitHub commit");
  return { live, behind: await readBehind(deps, live), deploys: list.deployments.map(row => ({ status: row.state ?? row.readyState ?? "?", at: row.created, sha: row.meta?.githubCommitSha })) };
}

/**
 * Reads Vercel, main's CI runs and the worker's image pushes. `workerSha` is the main sha the us-metal01 container runs; the services precheck
 * leaves it out when its worker read failed, and counts that failure itself.
 */
export async function measureDeploys(deps: DeployDeps, workerSha: string | undefined): Promise<PrecheckOutput> {
  const now = deps.now();
  const sources: Sources = { errors: [] };
  const fail = (what: string) => (error: unknown): undefined => { sources.errors.push(`${what}: ${message(error)}`); return undefined; };
  const runs = await readMainRuns(deps).catch(fail("GitHub main CI runs"));
  const [vercel, checks, newest] = await Promise.all([
    readVercel(deps).catch(fail("Vercel production")),
    runs && readCheckFailures(deps, runs, now),
    runs && workerSha ? newestImagePush(deps, runs, workerSha).catch(fail("main's Worker image pushes")) : undefined,
  ]);
  if (vercel) sources.vercel = vercel;
  if (checks) { sources.checks = checks.failures; sources.checkRuns = checks.finished; }
  if (workerSha && newest !== undefined) sources.worker = { live: workerSha, newest };
  return deployMetrics(sources, now);
}

/** Each command stops 10 s before the runner's PRECHECK_TARGET_MS, so a hung call still ends as a source error with every metric written. */
const COMMAND_TIMEOUT_MS = PRECHECK_TARGET_MS - 10_000;
export const exec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args[0] ?? ""}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});
