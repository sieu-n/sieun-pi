import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Prospect dashboard precheck (`node --import tsx scripts/duties/prospect-dashboard.ts`) of the launch VP chat. No model call, reads only.
 * The owner asked for PostHog tracking and a dashboard for the Prospect and Watchlist vertical (11-03, msg mw02k8m4), then asked why it was
 * so empty (msg mw08t1g0). From 17:39Z on 11-03 to 01:49Z on 11-04 the prod Convex warehouse source sat paused with 3 failed tables during
 * the Convex outage, and nothing noticed. The headline, tiles_with_data_pct, runs every insight tile of the dashboard the way the dashboard
 * loads it (refresh "async": a fresh cached answer, else a new run) and counts a tile that finished with no error and has a row with a
 * number in it. A true 0 counts as fed, because a clean query that counts nothing is an answer (launch VP, 11-04); a
 * tile that errors, reads a missing source, or returns no row or only blanks and labels where its numbers belong is not.
 * source_tables_failing counts the source's tables that are paused, failed or stale: every table with should_sync on, plus every table a
 * tile reads (`prodconvex_<table>` in its HogQL), since the outage turned should_sync off on orgs and orgMembers. A table fails when its
 * status is not Completed or Running, or its last sync run is older than twice its sync interval. A sync run is the newest Completed job
 * of the table, because PostHog moves a schema's last_synced_at only when a run brings rows: on 11-04 orgs read 18:58Z at 21:10Z while
 * its jobs ran Completed with 0 rows at 19:58Z and 20:58Z, so 3 tables that synced every hour read stale. The two event ages are the hours since the
 * newest prod prospect_state_day and watchlist_reads_day event. Prod means the orgId is a prod Convex org and appEnv, when set, is
 * production, because dev and staging events landed in 354457 too, with their own org ids. The key is POSTHOG_ADMIN_API_KEY from
 * apps/search/.env, read through dotenvx in the auto-sns-agent checkout, because the query keys get 403 on dashboards.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const POSTHOG = "https://us.posthog.com/api/projects/354457";
export const DASHBOARD = 2295680;
export const SOURCE = "01a17c34-360e-0000-509d-3ae02d9d3fed";
/** The warehouse prefix of SOURCE's tables in HogQL (source prefix "prod", source type Convex). */
export const TABLE_PREFIX = "prodconvex_";
export const STATE_EVENTS = ["prospect_state_day", "watchlist_reads_day"] as const;
export type StateEvent = (typeof STATE_EVENTS)[number];
/** The day both events were first sent anywhere (staging, 11-03), so an age query reads nothing older. */
export const FIRST_SENT = "2026-11-03";
/**
 * An event is due once a UTC day: crons.ts runs pipeDays.fillDay at 04:41Z, and on 11-03 staging's events from the same cron landed from 04:42:01 to 04:42:32Z. A
 * day plus one hour leaves the fill its run time and a run that starts in the minute before the cron no false miss.
 */
export const EVENT_DUE_HOURS = 25;
/**
 * The "could not measure" value of the other prechecks (customer-api-failures.ts), so a missing source never reads on target. The at-least
 * headline takes its negative (chat-duties.ts PLACEHOLDER): on 11-04 at 06:15Z one "fetch failed" scored the tiles 0% and the run read a
 * miss, while a rerun two minutes later read 18 of 18.
 */
export const UNMEASURED = 999_999;
/**
 * PostHog answers 429 when a project runs too many queries at once, and 502 to 504 when it is busy: slack-green-numbers.ts lost a query to
 * a 429 with 24 tiles at once and saw a 503 answer 200 eight minutes later on 10-19. So tiles run TILE_CONCURRENCY at a time, as there, and
 * a busy answer waits RETRY_MS times the attempt and tries again up to RETRIES times.
 */
export const TILE_CONCURRENCY = 4;
const RETRIES = 4;
const RETRY_MS = 5_000;
const BUSY = new Set([429, 502, 503, 504]);
/** On 11-04 the 18 tiles took 1.3 to 20.9 s each with refresh "blocking", so an async run is polled every 2 s. */
const POLL_MS = 2_000;
const HOUR = 3_600_000;

export interface TileRead { id: number; name: string; error?: string; rows?: unknown[][] }
export interface SchemaRow { id: string; name: string; should_sync: boolean; status: string | null; last_synced_at: string | null;
  sync_frequency: string | null; latest_error: string | null; last_run_at?: string | null }
export interface TableProblem { name: string; why: string }
type Read<T> = T | { error: string };
export interface Sources { tiles: Read<TileRead[]>; schemas: Read<SchemaRow[]>; required: string[]; newest: Read<Partial<Record<StateEvent, string>>> }

const isErr = <T,>(value: Read<T>): value is { error: string } => typeof value === "object" && value !== null && "error" in value;

/** True when some cell is a finite number, 0 included: a tile of only nulls, labels and dates, or no row at all, is blank. */
export const hasData = (rows: readonly unknown[][]): boolean =>
  rows.some(row => row.some(cell => typeof cell === "number" && Number.isFinite(cell)));

/** A sync_frequency such as "1hour", "6hour", "30min", "1day" or "7day" in ms, or null for one it cannot read. */
export function intervalMs(frequency: string | null): number | null {
  const match = /^(\d+)\s*(min|hour|day|week)s?$/.exec(frequency ?? "");
  if (!match) return null;
  const unit = { min: 60_000, hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR }[match[2] as "min" | "hour" | "day" | "week"];
  return Number(match[1]) * unit;
}

/** The SOURCE tables that tile queries read, by their lowercased name (`prodconvex_orgmembers` is orgmembers). */
export const tilesTables = (queries: readonly string[]): string[] =>
  [...new Set(queries.flatMap(query => [...query.matchAll(new RegExp(`\\b${TABLE_PREFIX}(\\w+)`, "g"))].map(match => match[1]!.toLowerCase())))].sort();

/** Each table to check that is paused, failed or stale, with why. `required` holds the lowercased names a tile reads. */
export function tableProblems(schemas: readonly SchemaRow[], required: readonly string[], now: number): TableProblem[] {
  const needed = new Set(required);
  const problems: TableProblem[] = [];
  for (const name of needed) if (!schemas.some(schema => schema.name.toLowerCase() === name)) problems.push({ name, why: "a tile reads it, but the source has no such table" });
  for (const schema of schemas) {
    if (!schema.should_sync && !needed.has(schema.name.toLowerCase())) continue;
    const err = schema.latest_error ? `: ${schema.latest_error.slice(0, 200)}` : "";
    if (!schema.should_sync) { problems.push({ name: schema.name, why: `a tile reads it, but its sync is off (status ${schema.status ?? "none"})${err}` }); continue; }
    if (schema.status !== "Completed" && schema.status !== "Running") { problems.push({ name: schema.name, why: `status ${schema.status ?? "none"}${err}` }); continue; }
    const every = intervalMs(schema.sync_frequency);
    const times = [schema.last_synced_at, schema.last_run_at].filter((at): at is string => !!at).map(at => Date.parse(at)).filter(at => !Number.isNaN(at));
    const last = times.length ? Math.max(...times) : NaN;
    if (Number.isNaN(last)) { problems.push({ name: schema.name, why: "never synced" }); continue; }
    if (every !== null && now - last > 2 * every) {
      problems.push({ name: schema.name, why: `last sync ${new Date(last).toISOString().slice(0, 16)}Z, ${round((now - last) / HOUR)} h ago, over twice its ${schema.sync_frequency} interval` });
    }
  }
  return problems;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function report(sources: Sources, now: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  if (isErr(sources.tiles)) {
    metrics.tiles_with_data_pct = -UNMEASURED;
    flagged.push({ at: now, kind: "source_error", excerpt: `dashboard ${DASHBOARD}: ${sources.tiles.error}` });
  } else {
    const tiles = sources.tiles;
    const shown = tiles.filter(tile => !tile.error && tile.rows && hasData(tile.rows));
    metrics.tiles_with_data_pct = tiles.length ? round((100 * shown.length) / tiles.length) : 0;
    metrics.tiles_failing = tiles.filter(tile => tile.error).length;
    metrics.tiles_empty = tiles.length - shown.length - metrics.tiles_failing;
    flagged.push({ at: now, kind: "dashboard", excerpt: `${shown.length} of ${tiles.length} tiles of https://us.posthog.com/project/354457/dashboard/${DASHBOARD} show data` });
    for (const tile of tiles) {
      if (tile.error) flagged.push({ at: now, kind: "tile_failing", excerpt: `tile ${tile.id} "${tile.name}": ${tile.error}` });
      else if (!tile.rows || !hasData(tile.rows)) flagged.push({ at: now, kind: "tile_empty", excerpt: `tile ${tile.id} "${tile.name}": ${tile.rows?.length ?? 0} rows, no number` });
    }
  }
  if (isErr(sources.schemas)) {
    metrics.source_tables_failing = UNMEASURED;
    flagged.push({ at: now, kind: "source_error", excerpt: `warehouse source ${SOURCE}: ${sources.schemas.error}` });
  } else {
    const problems = tableProblems(sources.schemas, sources.required, now);
    metrics.source_tables_failing = problems.length;
    for (const problem of problems) flagged.push({ at: now, kind: "table_failing", excerpt: `${problem.name}: ${problem.why}` });
  }
  for (const event of STATE_EVENTS) {
    const key = `${event}_age_h`;
    if (isErr(sources.newest)) { metrics[key] = UNMEASURED; continue; }
    // An event prod never sent is a measured miss: the query read every day since FIRST_SENT, so it is at least as old as the first
    // fill of that day. Unmeasured made each run on 11-04 read as a broken precheck while the senders waited on the prod promote.
    const at = sources.newest[event] ? Date.parse(sources.newest[event]!) : NaN;
    metrics[key] = round((now - (Number.isNaN(at) ? Date.parse(`${FIRST_SENT}T04:41:00Z`) : at)) / HOUR);
    const when = Number.isNaN(at) ? `none since ${FIRST_SENT}, so over ${metrics[key]} h` : `newest ${new Date(at).toISOString().slice(0, 16)}Z, ${metrics[key]} h ago`;
    if (metrics[key]! > EVENT_DUE_HOURS) flagged.push({ at: now, kind: "event_late", excerpt: `prod ${event}: ${when}, due every day from pipeDays.fillDay at 04:41Z` });
  }
  if (isErr(sources.newest)) flagged.push({ at: now, kind: "source_error", excerpt: `prod event ages: ${sources.newest.error}` });
  return { metrics, flagged };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)\S+/g, "$1***").slice(0, 300);

export interface Deps { fetch: typeof fetch; now: () => number; key: string; sleep?: (ms: number) => Promise<void> }
const pause = (deps: Deps, ms: number): Promise<void> => (deps.sleep ?? (wait => new Promise(resolve => setTimeout(resolve, wait))))(ms);

async function api<T>(deps: Deps, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await deps.fetch(`${POSTHOG}/${path}`, { method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" }, ...body ? { body: JSON.stringify(body) } : {} });
    const text = await response.text();
    if (BUSY.has(response.status) && attempt < RETRIES) { await pause(deps, RETRY_MS * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${path.replace(/\?.*/, "")} answered ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }
}

interface QueryAnswer { results?: unknown[][]; error?: string | null; query_status?: QueryStatus }
interface QueryStatus { id: string; complete?: boolean; error?: boolean; error_message?: string | null; results?: QueryAnswer }

/** Runs one tile's query as the dashboard does and gives its rows, or its error. */
export async function loadTile(deps: Deps, query: unknown): Promise<{ rows?: unknown[][]; error?: string }> {
  try {
    const answer = await api<QueryAnswer>(deps, "query/", { query, refresh: "async" });
    if (answer.error) return { error: answer.error };
    if (answer.results !== undefined) return { rows: answer.results };
    let status = answer.query_status;
    while (status && !status.complete) {
      await pause(deps, POLL_MS);
      status = (await api<{ query_status: QueryStatus }>(deps, `query/${status.id}/`)).query_status;
    }
    if (!status) return { error: "no results and no query status" };
    if (status.error) return { error: status.error_message || "query error" };
    if (status.results?.error) return { error: status.results.error };
    return { rows: status.results?.results ?? [] };
  } catch (error) { return { error: message(error) }; }
}

/** Runs `work` over `items` with at most `limit` at once, results in order. */
async function pool<I, O>(items: readonly I[], limit: number, work: (item: I) => Promise<O>): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

type Insight = { id: number; name?: string | null; query?: unknown };

export async function readDashboard(deps: Deps): Promise<{ tiles: TileRead[]; required: string[] }> {
  const dashboard = await api<{ tiles: { insight?: Insight | null }[] }>(deps, `dashboards/${DASHBOARD}/`);
  const insights = dashboard.tiles.map(tile => tile.insight).filter((insight): insight is Insight => !!insight?.query);
  const tiles = await pool(insights, TILE_CONCURRENCY, async (insight): Promise<TileRead> =>
    ({ id: insight.id, name: insight.name ?? "", ...await loadTile(deps, insight.query) }));
  return { tiles, required: tilesTables(insights.map(insight => JSON.stringify(insight.query))) };
}

/**
 * The newest prod event of each STATE_EVENTS name: its orgId is a prod Convex org and its appEnv, when it has one, is production. Dev
 * backends sent prospect_state_day with dev org ids into 354457 on 11-03, so an event from any other org never counts.
 */
export const newestQuery = (): string => `SELECT event, max(timestamp) FROM events WHERE event IN (${STATE_EVENTS.map(event => `'${event}'`).join(", ")}) ` +
  `AND timestamp >= toDateTime('${FIRST_SENT} 00:00:00', 'UTC') AND coalesce(properties.appEnv, 'production') = 'production' ` +
  `AND properties.orgId IN (SELECT org_id FROM ${TABLE_PREFIX}orgs) GROUP BY event`;

export async function readNewest(deps: Deps): Promise<Partial<Record<StateEvent, string>>> {
  const answer = await api<QueryAnswer>(deps, "query/", { query: { kind: "HogQLQuery", query: newestQuery() }, refresh: "blocking" });
  if (answer.error) throw new Error(answer.error);
  return Object.fromEntries((answer.results ?? []).map(([event, at]) => [String(event), String(at)]));
}

interface SyncJob { status: string; finished_at: string | null; created_at: string }

/** Each checked table with last_run_at set to the end of its newest Completed job, a run that brought no rows included. */
export async function readSchemas(deps: Deps, required: readonly string[]): Promise<SchemaRow[]> {
  const { schemas } = await api<{ schemas: SchemaRow[] }>(deps, `external_data_sources/${SOURCE}/`);
  const needed = new Set(required);
  return Promise.all(schemas.map(async schema => {
    if (!schema.should_sync && !needed.has(schema.name.toLowerCase())) return schema;
    const answer = await api<SyncJob[] | { results: SyncJob[] }>(deps, `external_data_sources/${SOURCE}/jobs/?schemas=${encodeURIComponent(schema.name)}`);
    const run = (Array.isArray(answer) ? answer : answer.results).find(job => job.status === "Completed");
    return { ...schema, last_run_at: run ? run.finished_at ?? run.created_at : null };
  }));
}

export async function measure(deps: Deps): Promise<PrecheckOutput> {
  const now = deps.now();
  const fail = (error: unknown) => ({ error: message(error) });
  const [dashboard, newest] = await Promise.all([readDashboard(deps).catch(fail), readNewest(deps).catch(fail)]);
  const tiles = isErr(dashboard) ? dashboard : dashboard.tiles;
  const required = isErr(dashboard) ? ["orgs", "orgmembers"] : dashboard.required;
  const schemas = await readSchemas(deps, required).catch(fail);
  return report({ tiles, schemas, required, newest }, now);
}

const sh = (command: string, cwd: string): Promise<string> => new Promise((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { cwd, encoding: "utf8" }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message.split("\n")[0]} ${String(stderr).trim().slice(-200)}`)) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("prospect-dashboard: OUTPUT_FILE is not set\n"); process.exit(2); }
  const result = await sh("node_modules/.bin/dotenvx get POSTHOG_ADMIN_API_KEY -f apps/search/.env", REPO).then(
    async text => measure({ fetch, now: Date.now, key: text.trim().split("\n").at(-1)!.trim() }),
    (error: unknown): PrecheckOutput => ({ metrics: { tiles_with_data_pct: -UNMEASURED, source_tables_failing: UNMEASURED,
      ...Object.fromEntries(STATE_EVENTS.map(event => [`${event}_age_h`, UNMEASURED])) },
      flagged: [{ at: Date.now(), kind: "source_error", excerpt: `POSTHOG_ADMIN_API_KEY from ${REPO}/apps/search/.env: ${message(error)}` }] }));
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
