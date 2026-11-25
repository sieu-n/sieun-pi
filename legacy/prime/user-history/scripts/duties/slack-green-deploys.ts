import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";
import { retryingExec } from "./connection-retry.ts";

/**
 * The deploy reader of slack green guy's Slack Green services work duty (slack-green-services.ts), which folded in the Slack green deploys
 * duty (d4) on 10-30. No model call. commits_not_live counts slack-green main commits pushed over DEPLOY_MINUTES ago that are not live on the
 * worker or on Vercel production. Since 11-25 the worker runs as Komodo Stack slack-green on us-metal01 instead of Railway. slack-green's CI
 * publishes ghcr.io/sieu-n/slack-green/worker:<commit> for each main commit that changes the backend and moves :main to it when it is still
 * main's tip, and Komodo redeploys the Stack on a new :main digest within about 3 min. So the worker owes a commit once a worker image is
 * published for it, and the commit it runs is its container's org.opencontainers.image.revision label. A commit is live on a side when the
 * commit that side runs contains it; GitHub's compare API lists the main commits the live commit lacks, which also covers a live commit that
 * is not on main. A source that fails makes the headline at least 1, because an unmeasured state is not a good one.
 * This precheck deploys nothing. slack-green's CI Vercel deploy job (slack-green #299) calls the project's deploy hook when Vercel starts
 * nothing for a main push that ran CI, as for 9db2437 (#298) on 2026-10-19. A commit still missing here past DEPLOY_MINUTES most likely got
 * no push event (9ad6c68, 2026-09-29), which the duty job fixes with an empty commit through a PR.
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
 * the main CI run on the M1 Air took 9.4 and 10.2 min (runs 38287317331, 38289995168), and the worker image is published at its end; 40 Vercel
 * production builds took 1.3 min median and 1.8 min at most.
 */
export const DEPLOY_MINUTES = 20;
const MINUTE = 60_000;
export const WORKER_IMAGE_PUBLISHED = "worker image published";

/** A slack-green main commit with its committer time (the merge time for a squash merge). */
export interface Commit { sha: string; at: number }
/** One deployment as Vercel lists it, or one worker image as ghcr lists it (status WORKER_IMAGE_PUBLISHED, `at` its push time). */
export interface Deploy { status: string; at: number; sha?: string | undefined }
/** One side of production: the commit it runs, its recent deployments or images, and the main commits that commit lacks, oldest first. */
export interface Side { live: string; deploys: Deploy[]; behind: Commit[] }
export type SideName = "worker" | "vercel";
/** One slack-green main push CI run (ci.yml) as `gh run list` gives it: `at` its start, `end` its last update. `conclusion` is empty while the run is not done. */
export interface CiRun { id: number; sha: string; at: number; end: number; conclusion: string; url: string }
/** One job of a run as `gh run view --json jobs` gives it, with each step's conclusion. */
export interface CiJob { name: string; conclusion: string; url?: string | undefined; steps: { name: string; conclusion: string }[] }
/**
 * A failed main run with whose fix it is. `runner`: the runner failed before or after the repo's own steps (setup, the job-started hook that
 * holds the disk floor, or a job that never got steps), which VP of CI fixes. `repo`: a repo step failed. `unknown`: its jobs did not read.
 */
export interface CheckFailure { run: CiRun; side: "runner" | "repo" | "unknown"; job?: string | undefined; step?: string | undefined; url: string; error?: string | undefined }
export interface Sources { worker?: Side; vercel?: Side; checks?: CheckFailure[]; checkRuns?: number; errors: string[] }

const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const age = (commit: Commit, now: number) => Math.floor((now - commit.at) / MINUTE);
const latestFor = (deploys: readonly Deploy[], sha: string) => deploys.filter(deploy => deploy.sha === sha).sort((a, b) => b.at - a.at)[0];

/** The commits a side should run: all for Vercel, only those CI published a worker image for on the worker. */
const owed = (side: SideName, state: Side) => side === "vercel" ? [...state.behind]
  : state.behind.filter(commit => state.deploys.some(image => image.sha === commit.sha));

/** The owed commits split by age: `late` are past DEPLOY_MINUTES and count against the headline, `pending` are still on their way. */
export function standing(side: SideName, state: Side, now: number): { late: Commit[]; pending: Commit[] } {
  const commits = owed(side, state);
  return { late: commits.filter(commit => age(commit, now) >= DEPLOY_MINUTES), pending: commits.filter(commit => age(commit, now) < DEPLOY_MINUTES) };
}

/** What the platform did with one commit: its newest deployment's or image's status, or that it has none. */
const fate = (deploys: readonly Deploy[], sha: string): string => latestFor(deploys, sha)?.status ?? "no deployment";

const PLATFORM = { worker: "the Komodo worker (Stack slack-green)", vercel: "Vercel production" } as const;
const LISTED = 8;

export function describe(side: SideName, state: Side, commits: readonly Commit[], now: number): string {
  const listed = commits.slice(0, LISTED).map(commit => `${short(commit.sha)} (${age(commit, now)} min after its push, ${fate(state.deploys, commit.sha)})`);
  const more = commits.length > LISTED ? ` and ${commits.length - LISTED} more` : "";
  return `${PLATFORM[side]} runs ${short(state.live)}, which lacks ${listed.join(", ")}${more}`;
}

/**
 * main_checks_failed_24h's `lastEventAt` is the newest end of a failed run it counts, or this run when the run list failed, and none with no failed
 * run. AI harness d9 read it as a lagging window on 10-22 because it had none.
 */
export function deployMetrics(sources: Sources, now: number): { metrics: Record<string, number>; flagged: FlaggedSlice[]; lastEventAt?: Record<string, number> } {
  const flagged: FlaggedSlice[] = sources.errors.map(error => ({ at: now, kind: "source_error",
    excerpt: `${error}. The headline counts this run as a miss until the precheck or its login is fixed.` }));
  const notLive = new Set<string>();
  const counts = { worker: 0, vercel: 0 };
  for (const side of ["worker", "vercel"] as const) {
    const state = sources[side];
    if (!state) continue;
    const { late, pending } = standing(side, state, now);
    counts[side] = late.length;
    for (const commit of late) notLive.add(commit.sha);
    flagged.push(late.length
      ? { at: now, kind: `${side}_not_live`, excerpt: describe(side, state, late, now) }
      : { at: now, kind: `${side}_ok`, excerpt: `${PLATFORM[side]} runs ${short(state.live)}, which has every main commit over ${DEPLOY_MINUTES} min old it should run` });
    if (pending.length) flagged.push({ at: now, kind: `${side}_pending`, excerpt: describe(side, state, pending, now) });
  }
  for (const failure of sources.checks ?? []) flagged.push({ at: now, kind: `main_checks_${failure.side}`, excerpt: describeFailure(failure) });
  if (sources.checks && !sources.checks.length) flagged.push({ at: now, kind: "main_checks_ok",
    excerpt: `all ${sources.checkRuns ?? 0} finished main push CI runs of the last 24 h passed` });
  const errors = sources.errors.length;
  const failedCommits = sources.checks ? new Set(sources.checks.map(failure => failure.run.sha)).size : 1;
  const failedAt = !sources.checks ? now : sources.checks.length ? Math.max(...sources.checks.map(failure => failure.run.end)) : undefined;
  return { metrics: { commits_not_live: errors ? Math.max(notLive.size, 1) : notLive.size, main_checks_failed_24h: failedCommits,
    worker_not_live: counts.worker, vercel_not_live: counts.vercel, source_errors: errors }, flagged,
    ...failedAt === undefined ? {} : { lastEventAt: { main_checks_failed_24h: failedAt } } };
}

/**
 * Run conclusions that count as broken checks. ci.yml's Vercel deploy job shares the vercel-production group, so a newer main merge cancels an older
 * deploy still waiting there; dropFixed drops that cancel once a newer run passes the job.
 */
export const CHECKS_FAILED = ["failure", "cancelled", "timed_out", "startup_failure"];
export const CHECKS_WINDOW_MS = 24 * 60 * MINUTE;
/** Steps GitHub and the runner own. "Set up runner" runs the job-started hook, which fails the job when the M1 Air is under its disk floor. */
export const RUNNER_STEPS = ["Set up job", "Set up runner", "Complete runner", "Complete job"];

/** The failed main runs that started in the last 24 h, newest first. A run still going is not counted yet. */
export function failedMainRuns(runs: readonly CiRun[], now: number): CiRun[] {
  return runs.filter(run => run.at > now - CHECKS_WINDOW_MS && CHECKS_FAILED.includes(run.conclusion)).sort((a, b) => b.at - a.at);
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
export type Exec = (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<string>;
export interface DeployDeps extends KomodoDeps { exec: Exec; now: () => number; vercelToken: () => Promise<string> }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***");

/** The main commits `live` lacks, oldest first: GitHub's compare of live...main, which also handles a live commit that is not on main. */
export async function readBehind(deps: DeployDeps, live: string): Promise<Commit[]> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/compare/${live}...main`, "--jq", "[.commits[] | {sha, at: .commit.committer.date}]"]);
  return (JSON.parse(out) as { sha: string; at: string }[]).map(commit => ({ sha: commit.sha, at: Date.parse(commit.at) }));
}

/** slack-green's main push runs of ci.yml, newest 100, which covers far more than a day of pushes. */
export async function readMainRuns(deps: DeployDeps): Promise<CiRun[]> {
  const out = await deps.exec("gh", ["run", "list", "--repo", REPO, "--branch", "main", "--workflow", "ci.yml", "--event", "push", "--limit", "100",
    "--json", "databaseId,headSha,conclusion,createdAt,updatedAt,url"]);
  return (JSON.parse(out) as { databaseId: number; headSha: string; conclusion: string; createdAt: string; updatedAt: string; url: string }[])
    .map(row => ({ id: row.databaseId, sha: row.headSha, at: Date.parse(row.createdAt), end: Date.parse(row.updatedAt), conclusion: row.conclusion ?? "", url: row.url }));
}

export async function readJobs(deps: DeployDeps, run: number): Promise<CiJob[]> {
  return (JSON.parse(await deps.exec("gh", ["run", "view", String(run), "--repo", REPO, "--json", "jobs"])) as { jobs: CiJob[] }).jobs;
}

/** The failed main runs of the last 24 h with whose fix each is; a run whose jobs do not read still counts, with side unknown. */
export async function readCheckFailures(deps: DeployDeps, now: number): Promise<{ failures: CheckFailure[]; finished: number }> {
  const runs = await readMainRuns(deps);
  const finished = runs.filter(run => run.at > now - CHECKS_WINDOW_MS && run.conclusion).length;
  const failures = await Promise.all(failedMainRuns(runs, now).map(run => readJobs(deps, run.id).then(jobs => classifyFailure(run, jobs),
    (error: unknown): CheckFailure => ({ run, side: "unknown", url: run.url, error: message(error) }))));
  return { failures: await dropFixed(deps, runs, failures), finished };
}

/**
 * The failures no newer main run fixed. A failure is fixed once a newer passed main run passed the job that failed. On 2026-11-04 d6 still counted 10
 * such runs: 5 Vercel deploys the vercel-production group cancelled for a newer merge, and 5 render-check failures that #463 fixed at 07:45Z.
 * Passed runs are read newest first, and the read stops once every failed job has its newest pass.
 */
export async function dropFixed(deps: DeployDeps, runs: readonly CiRun[], failures: CheckFailure[]): Promise<CheckFailure[]> {
  const newestPass = new Map<string, number>();
  const open = () => failures.filter(failure => failure.job !== undefined && !newestPass.has(failure.job));
  for (const run of runs.filter(item => item.conclusion === "success").sort((a, b) => b.at - a.at)) {
    if (!open().some(failure => run.at > failure.run.at)) break;
    const jobs = await readJobs(deps, run.id).catch(() => [] as CiJob[]);
    for (const job of jobs) if (job.conclusion === "success" && !newestPass.has(job.name)) newestPass.set(job.name, run.at);
  }
  return failures.filter(failure => failure.job === undefined || (newestPass.get(failure.job) ?? 0) <= failure.run.at);
}

/** The Komodo service user slack-green-ci, which may read, inspect and read logs of Stack slack-green and nothing else. */
export interface KomodoLogin { key: string; secret: string }
export const KOMODO_CORE = "https://us-metal01.tail0c093d.ts.net:12443";
export const WORKER_STACK = { stack: "slack-green", service: "slack-green-worker" } as const;
const AUTO_SNS = join(homedir(), "Documents/Github/auto-sns-agent");

/** One value of auto-sns-agent's prod infra tier apps/infra/.env, which variables.mjs reads to set the Komodo Variables of Stack slack-green. */
export async function infraSecret(name: string, run: Exec = exec): Promise<string> {
  const value = (await run(join(AUTO_SNS, "node_modules/.bin/dotenvx"), ["get", name, "-f", join(AUTO_SNS, "apps/infra/.env")], { cwd: AUTO_SNS })).trim();
  if (!value || value.startsWith("encrypted:")) throw new Error(`${name} did not decrypt from auto-sns-agent apps/infra/.env`);
  return value;
}

/** The slack-green-ci key. */
export async function komodoLogin(run: Exec = exec): Promise<KomodoLogin> {
  return { key: await infraSecret("SLACK_GREEN_KOMODO_API_KEY", run), secret: await infraSecret("SLACK_GREEN_KOMODO_API_SECRET", run) };
}

export interface KomodoDeps { fetch: typeof fetch; komodo: () => Promise<KomodoLogin> }
/** One Komodo read API call: POST {core}/read/<op> with the key pair in its headers. */
export async function komodoRead<T>(deps: KomodoDeps, op: string, body: unknown): Promise<T> {
  const login = await deps.komodo();
  const response = await deps.fetch(`${KOMODO_CORE}/read/${op}`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-api-key": login.key, "x-api-secret": login.secret }, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Komodo ${op} answered HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** The worker container as docker inspect gives it, through Komodo. */
export interface WorkerContainer { RestartCount?: number; Config?: { Labels?: Record<string, string> };
  State?: { Status?: string; Running?: boolean; Restarting?: boolean; StartedAt?: string } }
export const readWorkerContainer = (deps: KomodoDeps) => komodoRead<WorkerContainer>(deps, "InspectStackContainer", WORKER_STACK);

/** The commit the worker runs: the revision label build_worker_image.py writes into each worker image. */
export function workerRevision(container: WorkerContainer): string {
  const revision = container.Config?.Labels?.["org.opencontainers.image.revision"];
  if (!revision) throw new Error(`the ${WORKER_STACK.service} container has no org.opencontainers.image.revision label`);
  return revision;
}

/** The worker images CI published, one per commit tag, from the newest 100 package versions, which cover weeks of backend merges. */
export async function readWorkerImages(deps: DeployDeps): Promise<Deploy[]> {
  const out = await deps.exec("gh", ["api", "/users/sieu-n/packages/container/slack-green%2Fworker/versions?per_page=100",
    "--jq", "[.[] | {at: .created_at, tags: .metadata.container.tags}]"]);
  return (JSON.parse(out) as { at: string; tags: string[] }[]).flatMap(version => version.tags.filter(tag => /^[0-9a-f]{40}$/.test(tag))
    .map(sha => ({ status: WORKER_IMAGE_PUBLISHED, at: Date.parse(version.at), sha })));
}

async function vercelGet<T>(deps: DeployDeps, path: string): Promise<T> {
  const response = await deps.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM}`, { headers: { Authorization: `Bearer ${await deps.vercelToken()}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vercel ${path.split("?")[0]} gave HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T;
}

interface VercelRow { state?: string; readyState?: string; created: number; meta?: { githubCommitSha?: string } }

export async function readVercel(deps: DeployDeps): Promise<{ live: string; deploys: Deploy[] }> {
  const project = await vercelGet<{ targets?: { production?: { meta?: { githubCommitSha?: string } } } }>(deps, `/v9/projects/${VERCEL_PROJECT}`);
  const list = await vercelGet<{ deployments: VercelRow[] }>(deps, `/v6/deployments?projectId=${VERCEL_PROJECT}&target=production&limit=20`);
  const live = project.targets?.production?.meta?.githubCommitSha;
  if (!live) throw new Error("Vercel production has no GitHub commit");
  return { live, deploys: list.deployments.map(row => ({ status: row.state ?? row.readyState ?? "?", at: row.created, sha: row.meta?.githubCommitSha })) };
}

export async function measureDeploys(deps: DeployDeps): Promise<PrecheckOutput> {
  const now = deps.now();
  const sources: Sources = { errors: [] };
  const fail = (what: string) => (error: unknown): undefined => { sources.errors.push(`${what}: ${message(error)}`); return undefined; };
  const side = async (name: string, read: () => Promise<{ live: string; deploys: Deploy[] }>): Promise<Side | undefined> => {
    const platform = await read().catch(fail(name));
    const behind = platform && await readBehind(deps, platform.live).catch(fail(`GitHub main commits missing from ${name}'s ${short(platform.live)}`));
    return platform && behind ? { ...platform, behind } : undefined;
  };
  const [worker, vercel, checks] = await Promise.all([
    side("Komodo worker", async () => ({ live: workerRevision(await readWorkerContainer(deps)), deploys: await readWorkerImages(deps) })),
    side("Vercel production", () => readVercel(deps)),
    readCheckFailures(deps, now).catch(fail("GitHub main CI runs")),
  ]);
  if (worker) sources.worker = worker;
  if (vercel) sources.vercel = vercel;
  if (checks) { sources.checks = checks.failures; sources.checkRuns = checks.finished; }
  return deployMetrics(sources, now);
}

/** Each command stops 10 s before the runner's PRECHECK_TARGET_MS, so a hung call still ends as a source error with every metric written. */
const COMMAND_TIMEOUT_MS = PRECHECK_TARGET_MS - 10_000;
const execOnce: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, cwd: options?.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args[0] ?? ""}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});
/** A gh call that could not connect, such as gh's "error connecting to api.github.com" on 11-09, runs once more. */
export const exec: Exec = retryingExec(execOnce);
