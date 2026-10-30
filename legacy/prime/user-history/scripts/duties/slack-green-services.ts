import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { type FlaggedSlice, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DeployDeps, type DeployState, type Exec, exec, measureDeploys, railwayToken } from "./slack-green-deploys.ts";
import { parseEnv } from "./local-dev-uptime.ts";
import { vercelToken } from "./vercel-login.ts";

/**
 * The precheck of slack green guy's "Slack Green services work" duty (`node --import tsx scripts/duties/slack-green-services.ts`). No model call.
 * On 10-30 slack.green prod served HTML 200 for hours while every page threw "Missing Supabase environment variables" in the browser, because
 * the us-metal02 prebuilt build had no NEXT_PUBLIC_SUPABASE_* values, and no duty saw it until the owner sent a screenshot (msg mvux3bjx). He then
 * asked for one duty every 3 hours that checks every service works, Vercel and Railway included, and that his own Slack account shows green
 * (msg mvux7mnh).
 * pages_failing, the headline, opens five pages in a headful Chrome on this box through the aside-browser box runner (c177, c205) and counts a
 * page as failing when its document answers non-200, it throws an uncaught error (pageerror), or it shows an error screen. /dashboard is read
 * signed in as sg-qa-services-duty@slack.green, whose password this precheck sets to a new random value each run through Supabase's admin API.
 * deploy_problems folds in the old Slack green deploys duty (d4): main commits not live on the Railway worker after 20 min, failed main CI
 * runs of 24 h, a deploy source that did not read, and the worker crashed or silent. Main commits that Vercel prod lacks are flagged and not
 * counted, because since 10-30 slack.green builds on us-metal02 (c200) and each prod deploy waits for the release owner (c154). owner_slack_green reads the owner's presence with Slack's users.getPresence
 * through the session tokens Slack Green stores for his ppwc workspace, read only. api_routes_failing calls the add-on's and the CLI's routes
 * with a bogus login and expects their JSON 401, and counts each /api/ route that answered 500 or more during the page walk.
 */

/** SLACK_GREEN_BASE points the walk at one deployment's URL, such as a candidate before a promote (c205). */
export const BASE = (process.env.SLACK_GREEN_BASE || "https://slack.green").replace(/\/+$/, "");
export const QA_EMAIL = "sg-qa-services-duty@slack.green";
export interface PageSpec { key: string; path: string; signedIn?: true }
export const PAGES: readonly PageSpec[] = [
  { key: "home", path: "/en" },
  { key: "signup", path: "/auth/signup" },
  { key: "blog_post", path: "/en/blog/slack-yellow-dot" },
  { key: "pricing", path: "/en/pricing" },
  { key: "dashboard", path: "/dashboard", signedIn: true },
];
/** Next.js's own error screens; slack-green has no error.tsx, so a thrown render shows one of these. The first is what the owner saw on 10-30. */
export const ERROR_SCREEN = /This page couldn.t load|Application error: a (?:client|server)-side exception|Internal Server Error|Unhandled Runtime Error/i;
/** The owner's profile, his real workspace row's name and his Slack user, found 10-30 in prod Supabase and Slack (team TFGEZ65DE, Papers with Code). */
const OWNER = { profile: "0702dbf0-87dd-49ca-94d8-979ddf37e8f4", workspace: "ppwc", slackUser: "U02AKASTGR1" };
const DEFAULT_SUPABASE = "https://pcpcicvhrcazmlpjrqho.supabase.co";
/**
 * The worker logs each workspace's presence check ("🟢 active") every presence_check_interval, 60 s (packages/backend/app/config.py), and on
 * 10-30 at 12:04Z it wrote several such lines a second, so 10 min with none means it stopped working.
 */
const WORKER_SILENT_MS = 10 * 60_000;
const SETTLE_MS = 4000;
const PAGE_TIMEOUT_MS = 45_000;

/** What one page read showed. `error` is a walk failure, such as a sign-in that did not finish. */
export interface PageRead { key: string; url: string; status?: number; finalUrl?: string; pageErrors: string[]; consoleErrors: string[];
  errorScreen?: string; api5xx: string[]; error?: string }

/** Why a page fails, or null when it renders: the document's status, an uncaught error, an error screen, or a walk failure. */
export function pageFailure(read: PageRead): string | null {
  if (read.error) return read.error;
  if (read.status !== 200) return `answered HTTP ${read.status ?? "nothing"}`;
  if (read.errorScreen) return `shows the error screen "${read.errorScreen}"`;
  if (read.finalUrl && new URL(read.finalUrl).pathname !== new URL(read.url).pathname) return `ended at ${read.finalUrl} instead`;
  if (read.pageErrors.length) return `threw ${read.pageErrors.length} uncaught error(s), first: ${read.pageErrors[0]!.slice(0, 200)}`;
  return null;
}

export interface WorkerRead { status: string; deployAt: number; lastActiveAt?: number; activeLines: number }
export interface Presence { presence: string; online: boolean; connectionCount: number; lastActivity?: number }
export interface RouteRead { route: string; status?: number; body?: string; error?: string; ok: boolean }
export interface Readings { pages: PageRead[]; deploys?: PrecheckOutput; worker?: WorkerRead; presence?: Presence; routes: RouteRead[]; errors: string[] }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***");
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

export function servicesOutput(read: Readings, now: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = read.errors.map(error => ({ at: now, kind: "source_error", excerpt: error }));
  let pagesFailing = 0;
  for (const page of read.pages) {
    const failure = pageFailure(page);
    if (failure) pagesFailing++;
    const extra = page.consoleErrors.length ? `; console errors (not counted): ${page.consoleErrors.slice(0, 2).join(" | ").slice(0, 300)}` : "";
    flagged.push({ at: now, kind: failure ? "page_failing" : "page_ok", excerpt: `${page.url} ${failure ?? `renders${page.finalUrl && page.finalUrl !== page.url ? ` at ${page.finalUrl}` : ""}`}${extra}` });
  }
  if (read.pages.length < PAGES.length) pagesFailing += PAGES.length - read.pages.length;

  let workerProblems = 0;
  if (!read.worker) workerProblems++;
  else {
    const { status, lastActiveAt, activeLines } = read.worker;
    const crashed = !["SUCCESS", "SLEEPING"].includes(status);
    const silent = lastActiveAt === undefined || now - lastActiveAt > WORKER_SILENT_MS;
    workerProblems += Number(crashed) + Number(silent);
    flagged.push({ at: now, kind: crashed || silent ? "worker_problem" : "worker_ok", excerpt: `the Railway worker's newest deployment is ${status} (${when(read.worker.deployAt)}), and its last presence check log line is ${lastActiveAt ? `${Math.round((now - lastActiveAt) / 60_000)} min old, ${activeLines} active lines in the logs read` : "missing from the logs read"}` });
  }
  const deploys = read.deploys;
  if (deploys) flagged.push(...(deploys.flagged ?? []).map(slice => slice.kind === "vercel_not_live"
    ? { ...slice, kind: "vercel_behind_main", excerpt: `${slice.excerpt}; not counted, because each slack.green prod deploy waits for the release owner (c154, c200)` } : slice));
  const { railway_not_live: railwayLate = 0, main_checks_failed_24h: checksFailed = 0, source_errors: deployErrors = 0 } = deploys?.metrics ?? {};
  const deployProblems = workerProblems + (deploys ? railwayLate + checksFailed + deployErrors : 1);

  const green = read.presence?.presence === "active" ? 1 : 0;
  if (read.presence) flagged.push({ at: now, kind: green ? "owner_green" : "owner_not_green", excerpt: `the owner's Slack (ppwc, ${OWNER.slackUser}) reads ${read.presence.presence}, online ${read.presence.online}, ${read.presence.connectionCount} connection(s)${read.presence.lastActivity ? `, last activity ${when(read.presence.lastActivity * 1000)}` : ""}` });

  const walked5xx = [...new Set(read.pages.flatMap(page => page.api5xx))];
  const routesFailing = read.routes.filter(route => !route.ok).length + walked5xx.length;
  for (const route of read.routes) flagged.push({ at: now, kind: route.ok ? "api_ok" : "api_failing",
    excerpt: `${route.route} answered ${route.error ?? `HTTP ${route.status} ${route.body?.slice(0, 120) ?? ""}`}` });
  for (const hit of walked5xx) flagged.push({ at: now, kind: "api_failing", excerpt: `${hit} during the page walk` });

  const failedAt = deploys?.lastEventAt?.main_checks_failed_24h;
  return { metrics: { pages_failing: pagesFailing, deploy_problems: deployProblems, owner_slack_green: green, api_routes_failing: routesFailing,
    source_errors: read.errors.length }, flagged, ...failedAt === undefined ? {} : { lastEventAt: { deploy_problems: failedAt } } };
}

/** The aside-browser box runner: a headful Chrome on its own Xvfb display, driven by JSON lines on stdin and stdout. */
export class BoxBrowser {
  private next = 1;
  private waiting = new Map<number, (reply: { out?: string; error?: string }) => void>();
  private constructor(private child: ReturnType<typeof spawn>) {
    createInterface({ input: child.stdout! }).on("line", line => {
      try { const reply = JSON.parse(line) as { id: number; out?: string; error?: string }; this.waiting.get(reply.id)?.(reply); this.waiting.delete(reply.id); }
      catch { /* runner chatter */ }
    });
    child.on("exit", () => { for (const done of this.waiting.values()) done({ error: "the box runner exited" }); this.waiting.clear(); });
  }
  static start(runner = process.env.BOX_RUNNER || join(homedir(), ".prime/agent/skills/aside-browser/box/box.mjs")): BoxBrowser {
    return new BoxBrowser(spawn(process.execPath, [runner], { stdio: ["pipe", "pipe", "inherit"] }));
  }
  run(code: string, timeoutMs: number): Promise<string> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`the box browser call took over ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.waiting.set(id, reply => { clearTimeout(timer); reply.error ? reject(new Error(reply.error.split("\n")[0])) : resolve(reply.out ?? ""); });
      this.child.stdin!.write(JSON.stringify({ id, code }) + "\n");
    });
  }
  async close(): Promise<void> {
    this.child.stdin!.end();
    await new Promise<void>(resolve => { const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 15_000); this.child.on("exit", () => { clearTimeout(timer); resolve(); }); });
  }
}

/** Code for the box runner: open the page in a new tab, record its document status, uncaught errors, console errors and /api/ 5xx answers. */
export function pageCode(url: string, login?: { email: string; password: string }): string {
  return `
const p = await openTab();
const read = { pageErrors: [], consoleErrors: [], api5xx: [] };
p.on("pageerror", e => read.pageErrors.push(String(e && e.message || e)));
p.on("console", m => { if (m.type() === "error") read.consoleErrors.push(m.text().slice(0, 300)); });
p.on("response", r => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 500) read.api5xx.push(r.request().method() + " " + u.pathname + " answered " + r.status()); });
try {
  ${login ? `await p.goto(${JSON.stringify(`${BASE}/auth/login`)}, { waitUntil: "load", timeout: ${PAGE_TIMEOUT_MS} });
  await p.locator('input[type="email"]').fill(${JSON.stringify(login.email)});
  await p.locator('input[type="password"]').fill(${JSON.stringify(login.password)});
  await p.locator('input[type="password"]').press("Enter");
  try { await p.waitForURL(u => !new URL(String(u)).pathname.startsWith("/auth/"), { timeout: 30000 }); }
  catch { read.error = "the sg-qa sign-in did not leave /auth/login within 30 s: " + (await p.evaluate(() => document.body && document.body.innerText || "")).slice(0, 200); }
  read.pageErrors.length = 0;` : ""}
  if (!read.error) {
    const res = await p.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: ${PAGE_TIMEOUT_MS} });
    read.status = res ? res.status() : undefined;
    await sleep(${SETTLE_MS});
    read.finalUrl = p.url();
    const text = await p.evaluate(() => document.body && document.body.innerText || "");
    const screen = ${ERROR_SCREEN}.exec(text);
    if (screen) read.errorScreen = screen[0];
  }
} catch (e) { read.error = String(e && e.message || e).split("\\n")[0]; }
await p.close();
console.log(JSON.stringify(read));`;
}

export async function walkPages(browser: Pick<BoxBrowser, "run">, login: { email: string; password: string } | Error): Promise<PageRead[]> {
  const reads: PageRead[] = [];
  for (const page of PAGES) {
    const url = `${BASE}${page.path}`;
    const base = { key: page.key, url, pageErrors: [], consoleErrors: [], api5xx: [] };
    if (page.signedIn && login instanceof Error) { reads.push({ ...base, error: `no sg-qa sign-in: ${login.message}` }); continue; }
    try {
      const out = await browser.run(pageCode(url, page.signedIn && !(login instanceof Error) ? login : undefined), 2 * PAGE_TIMEOUT_MS + 40_000);
      reads.push({ ...base, ...JSON.parse(out.trim().split("\n").at(-1)!) as Partial<PageRead> });
    } catch (error) { reads.push({ ...base, error: message(error) }); }
  }
  return reads;
}

export interface Supabase { url: string; key: string }
async function supabaseCall<T>(fetcher: typeof fetch, sb: Supabase, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetcher(`${sb.url}${path}`, { ...init, headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} answered HTTP ${response.status}: ${body.slice(0, 160)}`);
  return (body ? JSON.parse(body) : null) as T;
}

/**
 * The QA login for /dashboard: the user exists (created once, confirmed), and its password is a new random one each run, so none is stored.
 * It holds one Teams row, so /dashboard shows the dashboard instead of sending a user with no workspace to /onboarding
 * (lib/routing/destination.ts). A Teams row holds no token, and the worker, the token check and the email jobs read only Slack rows (migration 038).
 */
export async function qaLogin(fetcher: typeof fetch, sb: Supabase): Promise<{ email: string; password: string }> {
  const password = randomBytes(18).toString("base64url");
  const rows = await supabaseCall<{ id: string }[]>(fetcher, sb, `/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(QA_EMAIL)}`);
  const id = rows[0]
    ? (await supabaseCall<{ id: string }>(fetcher, sb, `/auth/v1/admin/users/${rows[0].id}`, { method: "PUT", body: JSON.stringify({ password }) })).id
    : (await supabaseCall<{ id: string }>(fetcher, sb, "/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: QA_EMAIL, password, email_confirm: true }) })).id;
  await supabaseCall(fetcher, sb, "/rest/v1/slack_workspaces?on_conflict=user_id,platform,workspace_name", { method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ user_id: id, platform: "teams", workspace_name: "Microsoft Teams" }) });
  return { email: QA_EMAIL, password };
}

/** The owner's presence through the xoxc and xoxd session tokens Slack Green keeps for his ppwc workspace. Two reads, nothing written. */
export async function readOwnerPresence(fetcher: typeof fetch, sb: Supabase): Promise<Presence> {
  const rows = await supabaseCall<{ xoxc_token: string | null; xoxd_token: string | null; token_valid: boolean | null }[]>(fetcher, sb,
    `/rest/v1/slack_workspaces?select=xoxc_token,xoxd_token,token_valid&user_id=eq.${OWNER.profile}&workspace_name=eq.${OWNER.workspace}&platform=eq.slack`);
  const row = rows[0];
  if (!row?.xoxc_token || !row.xoxd_token) throw new Error(`the owner has no ${OWNER.workspace} Slack row with tokens`);
  const cookie = row.xoxd_token.includes("%") ? row.xoxd_token : encodeURIComponent(row.xoxd_token);
  const response = await fetcher(`https://slack.com/api/users.getPresence?user=${OWNER.slackUser}`, {
    headers: { Authorization: `Bearer ${row.xoxc_token}`, Cookie: `d=${cookie}` }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { ok: boolean; error?: string; presence?: string; online?: boolean; connection_count?: number; last_activity?: number };
  if (!body.ok) throw new Error(`Slack users.getPresence answered ${body.error ?? `HTTP ${response.status}`} (token_valid ${row.token_valid})`);
  return { presence: body.presence ?? "unknown", online: body.online ?? false, connectionCount: body.connection_count ?? 0,
    ...body.last_activity ? { lastActivity: body.last_activity } : {} };
}

/** The add-on's heartbeat and the CLI's validate route, called with a bogus login: each reads it and answers its JSON 401. */
export async function readRoutes(fetcher: typeof fetch, now: number): Promise<RouteRead[]> {
  const calls: { route: string; init: RequestInit; expect: string }[] = [
    { route: "POST /api/teams/heartbeat", expect: "unlinked",
      init: { method: "POST", headers: { Authorization: "Bearer sg-qa-services-duty", "Content-Type": "application/json" }, body: "{}" } },
    { route: "POST /api/cli/validate", expect: "invalid_session",
      init: { method: "POST", headers: { "X-SG-Signature": "sg-qa", "X-SG-Timestamp": String(Math.floor(now / 1000)), "X-SG-Device": "sg-qa-services-duty", "Content-Type": "application/json" }, body: "{}" } },
  ];
  return Promise.all(calls.map(async ({ route, init, expect }) => {
    try {
      const response = await fetcher(`${BASE}${route.split(" ")[1]}`, { ...init, signal: AbortSignal.timeout(20_000) });
      const body = await response.text();
      return { route, status: response.status, body, ok: response.status === 401 && body.includes(expect) };
    } catch (error) { return { route, error: message(error), ok: false }; }
  }));
}

interface RailwayRow { status: string; createdAt: string }
/** The worker's newest deployment that is not skipped or removed, and its newest presence check log line, from a temp-linked folder. */
export async function readWorker(run: Exec): Promise<WorkerRead> {
  const dir = await mkdtemp(join(tmpdir(), "sg-services-"));
  try {
    await run("railway", ["link", "--project", "slack-green-backend", "--environment", "production", "--service", "slack-green-backend"], { cwd: dir });
    const list = await run("railway", ["deployment", "list", "--json", "--limit", "20"], { cwd: dir });
    const newest = (JSON.parse(list.slice(list.indexOf("["))) as RailwayRow[]).filter(row => !["SKIPPED", "REMOVED", "WAITING"].includes(row.status))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!newest) throw new Error("the worker has no deployment among its newest 20");
    const logs = await run("railway", ["logs", "--lines", "300", "--json"], { cwd: dir });
    const active = logs.split("\n").flatMap(line => { try { return [JSON.parse(line) as { timestamp?: string; message?: string }]; } catch { return []; } })
      .filter(row => row.message?.includes("🟢 active") && row.timestamp).map(row => Date.parse(row.timestamp!));
    return { status: newest.status, deployAt: Date.parse(newest.createdAt), activeLines: active.length, ...active.length ? { lastActiveAt: Math.max(...active) } : {} };
  } finally {
    await run("railway", ["unlink", "-y"], { cwd: dir }).catch(() => "");
    await rm(dir, { recursive: true, force: true });
  }
}

async function supabaseEnv(): Promise<Supabase> {
  const repo = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");
  const env = await readFile(join(repo, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({} as Record<string, string>));
  const key = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error(`SUPABASE_SERVICE_KEY is not set in ${repo}/scripts/seo-agent/.env`);
  return { url: (process.env.SUPABASE_URL || env.SUPABASE_URL || DEFAULT_SUPABASE).replace(/\/+$/, ""), key };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-services: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const saved = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as Partial<DeployState>, () => undefined) : undefined;
  const now = Date.now();
  const errors: string[] = [];
  const fail = (what: string) => (error: unknown): undefined => { errors.push(`${what}: ${message(error)}`); return undefined; };
  const sb = await supabaseEnv().catch(fail("Supabase key"));
  const deps: DeployDeps = { exec, fetch, now: Date.now, railwayToken, vercelToken };
  const pages = (async () => {
    const login = sb ? await qaLogin(fetch, sb).catch((error: unknown) => new Error(message(error))) : new Error("no Supabase key");
    const browser = BoxBrowser.start();
    try { return await walkPages(browser, login); } finally { await browser.close(); }
  })().catch((error: unknown) => { fail("box browser")(error); return [] as PageRead[]; });
  const backend = (async () => {
    const deploys = await measureDeploys(deps, { redeployed: saved?.redeployed && typeof saved.redeployed === "object" ? saved.redeployed : {} });
    const worker = await readWorker(exec).catch(fail("Railway worker status and logs"));
    return { deploys, worker };
  })();
  const [pageReads, { deploys, worker }, presence, routes] = await Promise.all([pages, backend,
    sb ? readOwnerPresence(fetch, sb).catch(fail("owner's Slack presence")) : undefined, readRoutes(fetch, now)]);
  const result = servicesOutput({ pages: pageReads, deploys: deploys.output, routes, errors,
    ...worker ? { worker } : {}, ...presence ? { presence } : {} }, now);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(deploys.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
