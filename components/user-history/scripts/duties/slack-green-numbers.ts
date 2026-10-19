import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DutyRunRecord, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { parseEnv } from "./local-dev-uptime.ts";

/**
 * The slack green guy's Slack green numbers duty's precheck (`node --import tsx scripts/duties/slack-green-numbers.ts`). No model call, reads only.
 * Wrong funnel numbers and duty checks that could not read prod came up 7 times from 10-09 to 10-19 (PostHog missed 47 of 150 signups, test and
 * preview visits in the dashboards, a Vercel token on 10-16, the funnel, review and email checks failing to read prod after the 10-18 host move).
 * The headline, numbers_wrong, counts the checks that fail, out of CHECKS:
 * - one per sibling Slack green duty of the chat (every duty whose precheck runs a scripts/duties/slack-green-*.ts other than this one, d1 to d4
 *   on 10-19): its last run that was not skipped had a source error (verdict error, a run error, source_errors above 0 or a source_error slice
 *   in its detail file);
 * - one for signups: PostHog's real user_signed_up people in the last 7 days and the real Supabase accounts created in the last 7 days differ by
 *   more than SIGNUP_MARGIN, or either side could not be read. Real means the dashboards' QA filter: QA_EMAILS and the sg-qa- id prefix;
 * - one per funnel dashboard (DASHBOARDS): a tile's query errors or does not finish within TILE_DEADLINE_MS, or the dashboard cannot be read.
 * Supporting numbers: duty_source_errors, signup_count_gap and dashboard_tiles_failing. A number this run could not measure is left out of the
 * output, so the run says "not measured" for it, and its check still counts in the headline: an unread number is a wrong one.
 * Keys come from slack-green's scripts/seo-agent/.env, read as a file; no slack-green code runs. The dashboards need POSTHOG_DASHBOARD_API_KEY
 * (the query key has no dashboard:read). On 10-19 the 24 tiles took 15 to 81 s each in PostHog's async mode, run in parallel.
 */

const REPO = process.env.SLACK_GREEN_REPO || join(homedir(), "Documents/Github/slack-green");
/** The slack green guy chat, whose sibling duties this checks. */
export const CHAT = process.env.SLACK_GREEN_CHAT || "01a11b0b-7c15-73da-9481-8de15903eab4";
const SUPABASE_URL = "https://pcpcicvhrcazmlpjrqho.supabase.co";
const POSTHOG = "https://us.posthog.com";
/** "Slack Green conversion by source" and "Slack Green acquisition funnel", the two the owner reads (slack-green scripts/seo-agent/README.md). */
export const DASHBOARDS = [2191672, 2186311] as const;
export const WINDOW_DAYS = 7;
/** PostHog's and Supabase's 7-day windows start at different moments of one signup (account creation, first session), so 2 may differ. */
export const SIGNUP_MARGIN = 2;
export const TILE_DEADLINE_MS = 150_000;
/** slack-green scripts/posthog/setup_acquisition_dashboard.py QA_EMAILS, the dashboards' QA account filter. Keep the two equal. */
export const QA_EMAILS = /^(sg-qa-[^@]*@slack\.green|qa\+[^@]*@example\.com|[^@]*\+sgqa[^@]*@.*)$/;
const THIS = "slack-green-numbers.ts";
const DAY = 86_400_000;

export const isQa = (id: string, email: string | null | undefined): boolean => id.startsWith("sg-qa-") || QA_EMAILS.test(email ?? "");

export interface DutyCheck { id: string; name: string; run?: DutyRunRecord; detail?: PrecheckOutput }
export interface Account { id: string; email?: string | null; created_at: string }
export interface Signup { id: string; email: string | null }
export interface Tile { dashboard: number; insight: number; name: string; error?: string }
export interface DashboardRead { id: number; tiles?: Tile[]; error?: string }
export interface Sources { duties: DutyCheck[]; accounts?: Account[]; signups?: Signup[]; dashboards: DashboardRead[]; errors: string[] }

/** Why a duty's last run did not read its sources, or null when it did. */
export function runSourceError(check: DutyCheck): string | null {
  const run = check.run;
  if (!run) return null;
  if (run.verdict === "error") return `verdict error: ${run.error ?? run.summary}`;
  if (run.error) return run.error;
  const count = check.detail?.metrics?.source_errors ?? run.metrics?.source_errors?.value ?? 0;
  const slices = (check.detail?.flagged ?? []).filter(slice => slice.kind === "source_error");
  if (count > 0 || slices.length) return slices.map(slice => slice.excerpt).join("; ").slice(0, 400) || `source_errors ${count}`;
  return null;
}

export function numbersMetrics(sources: Sources, now: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = sources.errors.map(excerpt => ({ at: now, kind: "source_error", item: "p145", excerpt }));
  let wrong = 0;
  let dutyErrors = 0;
  for (const check of sources.duties) {
    const error = runSourceError(check);
    const when = check.run ? new Date(check.run.at).toISOString().slice(0, 16) + "Z" : "never";
    if (error) { dutyErrors++; flagged.push({ at: now, kind: "duty_source_error", item: "p145", excerpt: `${check.id} ${check.name}, last run ${when}: ${error}` }); }
    else if (!check.run || now - check.run.at > 2 * DAY) flagged.push({ at: now, kind: "duty_stale", item: "p145", excerpt: `${check.id} ${check.name} has not run since ${when}` });
  }
  wrong += dutyErrors;
  const metrics: Record<string, number> = { duty_source_errors: dutyErrors };
  if (sources.accounts && sources.signups) {
    const since = now - WINDOW_DAYS * DAY;
    const accounts = sources.accounts.filter(account => Date.parse(account.created_at) >= since && !isQa(account.id, account.email));
    const signups = [...new Map(sources.signups.filter(signup => !isQa(signup.id, signup.email)).map(signup => [signup.id, signup])).values()];
    const signed = new Set(signups.map(signup => signup.id));
    const known = new Set(sources.accounts.map(account => account.id));
    const created = new Set(accounts.map(account => account.id));
    const gap = Math.abs(signups.length - accounts.length);
    metrics.signup_count_gap = gap;
    metrics.posthog_signups_7d = signups.length;
    metrics.supabase_accounts_7d = accounts.length;
    if (gap > SIGNUP_MARGIN) wrong++;
    const noEvent = accounts.filter(account => !signed.has(account.id)).map(account => account.id);
    const noAccount = signups.filter(signup => !known.has(signup.id)).map(signup => signup.id);
    const older = signups.filter(signup => known.has(signup.id) && !created.has(signup.id)).map(signup => signup.id);
    flagged.push({ at: now, kind: gap > SIGNUP_MARGIN ? "signup_gap" : "signup_ok", item: "p145", excerpt: `last ${WINDOW_DAYS} days, QA left out: ` +
      `${signups.length} PostHog user_signed_up people, ${accounts.length} Supabase accounts created, gap ${gap} (margin ${SIGNUP_MARGIN}); ` +
      `accounts with no PostHog signup: ${noEvent.join(", ") || "none"}; signups with no Supabase account (deleted): ${noAccount.join(", ") || "none"}; ` +
      `signups of accounts created earlier: ${older.join(", ") || "none"}` });
  } else wrong++;
  let failing = 0;
  for (const dashboard of sources.dashboards) {
    if (dashboard.error || !dashboard.tiles) { wrong++; flagged.push({ at: now, kind: "source_error", item: "p145", excerpt: `PostHog dashboard ${dashboard.id}: ${dashboard.error ?? "no tiles read"}` }); continue; }
    const bad = dashboard.tiles.filter(tile => tile.error);
    failing += bad.length;
    if (bad.length) wrong++;
    for (const tile of bad) flagged.push({ at: now, kind: "tile_failing", item: "p145", excerpt: `dashboard ${tile.dashboard} tile ${tile.insight} "${tile.name}": ${tile.error}` });
    if (!bad.length) flagged.push({ at: now, kind: "dashboard_ok", item: "p145", excerpt: `dashboard ${dashboard.id}: all ${dashboard.tiles.length} tiles loaded` });
  }
  if (sources.dashboards.some(dashboard => dashboard.tiles)) metrics.dashboard_tiles_failing = failing;
  metrics.numbers_wrong = wrong;
  metrics.checks = sources.duties.length + 1 + sources.dashboards.length;
  return { metrics, flagged };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***").slice(0, 300);

export interface NumbersDeps { fetch: typeof fetch; now: () => number; dataDir: string; env: Record<string, string>; sleep?: (ms: number) => Promise<void> }

/** The chat's other Slack green duties with their last run that was not skipped, and that run's saved precheck output. */
export async function readDuties(dataDir: string, chat: string): Promise<DutyCheck[]> {
  const file = JSON.parse(await readFile(join(dataDir, "duties", `${chat}.json`), "utf8")) as { duties: { id: string; name: string; status: string; precheck?: { command?: string[] } }[] };
  const siblings = file.duties.filter(duty => duty.status === "active" && (duty.precheck?.command ?? []).some(word => /slack-green-[^/]*\.ts$/.test(word) && !word.endsWith(THIS)));
  const lines = (await readFile(join(dataDir, "duties", `${chat}.runs.jsonl`), "utf8").catch(() => "")).split("\n");
  const last = new Map<string, DutyRunRecord>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const run = JSON.parse(line) as DutyRunRecord; if (run.verdict !== "skipped") last.set(run.duty, run); } catch { /* a torn last line */ }
  }
  return Promise.all(siblings.map(async duty => {
    const run = last.get(duty.id);
    const detail = run?.detail ? await readFile(run.detail, "utf8").then(text => JSON.parse(text) as PrecheckOutput, () => undefined) : undefined;
    return { id: duty.id, name: duty.name, ...run ? { run } : {}, ...detail ? { detail } : {} };
  }));
}

async function json<T>(deps: NumbersDeps, url: string, key: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const response = await deps.fetch(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra },
    ...body ? { body: JSON.stringify(body) } : {} });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url.replace(/\?.*/, "")} gave HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { status: response.status, data: JSON.parse(text) as T };
}

export async function readAccounts(deps: NumbersDeps): Promise<Account[]> {
  const key = deps.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error(`SUPABASE_SERVICE_KEY is not set in ${REPO}/scripts/seo-agent/.env`);
  const accounts: Account[] = [];
  for (let page = 1; page < 100; page++) {
    const { data } = await json<{ users: Account[] }>(deps, `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, key, undefined, { apikey: key });
    accounts.push(...data.users.map(user => ({ id: user.id, email: user.email ?? null, created_at: user.created_at })));
    if (data.users.length < 1000) return accounts;
  }
  return accounts;
}

const projectUrl = (deps: NumbersDeps, path: string) => `${POSTHOG}/api/projects/${deps.env.POSTHOG_PROJECT_ID}/${path}`;

export async function readSignups(deps: NumbersDeps): Promise<Signup[]> {
  const key = deps.env.POSTHOG_PERSONAL_API_KEY;
  if (!key || !deps.env.POSTHOG_PROJECT_ID) throw new Error(`POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is not set in ${REPO}/scripts/seo-agent/.env`);
  const query = `SELECT distinct_id, any(person.properties.email) FROM events WHERE event = 'user_signed_up' AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY GROUP BY distinct_id`;
  const { data } = await json<{ results: [string, string | null][] }>(deps, projectUrl(deps, "query/"), key, { query: { kind: "HogQLQuery", query }, refresh: "blocking" });
  return data.results.map(([id, email]) => ({ id, email }));
}

interface QueryStatus { id: string; complete?: boolean; error?: boolean; error_message?: string | null }

/** Runs one tile's query the way the dashboard does (async, cache first) and gives its error, or undefined when it loaded. */
export async function loadTile(deps: NumbersDeps, key: string, query: unknown, deadline: number): Promise<string | undefined> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  try {
    let { data } = await json<{ results?: unknown; error?: string | null; query_status?: QueryStatus }>(deps, projectUrl(deps, "query/"), key, { query, refresh: "async" });
    if (data.error) return data.error;
    let status = data.results === undefined ? data.query_status : undefined;
    while (status && !status.complete) {
      if (deps.now() > deadline) return `did not finish within ${TILE_DEADLINE_MS / 1000} s`;
      await sleep(2000);
      status = (await json<{ query_status: QueryStatus }>(deps, projectUrl(deps, `query/${status.id}/`), key)).data.query_status;
    }
    if (status?.error) return status.error_message || "query error";
    return undefined;
  } catch (error) { return message(error); }
}

export async function readDashboard(deps: NumbersDeps, id: number, deadline: number): Promise<DashboardRead> {
  const key = deps.env.POSTHOG_DASHBOARD_API_KEY;
  if (!key) return { id, error: `POSTHOG_DASHBOARD_API_KEY is not set in ${REPO}/scripts/seo-agent/.env` };
  try {
    const { data } = await json<{ tiles: { insight?: { id: number; name?: string; query?: unknown } | null }[] }>(deps, projectUrl(deps, `dashboards/${id}/`), key);
    const tiles = await Promise.all(data.tiles.filter(tile => tile.insight?.query).map(async tile => {
      const error = await loadTile(deps, key, tile.insight!.query, deadline);
      return { dashboard: id, insight: tile.insight!.id, name: tile.insight!.name ?? "", ...error ? { error } : {} };
    }));
    return { id, tiles };
  } catch (error) { return { id, error: message(error) }; }
}

export async function measureNumbers(deps: NumbersDeps, chat = CHAT): Promise<PrecheckOutput> {
  const now = deps.now();
  const errors: string[] = [];
  const fail = (what: string) => (error: unknown): undefined => { errors.push(`${what}: ${message(error)}`); return undefined; };
  const deadline = now + TILE_DEADLINE_MS;
  const [duties, accounts, signups, dashboards] = await Promise.all([
    readDuties(deps.dataDir, chat).catch(fail("this chat's duties and runs")),
    readAccounts(deps).catch(fail("prod Supabase accounts")),
    readSignups(deps).catch(fail("PostHog user_signed_up")),
    Promise.all(DASHBOARDS.map(id => readDashboard(deps, id, deadline))),
  ]);
  const output = numbersMetrics({ duties: duties ?? [], ...accounts ? { accounts } : {}, ...signups ? { signups } : {}, dashboards, errors }, now);
  if (!duties) { delete output.metrics.duty_source_errors; output.metrics.numbers_wrong! += 1; }
  return output;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("slack-green-numbers: OUTPUT_FILE is not set\n"); process.exit(2); }
  const env = await readFile(join(REPO, "scripts/seo-agent/.env"), "utf8").then(parseEnv, () => ({} as Record<string, string>));
  const dataDir = process.env.AGENT_CHAT_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
  await writeFile(output, JSON.stringify(await measureNumbers({ fetch, now: Date.now, dataDir, env }), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
