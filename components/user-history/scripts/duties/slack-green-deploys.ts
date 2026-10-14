import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput, PRECHECK_TIMEOUT_MS } from "../../src/shared/chat-duties.ts";

/**
 * The slack green guy's Slack green deploys duty's precheck (`node --import tsx scripts/duties/slack-green-deploys.ts`). No model call.
 * It checks that the Railway worker and Vercel production run the latest slack-green main commit within DEPLOY_MINUTES of its push.
 * The Railway service waits for GitHub's CI check suites (source.checkSuites true) and skips the deploy when one fails. That is how #233
 * (4222b4b, 2026-10-14 01:22Z) never reached the worker: GitHub-hosted CI failed on the Actions billing hold, Railway recorded "SKIPPED,
 * CI check suite failed", and nothing told anyone. On such a skip this precheck deploys main's head to the worker once, through the same
 * serviceInstanceDeployV2 call the approved merges job used by hand at 01:50Z, and flags it. Every other way off main is flagged for the chat.
 * A "No changes to watched files" skip is normal: that commit does not touch packages/backend, so the worker stays on an older commit.
 */

export const REPO = "sieu-n/slack-green";
/** Railway project slack-green-backend, environment production, service slack-green-backend (`railway environment config --json`). */
export const RAILWAY = { environmentId: "c10f04dd-8694-406f-aeb3-3872b3c3ab36", serviceId: "1d922935-9d01-4946-9451-cda91e22792b" };
const VERCEL_TEAM = "team_HkFeqFbbJa5UAIjN0IYINUS0";
const VERCEL_PROJECT = "prj_Fg9XulbXkvMu6jmDIeGK8tb2DsvG";
/**
 * How long a push may take to reach production before it counts as stuck. The owner's brief asked for 20 minutes (2026-10-14). Measured:
 * the main CI run on the M1 Air took 9.4 and 10.2 min (runs 38287317331, 38289995168), and Railway waits for it before it builds; 40 Vercel
 * production builds took 1.3 min median and 1.8 min at most.
 */
export const DEPLOY_MINUTES = 20;
export const WATCHED_SKIP = /No changes to watched files/i;
const RAILWAY_LIVE = ["SUCCESS", "SLEEPING"];
const RAILWAY_DOWN = ["FAILED", "CRASHED", "REMOVED", "REMOVING"];
const VERCEL_DOWN = ["ERROR", "CANCELED"];
const MINUTE = 60_000;
/** A redeploy is remembered this long, so the state file stays small. */
const REMEMBER_MS = 14 * 24 * 60 * MINUTE;

/** A slack-green main commit, newest first, with its committer time (the merge time for a squash merge on GitHub). */
export interface Commit { sha: string; at: number }
/** One deployment as the platform lists it, newest first; `reason` is Railway's skippedReason. */
export interface Deploy { status: string; at: number; sha?: string | undefined; reason?: string | undefined }
export interface Sources { commits?: Commit[]; railway?: Deploy[]; vercel?: { production?: string | undefined; deploys: Deploy[] }; errors: string[] }

/**
 * Where one platform stands against main. `ok`: it runs every commit it should. `pending`: the newest commit it should run is under
 * DEPLOY_MINUTES old and still on its way. The rest are misses: `skipped` (Railway's CI wait), `failed`, `stuck` past DEPLOY_MINUTES, and
 * `missing`, no deployment at all for a commit past DEPLOY_MINUTES (GitHub sent no push event, as for #153 on 2026-09-29).
 */
export type Standing =
  | { kind: "ok"; live?: string | undefined }
  | { kind: "pending" | "stuck"; sha: string; status: string; minutes: number; live?: string | undefined }
  | { kind: "skipped" | "failed"; sha: string; status: string; live?: string | undefined }
  | { kind: "missing"; sha: string; minutes: number; live?: string | undefined };
export const MISSES: readonly Standing["kind"][] = ["skipped", "failed", "stuck", "missing"];

const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const forSha = (deploys: Deploy[], sha: string) => deploys.filter(deploy => deploy.sha === sha).sort((a, b) => b.at - a.at);

/** In flight or stuck: the clock runs from the push, or from a later redeploy of the same commit. */
function waiting(sha: string, status: string, since: number, now: number, live: string | undefined): Standing {
  const minutes = Math.floor((now - since) / MINUTE);
  return { kind: minutes < DEPLOY_MINUTES ? "pending" : "stuck", sha, status, minutes, live };
}

/**
 * The Railway worker against main. The commits it should run are those newer than its live deployment whose newest deployment is not a
 * watched-files skip; a later commit with a watched-files skip does not cover an earlier skipped one, so every newer commit is checked,
 * not only the head. Commits older than the oldest deployment Railway listed are out of view.
 */
export function railwayStanding(commits: Commit[], deploys: Deploy[], now: number): Standing {
  const live = [...deploys].sort((a, b) => b.at - a.at).find(deploy => RAILWAY_LIVE.includes(deploy.status));
  const liveIndex = live?.sha ? commits.findIndex(commit => commit.sha === live.sha) : -1;
  const oldest = Math.min(...deploys.map(deploy => deploy.at));
  const newer = liveIndex >= 0 ? commits.slice(0, liveIndex) : commits.filter(commit => commit.at >= oldest - DEPLOY_MINUTES * MINUTE);
  for (const commit of newer) {
    const [latest] = forSha(deploys, commit.sha);
    if (latest?.status === "SKIPPED" && WATCHED_SKIP.test(latest.reason ?? "")) continue;
    const at = live?.sha;
    if (!latest) {
      const minutes = Math.floor((now - commit.at) / MINUTE);
      return minutes < DEPLOY_MINUTES ? { kind: "pending", sha: commit.sha, status: "no deployment yet", minutes, live: at } : { kind: "missing", sha: commit.sha, minutes, live: at };
    }
    if (latest.status === "SKIPPED") return { kind: "skipped", sha: commit.sha, status: `SKIPPED (${latest.reason ?? "no reason given"})`, live: at };
    if (RAILWAY_DOWN.includes(latest.status)) return { kind: "failed", sha: commit.sha, status: latest.status, live: at };
    if (RAILWAY_LIVE.includes(latest.status)) return { kind: "ok", live: at };
    return waiting(commit.sha, latest.status, Math.max(commit.at, latest.at), now, at);
  }
  return live ? { kind: "ok", live: live.sha } : { kind: "failed", sha: commits[0]?.sha ?? "?", status: "no running deployment" };
}

/** Vercel production against main: every main commit builds the whole frontend, so production should be on the head. */
export function vercelStanding(commits: Commit[], production: string | undefined, deploys: Deploy[], now: number): Standing {
  const head = commits[0];
  if (!head || production === head.sha) return { kind: "ok", live: production };
  const [latest] = forSha(deploys, head.sha);
  if (!latest) {
    const minutes = Math.floor((now - head.at) / MINUTE);
    return minutes < DEPLOY_MINUTES ? { kind: "pending", sha: head.sha, status: "no deployment yet", minutes, live: production } : { kind: "missing", sha: head.sha, minutes, live: production };
  }
  if (VERCEL_DOWN.includes(latest.status)) return { kind: "failed", sha: head.sha, status: latest.status, live: production };
  return waiting(head.sha, latest.status === "READY" ? "READY but not production" : latest.status, Math.max(head.at, latest.at), now, production);
}

export const describe = (platform: string, standing: Standing): string => {
  const live = `${platform} runs ${short(standing.live)}`;
  switch (standing.kind) {
    case "ok": return `${live}, up to date with main`;
    case "pending": return `${live}; ${short(standing.sha)} is ${standing.status}, ${standing.minutes} min after its push`;
    case "stuck": return `${live}; ${short(standing.sha)} is still ${standing.status} ${standing.minutes} min after its push, over ${DEPLOY_MINUTES} min`;
    case "skipped": case "failed": return `${live}; ${short(standing.sha)} ended ${standing.status}`;
    case "missing": return `${live}; ${short(standing.sha)} has no ${platform} deployment ${standing.minutes} min after its push (no push event?)`;
  }
};

/** Run to run memory: the skipped commits this precheck already redeployed, with when. */
export interface DeployState { redeployed: Record<string, number> }

/** The one fix this precheck makes: deploy main's head to the worker, once per skipped commit. */
export const redeployFor = (railway: Standing, state: DeployState): string | null =>
  railway.kind === "skipped" && state.redeployed[railway.sha] === undefined ? railway.sha : null;

export function deployMetrics(sources: Sources, now: number, redeploy?: { skipped: string; head: string; error?: string }):
  { metrics: Record<string, number>; flagged: FlaggedSlice[] } {
  const metrics: Record<string, number> = { railway_off_main: 0, vercel_off_main: 0, source_errors: sources.errors.length };
  const flagged: FlaggedSlice[] = sources.errors.map(excerpt => ({ at: now, kind: "source_error", excerpt }));
  const commits = sources.commits;
  if (commits && sources.railway) {
    const standing = railwayStanding(commits, sources.railway, now);
    metrics.railway_off_main = MISSES.includes(standing.kind) ? 1 : 0;
    flagged.push({ at: now, kind: `railway_${standing.kind}`, excerpt: describe("the Railway worker", standing) });
  }
  if (commits && sources.vercel) {
    const standing = vercelStanding(commits, sources.vercel.production, sources.vercel.deploys, now);
    metrics.vercel_off_main = MISSES.includes(standing.kind) ? 1 : 0;
    flagged.push({ at: now, kind: `vercel_${standing.kind}`, excerpt: describe("Vercel production", standing) });
  }
  if (redeploy) flagged.push({ at: now, kind: redeploy.error ? "redeploy_error" : "redeploy", excerpt: redeploy.error
    ? `deploying main's head ${short(redeploy.head)} to the Railway worker after the ${short(redeploy.skipped)} skip failed: ${redeploy.error}`
    : `Railway skipped ${short(redeploy.skipped)}, so this check deployed main's head ${short(redeploy.head)} to the worker once; the next run shows whether it went live` });
  return { metrics, flagged };
}

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<string>;
export interface DeployDeps { exec: Exec; fetch: typeof fetch; now: () => number; railwayToken: () => Promise<string>; vercelToken: () => Promise<string> }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***");

export async function readCommits(deps: DeployDeps): Promise<Commit[]> {
  const out = await deps.exec("gh", ["api", `repos/${REPO}/commits?sha=main&per_page=30`, "--jq", "[.[] | {sha, at: .commit.committer.date}]"]);
  return (JSON.parse(out) as { sha: string; at: string }[]).map(commit => ({ sha: commit.sha, at: Date.parse(commit.at) }));
}

interface RailwayRow { status: string; createdAt: string; meta?: { branch?: string; commitHash?: string; skippedReason?: string } }

/** The worker's deployments, linked in a temp folder and unlinked after, as the Slack green emails precheck does. */
export async function readRailway(deps: DeployDeps): Promise<Deploy[]> {
  const dir = await mkdtemp(join(tmpdir(), "sg-deploys-"));
  try {
    await deps.exec("railway", ["link", "--project", "slack-green-backend", "--environment", "production", "--service", "slack-green-backend"], { cwd: dir });
    const list = await deps.exec("railway", ["deployment", "list", "--json", "--limit", "50"], { cwd: dir });
    return (JSON.parse(list.slice(list.indexOf("["))) as RailwayRow[]).map(row => ({ status: row.status, at: Date.parse(row.createdAt), sha: row.meta?.commitHash,
      reason: row.meta?.skippedReason }));
  } finally {
    await deps.exec("railway", ["unlink", "-y"], { cwd: dir }).catch(() => "");
    await rm(dir, { recursive: true, force: true });
  }
}

async function vercelGet<T>(deps: DeployDeps, path: string): Promise<T> {
  const response = await deps.fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM}`, { headers: { Authorization: `Bearer ${await deps.vercelToken()}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vercel ${path.split("?")[0]} gave HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T;
}

interface VercelRow { state?: string; readyState?: string; created: number; meta?: { githubCommitSha?: string } }

export async function readVercel(deps: DeployDeps): Promise<NonNullable<Sources["vercel"]>> {
  const project = await vercelGet<{ targets?: { production?: { meta?: { githubCommitSha?: string } } } }>(deps, `/v9/projects/${VERCEL_PROJECT}`);
  const list = await vercelGet<{ deployments: VercelRow[] }>(deps, `/v6/deployments?projectId=${VERCEL_PROJECT}&target=production&limit=20`);
  return { production: project.targets?.production?.meta?.githubCommitSha,
    deploys: list.deployments.map(row => ({ status: row.state ?? row.readyState ?? "?", at: row.created, sha: row.meta?.githubCommitSha })) };
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

export async function measureDeploys(deps: DeployDeps, previous: DeployState): Promise<{ output: PrecheckOutput; state: DeployState }> {
  const now = deps.now();
  const sources: Sources = { errors: [] };
  const fail = (what: string) => (error: unknown) => { sources.errors.push(`${what}: ${message(error)}`); return undefined; };
  const [commits, railway, vercel] = await Promise.all([readCommits(deps).catch(fail("GitHub main commits")), readRailway(deps).catch(fail("Railway deployments")),
    readVercel(deps).catch(fail("Vercel production"))]);
  if (commits) sources.commits = commits;
  if (railway) sources.railway = railway;
  if (vercel) sources.vercel = vercel;
  const state: DeployState = { redeployed: Object.fromEntries(Object.entries(previous.redeployed).filter(([, at]) => at > now - REMEMBER_MS)) };
  let redeploy: { skipped: string; head: string; error?: string } | undefined;
  const skipped = commits && railway ? redeployFor(railwayStanding(commits, railway, now), state) : null;
  if (skipped && commits?.[0]) {
    redeploy = { skipped, head: commits[0].sha };
    try { await deployWorker(deps, commits[0].sha); state.redeployed[skipped] = now; }
    catch (error) { redeploy.error = message(error); }
  }
  return { output: deployMetrics(sources, now, redeploy), state };
}

/** Each command stops 10 s before the runner's PRECHECK_TIMEOUT_MS, so a hung call still ends as a source error with every metric written. */
const COMMAND_TIMEOUT_MS = PRECHECK_TIMEOUT_MS - 10_000;
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
