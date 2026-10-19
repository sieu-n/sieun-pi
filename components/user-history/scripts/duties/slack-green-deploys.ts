import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";

/**
 * The slack green guy's Slack green deploys duty's precheck (`node --import tsx scripts/duties/slack-green-deploys.ts`). No model call.
 * Its headline, commits_not_live, counts slack-green main commits pushed over DEPLOY_MINUTES ago that are not live on the Railway worker
 * (when the commit changes a railway.toml watch path) or on Vercel production. A commit is live on a side when the commit that side runs
 * contains it, so the count reads the real state whoever deployed: Railway's GitHub trigger, the CI Backend job's deploy_worker.py
 * (slack-green #253), or this precheck. GitHub's compare API lists the main commits the live commit lacks, which also covers a live commit
 * that is not on main. A source that fails makes the headline at least 1, because an unmeasured state is not a good one.
 * When the worker misses a commit past DEPLOY_MINUTES, this precheck deploys main's head to it once per head commit, through the same
 * serviceInstanceDeployV2 call the approved merges job used by hand for #233 (4222b4b, 2026-10-14), and flags it. Vercel is never redeployed
 * here: a missing Vercel deployment means GitHub sent no push event, which the duty job fixes with an empty commit through a PR.
 */

export const REPO = "sieu-n/slack-green";
/** Railway project slack-green-backend, environment production, service slack-green-backend (`railway environment config --json`). */
export const RAILWAY = { environmentId: "c10f04dd-8694-406f-aeb3-3872b3c3ab36", serviceId: "1d922935-9d01-4946-9451-cda91e22792b" };
const VERCEL_TEAM = "team_HkFeqFbbJa5UAIjN0IYINUS0";
const VERCEL_PROJECT = "prj_Fg9XulbXkvMu6jmDIeGK8tb2DsvG";
/**
 * How long a push may take to reach production before it counts as not live. The owner's brief asked for 20 minutes (2026-10-14). Measured:
 * the main CI run on the M1 Air took 9.4 and 10.2 min (runs 38287317331, 38289995168), and Railway waits for it before it builds; 40 Vercel
 * production builds took 1.3 min median and 1.8 min at most.
 */
export const DEPLOY_MINUTES = 20;
const RAILWAY_LIVE = ["SUCCESS", "SLEEPING"];
/** A worker deployment on its way: the precheck does not start a second one of the same commit. WAITING (Railway's CI wait) is not in it. */
const RAILWAY_BUILDING = ["QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING"];
const MINUTE = 60_000;
/** A redeploy is remembered this long, so the state file stays small. */
const REMEMBER_MS = 14 * 24 * 60 * MINUTE;
/** GitHub lists at most 300 files per commit; a commit at the cap counts as changing a watched path. */
const COMMIT_FILE_LIMIT = 300;

/** A slack-green main commit with its committer time (the merge time for a squash merge). `watched`: it changes a railway.toml watch path. */
export interface Commit { sha: string; at: number; watched?: boolean | undefined }
/** One deployment as the platform lists it; `reason` is Railway's skippedReason. */
export interface Deploy { status: string; at: number; sha?: string | undefined; reason?: string | undefined }
/** One side of production: the commit it runs, its recent deployments, and the main commits that commit lacks, oldest first. */
export interface Side { live: string; deploys: Deploy[]; behind: Commit[] }
export interface Sources { railway?: Side; vercel?: Side; errors: string[] }

const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const age = (commit: Commit, now: number) => Math.floor((now - commit.at) / MINUTE);
const latestFor = (deploys: readonly Deploy[], sha: string) => deploys.filter(deploy => deploy.sha === sha).sort((a, b) => b.at - a.at)[0];

/** The commits a side should run: all for Vercel, only those that change a watch path for the worker. Unknown counts as watched. */
const owed = (side: "railway" | "vercel", behind: readonly Commit[]) => side === "vercel" ? [...behind] : behind.filter(commit => commit.watched !== false);

/** The owed commits split by age: `late` are past DEPLOY_MINUTES and count against the headline, `pending` are still on their way. */
export function standing(side: "railway" | "vercel", behind: readonly Commit[], now: number): { late: Commit[]; pending: Commit[] } {
  const commits = owed(side, behind);
  return { late: commits.filter(commit => age(commit, now) >= DEPLOY_MINUTES), pending: commits.filter(commit => age(commit, now) < DEPLOY_MINUTES) };
}

/** What the platform did with one commit: its newest deployment's status and Railway's skip reason, or that it has none. */
const fate = (deploys: readonly Deploy[], sha: string): string => {
  const deploy = latestFor(deploys, sha);
  return !deploy ? "no deployment" : deploy.reason ? `${deploy.status}: ${deploy.reason}` : deploy.status;
};

const PLATFORM = { railway: "the Railway worker", vercel: "Vercel production" } as const;
const LISTED = 8;

export function describe(side: "railway" | "vercel", state: Side, commits: readonly Commit[], now: number): string {
  const listed = commits.slice(0, LISTED).map(commit => `${short(commit.sha)} (${age(commit, now)} min after its push, ${fate(state.deploys, commit.sha)})`);
  const more = commits.length > LISTED ? ` and ${commits.length - LISTED} more` : "";
  return `${PLATFORM[side]} runs ${short(state.live)}, which lacks ${listed.join(", ")}${more}`;
}

/** Run to run memory: the main heads this precheck already deployed to the worker, with when. */
export interface DeployState { redeployed: Record<string, number> }

/**
 * The one fix this precheck makes: deploy main's head to the worker when it lacks a commit past DEPLOY_MINUTES, once per head, and not while a
 * deployment of the head is already building.
 */
export function redeployFor(railway: Side | undefined, now: number, state: DeployState): string | null {
  if (!railway || !standing("railway", railway.behind, now).late.length) return null;
  const head = railway.behind.at(-1)!.sha;
  if (state.redeployed[head] !== undefined || RAILWAY_BUILDING.includes(latestFor(railway.deploys, head)?.status ?? "")) return null;
  return head;
}

export type Redeploy = { head: string; error?: string };

export function deployMetrics(sources: Sources, now: number, redeploy?: Redeploy): { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  const flagged: FlaggedSlice[] = sources.errors.map(error => ({ at: now, kind: "source_error",
    excerpt: `${error}. The headline counts this run as a miss until the precheck or its login is fixed.` }));
  const notLive = new Set<string>();
  const counts = { railway: 0, vercel: 0 };
  for (const side of ["railway", "vercel"] as const) {
    const state = sources[side];
    if (!state) continue;
    const { late, pending } = standing(side, state.behind, now);
    counts[side] = late.length;
    for (const commit of late) notLive.add(commit.sha);
    flagged.push(late.length
      ? { at: now, kind: `${side}_not_live`, excerpt: describe(side, state, late, now) }
      : { at: now, kind: `${side}_ok`, excerpt: `${PLATFORM[side]} runs ${short(state.live)}, which has every main commit over ${DEPLOY_MINUTES} min old it should run` });
    if (pending.length) flagged.push({ at: now, kind: `${side}_pending`, excerpt: describe(side, state, pending, now) });
  }
  if (redeploy) flagged.push({ at: now, kind: redeploy.error ? "redeploy_error" : "redeploy", excerpt: redeploy.error
    ? `deploying main's head ${short(redeploy.head)} to the Railway worker failed: ${redeploy.error}`
    : `this check deployed main's head ${short(redeploy.head)} to the Railway worker once; the next run shows whether it went live` });
  const errors = sources.errors.length;
  return { metrics: { commits_not_live: errors ? Math.max(notLive.size, 1) : notLive.size, railway_not_live: counts.railway, vercel_not_live: counts.vercel,
    source_errors: errors }, flagged };
}

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<string>;
export interface DeployDeps { exec: Exec; fetch: typeof fetch; now: () => number; railwayToken: () => Promise<string>; vercelToken: () => Promise<string> }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***");

/** The main commits `live` lacks, oldest first: GitHub's compare of live...main, which also handles a live commit that is not on main. */
export async function readBehind(deps: DeployDeps, live: string): Promise<Commit[]> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/compare/${live}...main`, "--jq", "[.commits[] | {sha, at: .commit.committer.date}]"]);
  return (JSON.parse(out) as { sha: string; at: string }[]).map(commit => ({ sha: commit.sha, at: Date.parse(commit.at) }));
}

const globRegex = (glob: string): RegExp => new RegExp(`^${glob.split("**").map(part =>
  part.replace(/[.+^$|()[\]{}\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*")}$`);

/** railway.toml's watchPatterns on main as path regexes; `**` crosses folders, `*` and `?` do not. */
export async function readWatchPatterns(deps: DeployDeps): Promise<RegExp[]> {
  const toml = await deps.exec("gh", ["api", `repos/${REPO}/contents/packages/backend/railway.toml?ref=main`, "-H", "Accept: application/vnd.github.raw"]);
  const list = /watchPatterns\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1];
  if (!list) throw new Error("packages/backend/railway.toml on main has no watchPatterns");
  return [...list.matchAll(/"([^"]+)"/g)].map(([, pattern]) => globRegex(pattern!.replace(/^\//, "")));
}

export async function readFiles(deps: DeployDeps, sha: string): Promise<string[]> {
  return JSON.parse(await deps.exec("gh", ["api", `repos/${REPO}/commits/${sha}`, "--jq", "[.files[].filename]"])) as string[];
}

export const touchesWatched = (files: readonly string[], patterns: readonly RegExp[]): boolean =>
  files.length >= COMMIT_FILE_LIMIT || files.some(file => patterns.some(pattern => pattern.test(file)));

interface RailwayRow { status: string; createdAt: string; meta?: { branch?: string; commitHash?: string; skippedReason?: string } }

/** The worker's deployments, linked in a temp folder and unlinked after, as the Slack green emails precheck does. */
export async function readRailway(deps: DeployDeps): Promise<Deploy[]> {
  const dir = await mkdtemp(join(tmpdir(), "sg-deploys-"));
  try {
    await deps.exec("railway", ["link", "--project", "slack-green-backend", "--environment", "production", "--service", "slack-green-backend"], { cwd: dir });
    const list = await deps.exec("railway", ["deployment", "list", "--json", "--limit", "100"], { cwd: dir });
    return (JSON.parse(list.slice(list.indexOf("["))) as RailwayRow[]).map(row => ({ status: row.status, at: Date.parse(row.createdAt), sha: row.meta?.commitHash,
      reason: row.meta?.skippedReason }));
  } finally {
    await deps.exec("railway", ["unlink", "-y"], { cwd: dir }).catch(() => "");
    await rm(dir, { recursive: true, force: true });
  }
}

/** The commit the worker runs: its newest SUCCESS or SLEEPING deployment. */
export function railwayLive(deploys: readonly Deploy[]): string {
  const live = [...deploys].sort((a, b) => b.at - a.at).find(deploy => RAILWAY_LIVE.includes(deploy.status) && deploy.sha);
  if (!live?.sha) throw new Error(`no SUCCESS or SLEEPING deployment with a commit among the worker's newest ${deploys.length}`);
  return live.sha;
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

/** Deploys a commit to the worker without waiting for CI, the call the dashboard's deploy button makes. */
export async function deployWorker(deps: DeployDeps, sha: string): Promise<void> {
  const response = await deps.fetch("https://backboard.railway.com/graphql/v2", { method: "POST",
    headers: { Authorization: `Bearer ${await deps.railwayToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "mutation($s: String!, $e: String!, $c: String) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e, commitSha: $c) }",
      variables: { s: RAILWAY.serviceId, e: RAILWAY.environmentId, c: sha } }) });
  const body = await response.text();
  if (!response.ok || /"errors"/.test(body)) throw new Error(`Railway serviceInstanceDeployV2 gave HTTP ${response.status}: ${body.slice(0, 200)}`);
}

/** Marks each worker commit past DEPLOY_MINUTES with whether it changes a watch path; a failed read leaves it unknown, which counts as watched. */
async function markWatched(deps: DeployDeps, behind: Commit[], now: number, fail: (what: string) => (error: unknown) => undefined): Promise<void> {
  const due = behind.filter(commit => age(commit, now) >= DEPLOY_MINUTES);
  if (!due.length) return;
  const patterns = await readWatchPatterns(deps).catch(fail("railway.toml watchPatterns on main"));
  if (!patterns) return;
  await Promise.all(due.map(async commit => {
    const files = await readFiles(deps, commit.sha).catch(fail(`GitHub files of ${short(commit.sha)}`));
    if (files) commit.watched = touchesWatched(files, patterns);
  }));
}

export async function measureDeploys(deps: DeployDeps, previous: DeployState): Promise<{ output: PrecheckOutput; state: DeployState }> {
  const now = deps.now();
  const sources: Sources = { errors: [] };
  const fail = (what: string) => (error: unknown): undefined => { sources.errors.push(`${what}: ${message(error)}`); return undefined; };
  const side = async (name: string, read: () => Promise<{ live: string; deploys: Deploy[] }>): Promise<Side | undefined> => {
    const platform = await read().catch(fail(name));
    const behind = platform && await readBehind(deps, platform.live).catch(fail(`GitHub main commits missing from ${name}'s ${short(platform.live)}`));
    return platform && behind ? { ...platform, behind } : undefined;
  };
  const [railway, vercel] = await Promise.all([
    side("Railway deployments", async () => { const deploys = await readRailway(deps); return { live: railwayLive(deploys), deploys }; }),
    side("Vercel production", () => readVercel(deps)),
  ]);
  if (railway) { await markWatched(deps, railway.behind, now, fail); sources.railway = railway; }
  if (vercel) sources.vercel = vercel;
  const state: DeployState = { redeployed: Object.fromEntries(Object.entries(previous.redeployed).filter(([, at]) => at > now - REMEMBER_MS)) };
  let redeploy: Redeploy | undefined;
  const head = redeployFor(railway, now, state);
  if (head) {
    redeploy = { head };
    try { await deployWorker(deps, head); state.redeployed[head] = now; }
    catch (error) { redeploy.error = message(error); }
  }
  return { output: deployMetrics(sources, now, redeploy), state };
}

/** Each command stops 10 s before the runner's PRECHECK_TARGET_MS, so a hung call still ends as a source error with every metric written. */
const COMMAND_TIMEOUT_MS = PRECHECK_TARGET_MS - 10_000;
const exec: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, cwd: options?.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args[0] ?? ""}: ${error.message} ${stderr}`.trim())) : resolve(stdout));
});

/** RAILWAY_API_TOKEN when set, else the railway CLI's login, which the `railway deployment list` call just refreshed. */
const railwayToken = async (): Promise<string> => {
  if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
  const user = (JSON.parse(await readFile(join(homedir(), ".railway/config.json"), "utf8")) as { user?: { accessToken?: string; token?: string } }).user;
  const token = user?.accessToken ?? user?.token;
  if (!token) throw new Error("no Railway token: RAILWAY_API_TOKEN is unset and ~/.railway/config.json has no login");
  return token;
};
const vercelToken = async (): Promise<string> =>
  process.env.VERCEL_TOKEN || (JSON.parse(await readFile(join(homedir(), "Library/Application Support/com.vercel.cli/auth.json"), "utf8")) as { token: string }).token;

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-deploys: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const saved = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as Partial<DeployState>, () => undefined) : undefined;
  const result = await measureDeploys({ exec, fetch, now: Date.now, railwayToken, vercelToken },
    { redeployed: saved?.redeployed && typeof saved.redeployed === "object" ? saved.redeployed : {} });
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
