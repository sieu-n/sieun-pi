import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, PG, PROM, SOURCE_DEADLINE_MS, grafanaClient, promInstant, readGrafanaAuth, round1, settle, sqlRows, ssh, unmeasuredFlag,
} from "./estate-reads.ts";

/**
 * The Watchlist shows green duty's precheck for launch main bro (`node --import tsx scripts/duties/watchlist-green.ts`). Code only, no model
 * call, reads only. It measures goal p35 (the Watchlist screen, /app/analytics/monitor, all green on staging and prod, collabs included) from:
 * - the owner org's watch keys: prod Convex befitting-sparrow-356, internalQuery search/watchTargets:pageKeys with orgId, paged in this one node
 *   process with an admin key the owner's Convex CLI login (~/.convex/config.json) authorizes, the call `convex run --deployment-name` makes;
 * - prod watch_targets monitor rows and the watch runs settled in 24 h (watch_target_claims): one ssh to us-metal01, psql as owner_ro in a
 *   read-only transaction (grafana_ro cannot read watch_targets), and staging watch_targets monitor rows the same way from virev-staging-postgres;
 * - the prod watch gauges of estate_prometheus through Grafana (detail and the loop age), and pause.watch from estate_pg_prod.
 * Green follows sessions/2026/10/10/1026-prod-watchlist-readback/findings.md in auto-sns-agent: an unpaused monitor row whose last_outcome is
 * ok and whose last_run_at is inside 24 h. An owner account is green when every watch the org has on it (posts and collab) is green.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "watchlist-green.duty.json");

/*
 * The four judged metrics in watchlist-green.duty.json (c75: one headline and at most 3 more) and their sources:
 * - owner_green_pct >= 100 is the headline: the owner, 10-09, "make this screen functional all green, including collabs", and 10-10, "most
 *   importantly staging and prod watchlist all green". An owner account is green when every watch on it, posts and collab, is green.
 * - staging_green_pct >= 100: the staging half of that sentence. It is the share of unpaused staging monitor rows, posts and collabs, read ok in
 *   24 h, from staging watch_targets itself, so a row whose reads keep failing counts (the overdue gauge misses those, health.py _NO_GOOD_READ).
 *   Paused staging rows are out of the staging Watchlist by design: the owner's t17 answer asked for "only like 10 accounts" in staging.
 * - collab_pushed_pct >= 100: the same "including collabs"; a collab watch with no unpaused prod tagged monitor row can never turn green.
 * - prod_read_error_pct <= READ_ERROR_TARGET_PCT: the error share of prod watch runs that settled with an answer (ok, error or gone) in 24 h, from
 *   watch_target_claims. A proxy connect a retry recovered settles ok, so it is no error here (c73: up to about half of connects fail by design).
 *   Starved runs (no account free) and superseded runs never asked Instagram, so they are detail lines.
 * The rest is run detail, written to output.metrics after the judged keys and never judged: prod_posts_fresh_pct, prod_loop_age_s,
 * staging_posts_green_pct, staging_tagged_not_green and source_errors. A failed source still misses the metrics it feeds (NEEDS), and a prod
 * watch scheduler loop that is stalled past LOOP_STALL_S, or never ticked, misses prod_read_error_pct, since no read can finish while it stands.
 * The schedule, daily at 06:28 (c66), runs the Convex walk (22 pages, 10.4 s measured 2026-10-12) and the two ssh reads once a day.
 * The duty's timeoutMs 120000 is the runner's own cap, PRECHECK_TIMEOUT_MS in src/shared/chat-duties.ts.
 */

/**
 * The normal error share of finished prod watch reads, measured 2026-10-15 from prod watch_target_claims (settled runs per hour by outcome,
 * 10-09 to 10-15): before the 10-14 06Z scrape_blocked incident, the 38 hours from 10-12 00Z to 10-14 06Z with at least 100 finished reads had a
 * median of 1.4% and a 75th percentile of 4.6%; the 32 of them without an incident pooled 1.6% (90th percentile 4.6%), and the whole day of 10-12
 * read 1.4%. The incident hours ran 17% to 66%, and 10-14 and 10-15 ran 55% and 50% (scrape_blocked on 7,910 posts rows). 5% sits above every
 * normal hour's 75th percentile and below every incident hour.
 */
export const READ_ERROR_TARGET_PCT = 5;
/** The prod watch-scheduler alert, apps/infra/metal/config/obs/grafana/alerting/crawler-health.yaml (loop age over 300 s). */
export const LOOP_STALL_S = 300;

/** The owner's org on prod, from findings.md ("the only prod org with about 9,846 watched accounts"). */
export const OWNER_ORG = "org_3IrtoOAEP0nk1aCQHGVME02Dy6E";
export const PROD_CONVEX = "befitting-sparrow-356";

export type Source = "grafana auth" | "prod gauges" | "prod config" | "convex keys" | "prod rows" | "staging rows";
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  owner_green_pct: ["convex keys", "prod rows"], collab_pushed_pct: ["convex keys", "prod rows"], staging_green_pct: ["staging rows"],
  prod_read_error_pct: ["prod rows", "grafana auth", "prod gauges", "prod config"],
};

/** One watch_targets monitor row: platform, kind (posts, tagged, post, ads), lower-case target. */
export interface WatchRow { platform: string; kind: string; target: string; paused: boolean; lastOutcome: string; lastRunAt: number | null }
export interface Gauges { rows: Record<string, number>; overdue: Record<string, number>; loopAge?: number }
export interface WatchData {
  now: number;
  keys?: string[]; rows?: WatchRow[]; receipts?: Record<string, number>; staging?: WatchRow[]; prod?: Gauges; pauseWatch?: string;
  errors: { source: Source; message: string }[];
}

/** A Convex watch key `platform:kind:target` as the watch_targets row it pushes: Convex kind `account` is the `posts` row. */
export function rowKeyOf(key: string): { platform: string; kind: string; target: string } | null {
  const [platform, kind, ...rest] = key.split(":");
  if (!platform || !kind || !rest.length) return null;
  return { platform, kind: kind === "account" ? "posts" : kind, target: rest.join(":").toLowerCase() };
}
const id = (row: { platform: string; kind: string; target: string }): string => `${row.platform}:${row.kind}:${row.target}`;
export const isGreen = (row: WatchRow | undefined, now: number): boolean =>
  !!row && !row.paused && row.lastOutcome === "ok" && row.lastRunAt !== null && now - row.lastRunAt <= DAY;
/** Why a watch is not green, as a flag phrase. */
const notGreen = (kind: string, row: WatchRow | undefined): string => !row ? `${kind} no monitor row` : row.paused ? `${kind} paused`
  : !row.lastOutcome ? `${kind} never ran` : row.lastOutcome !== "ok" ? `${kind} last ${row.lastOutcome}` : `${kind} ok but older than 24 h`;
const tally = (why: Map<string, number>): [string, number][] => [...why.entries()].sort((a, b) => b[1] - a[1]);
const listWhy = (why: readonly [string, number][]): string => why.map(([reason, count]) => `${count} ${reason}`).join(", ");

/** The owner's accounts and their green share, and the collab watches with an unpaused monitor row. */
export function ownerGreen(keys: readonly string[], rows: readonly WatchRow[], now: number) {
  const byId = new Map(rows.map(row => [id(row), row]));
  const accounts = new Map<string, boolean>();
  const why = new Map<string, number>();
  let collabs = 0;
  let pushed = 0;
  let unread = 0;
  for (const key of keys) {
    const want = rowKeyOf(key);
    if (!want) { unread++; continue; }
    const row = byId.get(id(want));
    const green = isGreen(row, now);
    const account = `${want.platform}:${want.target}`;
    accounts.set(account, (accounts.get(account) ?? true) && green);
    if (want.kind === "tagged") { collabs++; if (row && !row.paused) pushed++; }
    if (!green) { const reason = notGreen(want.kind, row); why.set(reason, (why.get(reason) ?? 0) + 1); }
  }
  const green = [...accounts.values()].filter(Boolean).length;
  return { accounts: accounts.size, green, collabs, pushed, unread, why: tally(why) };
}

/** The unpaused monitor rows of the given kinds (posts and tagged: the Watchlist's posts and collabs), how many are green, and why the rest are not. */
export function rowsGreen(rows: readonly WatchRow[], now: number, kinds: readonly string[] = ["posts", "tagged"]) {
  const live = rows.filter(row => !row.paused && kinds.includes(row.kind));
  const why = new Map<string, number>();
  const byKind: Record<string, { rows: number; green: number }> = Object.fromEntries(kinds.map(kind => [kind, { rows: 0, green: 0 }]));
  for (const row of live) {
    const green = isGreen(row, now);
    byKind[row.kind]!.rows++;
    if (green) byKind[row.kind]!.green++;
    else { const reason = notGreen(row.kind, row); why.set(reason, (why.get(reason) ?? 0) + 1); }
  }
  return { rows: live.length, green: Object.values(byKind).reduce((sum, kind) => sum + kind.green, 0), byKind, why: tally(why) };
}

/** Rows read ok in 24 h, in percent, from the monitor-tier rows and overdue_24h gauges of one kind; 0 rows reads 0. */
export function freshPct(gauges: Gauges, kind: string): number {
  const rows = gauges.rows[`${kind}/monitor`] ?? 0;
  return rows ? round1(100 * (1 - (gauges.overdue[`${kind}/monitor`] ?? 0) / rows)) : 0;
}

/** The outcomes of a run that asked Instagram and got an answer: the finished reads prod_read_error_pct divides by. */
export const FINISHED = ["ok", "error", "gone"] as const;

export function report(data: WatchData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const { now } = data;
  const at = now;
  const metrics: Record<string, number> = {};
  const detail: Record<string, number> = { source_errors: data.errors.length };
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  const failed = new Set(data.errors.map(error => error.source));
  const unmeasured = new Set(Object.keys(NEEDS).filter(key => NEEDS[key]!.some(source => failed.has(source))));
  if (data.keys && data.rows) {
    const owner = ownerGreen(data.keys, data.rows, now);
    metrics.owner_green_pct = owner.accounts ? round1(100 * owner.green / owner.accounts) : 0;
    metrics.collab_pushed_pct = owner.collabs ? round1(100 * owner.pushed / owner.collabs) : 100;
    flagged.push({ at, kind: "owner_watchlist", excerpt: `${owner.green} of ${owner.accounts} owner org accounts green on prod; ${owner.pushed} of ${owner.collabs} collab watches have an unpaused prod tagged monitor row` +
      (owner.why.length ? `; watches not green: ${listWhy(owner.why)}` : "") + (owner.unread ? `; ${owner.unread} keys not in platform:kind:target form` : "") });
    if (!owner.accounts) flagged.push({ at, kind: "no_keys", excerpt: `Convex pageKeys returned no watch key for ${OWNER_ORG}` });
  }
  if (data.staging) {
    const staging = rowsGreen(data.staging, now);
    metrics.staging_green_pct = staging.rows ? round1(100 * staging.green / staging.rows) : 0;
    const posts = staging.byKind.posts!;
    const tagged = staging.byKind.tagged!;
    detail.staging_posts_green_pct = posts.rows ? round1(100 * posts.green / posts.rows) : 0;
    detail.staging_tagged_not_green = tagged.rows - tagged.green;
    flagged.push({ at, kind: "staging_monitor_rows", excerpt: `${staging.green} of ${staging.rows} unpaused staging monitor rows read ok in 24 h: posts ${posts.green} of ${posts.rows}, collabs ${tagged.green} of ${tagged.rows}` +
      (staging.why.length ? `; not green: ${listWhy(staging.why)}` : "") + `; ${data.staging.length - staging.rows} paused or other rows are left out (t17: "only like 10 accounts" in staging)` });
    if (!staging.rows) flagged.push({ at, kind: "no_staging_rows", excerpt: "staging watch_targets has no unpaused posts or tagged monitor row, so the staging Watchlist is empty" });
  }
  if (data.receipts) {
    const finished = FINISHED.reduce((sum, outcome) => sum + (data.receipts![outcome] ?? 0), 0);
    const outcomes = Object.entries(data.receipts).sort((a, b) => b[1] - a[1]).map(([outcome, value]) => `${value} ${outcome}`).join(", ") || "none";
    if (finished) metrics.prod_read_error_pct = round1(100 * (data.receipts.error ?? 0) / finished);
    else { unmeasured.add("prod_read_error_pct"); flagged.push({ at, kind: "no_reads", excerpt: `no prod watch run settled ok, error or gone in the last 24 h (runs: ${outcomes})` }); }
    flagged.push({ at, kind: "prod_reads", excerpt: `prod watch runs settled in 24 h: ${outcomes}; ${finished} finished reads (ok, error, gone), target error share at most ${READ_ERROR_TARGET_PCT}%` });
  }
  if (data.prod) {
    detail.prod_posts_fresh_pct = freshPct(data.prod, "posts");
    const loop = data.prod.loopAge;
    if (loop === undefined || !Number.isFinite(loop)) {
      unmeasured.add("prod_read_error_pct");
      flagged.push({ at, kind: "loop", excerpt: "prod crawler_v3_watch_targets_loop_age_seconds is NaN or missing: the watch scheduler never ticked since the API started, so prod_read_error_pct misses" });
    } else {
      detail.prod_loop_age_s = Math.round(loop);
      if (loop > LOOP_STALL_S) { unmeasured.add("prod_read_error_pct"); flagged.push({ at, kind: "loop", excerpt: `the prod watch scheduler last ticked ${Math.round(loop)} s ago, past the ${LOOP_STALL_S} s alert line, so prod_read_error_pct misses` }); }
    }
    flagged.push({ at, kind: "prod_monitor_rows", excerpt: `prod monitor rows: posts ${data.prod.rows["posts/monitor"] ?? 0} (${data.prod.overdue["posts/monitor"] ?? 0} overdue past 24 h), tagged ${data.prod.rows["tagged/monitor"] ?? 0} (${data.prod.overdue["tagged/monitor"] ?? 0} overdue)` });
  }
  if (data.pauseWatch === "true") flagged.push({ at, kind: "pause", excerpt: "prod pause.watch is true, so the watch scheduler claims nothing" });
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics: { ...metrics, ...detail }, flagged };
}

/** The tab-separated monitor rows the remote psql prints: platform, kind, target, paused (t or f), last_outcome, last_run_at epoch ms or empty. */
export function parseRows(text: string): WatchRow[] {
  const rows: WatchRow[] = [];
  for (const line of text.split("\n")) {
    const cells = line.split("\t");
    if (cells.length !== 6) continue;
    const [platform, kind, target, paused, lastOutcome, lastRunAt] = cells as [string, string, string, string, string, string];
    rows.push({ platform, kind, target, paused: paused === "t", lastOutcome, lastRunAt: lastRunAt ? Number(lastRunAt) : null });
  }
  return rows;
}

/** The `receipt<TAB>outcome<TAB>runs` lines the prod read prints after the rows: watch runs settled in the last 24 h, per outcome. */
export function parseReceipts(text: string): Record<string, number> {
  const receipts: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const cells = line.split("\t");
    if (cells.length === 3 && cells[0] === "receipt") receipts[cells[1]!] = Number(cells[2]);
  }
  return receipts;
}

/** One gauge read as `kind/tier` -> value. */
export const byKindTier = (series: { labels: Record<string, string>; value: number }[]): Record<string, number> =>
  Object.fromEntries(series.map(item => [`${item.labels.kind ?? "?"}/${item.labels.tier ?? "?"}`, item.value]));

async function gauges(query: DsQuery): Promise<Gauges> {
  const uid = PROM.prod;
  const [rows, overdue, loop] = await Promise.all([
    promInstant(query, uid, `max by (kind, tier)(crawler_v3_watch_targets_rows{world="prod"})`),
    promInstant(query, uid, `max by (kind, tier)(crawler_v3_watch_targets_overdue_24h_by_tier{world="prod"})`),
    promInstant(query, uid, `max(crawler_v3_watch_targets_loop_age_seconds{world="prod"})`),
  ]);
  if (!rows.length || !overdue.length) throw new Error("no crawler_v3_watch_targets_rows or overdue_24h_by_tier series for world prod");
  return { rows: byKindTier(rows), overdue: byKindTier(overdue), ...(loop[0] ? { loopAge: loop[0].value } : {}) };
}

/** Every distinct watch key of one org on prod Convex, read with the owner's Convex CLI login. */
export async function convexKeys(fetcher: typeof fetch, accessToken: string, signal: AbortSignal): Promise<string[]> {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" };
  const auth = await fetcher("https://api.convex.dev/api/deployment/authorize_within_current_project", { method: "POST", headers, signal,
    body: JSON.stringify({ selectedDeploymentName: PROD_CONVEX, projectSelection: { kind: "deploymentName", deploymentName: PROD_CONVEX, deploymentType: null } }) });
  const credentials = await auth.json().catch(() => null) as { adminKey?: string; url?: string } | null;
  if (!auth.ok || !credentials?.adminKey || !credentials.url) throw new Error(`Convex authorize for ${PROD_CONVEX} gave HTTP ${auth.status}`);
  const keys = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const response = await fetcher(`${credentials.url}/api/query`, { method: "POST", signal,
      headers: { authorization: `Convex ${credentials.adminKey}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" },
      body: JSON.stringify({ path: "search/watchTargets:pageKeys", args: { orgId: OWNER_ORG, cursor }, format: "json" }) });
    const body = await response.json().catch(() => null) as { status?: string; errorMessage?: string; value?: { keys: string[]; continueCursor: string; isDone: boolean } } | null;
    if (body?.status !== "success" || !body.value) throw new Error(`pageKeys: HTTP ${response.status} ${String(body?.errorMessage ?? "no value").slice(0, 200)}`);
    body.value.keys.forEach(key => keys.add(key));
    if (body.value.isDone) return [...keys];
    cursor = body.value.continueCursor;
  }
}

const ROWS_SQL = "select platform, kind, lower(target), case when paused then 't' else 'f' end, coalesce(last_outcome, ''), coalesce((extract(epoch from last_run_at) * 1000)::bigint::text, '') from watch_targets where tier = 'monitor';";
const RECEIPTS_SQL = "select 'receipt', outcome, count(*) from watch_target_claims where settled_at > now() - interval '24 hours' and outcome is not null group by outcome;";

/** A read of one world's crawler_v3 on us-metal01 as owner_ro in a read-only transaction, the path crawler-pipeline.mjs uses. */
export const remoteRead = (container: string, passwordFile: string, sql: string): string => `set -u
PW=$(tr -d '\\n' < /root/${passwordFile})
docker exec -i -e PGAPPNAME=watchlist-green-duty -e PGPASSWORD="$PW" ${container} psql -X -h 127.0.0.1 -U owner_ro -d crawler_v3 -q -t -A -F '\t' -v ON_ERROR_STOP=1 <<'SQL'
set default_transaction_read_only = on;
${sql}
SQL
`;
/** Prod: the monitor rows, then the watch runs settled in 24 h per outcome. */
export const REMOTE = remoteRead("virev-prod-postgres", "prod-pg-owner-ro.txt", `${ROWS_SQL}\n${RECEIPTS_SQL}`);
/** Staging: the monitor rows. */
export const STAGING_REMOTE = remoteRead("virev-staging-postgres", "staging-pg-owner-ro.txt", ROWS_SQL);

export interface WatchDeps { query: DsQuery | null; authError: string | null; keys: () => Promise<string[]>; rows: () => Promise<string>; staging: () => Promise<string>; now: number }

export async function measure(deps: WatchDeps): Promise<WatchData> {
  const data: WatchData = { now: deps.now, errors: [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const query = deps.query;
  if (!query) {
    data.errors.push({ source: "grafana auth", message: deps.authError ?? "no Grafana login" });
    for (const source of ["prod gauges", "prod config"] as const) data.errors.push({ source, message: "not read: no Grafana login" });
  }
  const [keys, prodText, stagingText, prod, pause] = await Promise.all([
    step("convex keys", deps.keys),
    step("prod rows", deps.rows),
    step("staging rows", deps.staging),
    query ? step("prod gauges", () => gauges(query)) : undefined,
    query ? step("prod config", async () => String((await sqlRows(query, PG.prod, "select value from config where key = 'pause.watch'"))[0]?.value ?? "")) : undefined,
  ]);
  const rows = prodText === undefined ? undefined : parseRows(prodText);
  const staging = stagingText === undefined ? undefined : parseRows(stagingText);
  if (rows && !rows.length) data.errors.push({ source: "prod rows", message: "the ssh read returned no prod watch_targets monitor row" });
  if (staging && !staging.length) data.errors.push({ source: "staging rows", message: "the ssh read returned no staging watch_targets monitor row" });
  Object.assign(data, keys && { keys }, rows?.length && { rows, receipts: parseReceipts(prodText!) }, staging?.length && { staging },
    prod && { prod }, pause !== undefined && { pauseWatch: pause });
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("watchlist-green: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  const signal = AbortSignal.timeout(SOURCE_DEADLINE_MS);
  let query: DsQuery | null = null;
  let authError: string | null = null;
  try { query = grafanaClient(fetch, await readGrafanaAuth(), now, signal); } catch (error) { authError = error instanceof Error ? error.message : String(error); }
  const data = await measure({ query, authError, now,
    keys: async () => convexKeys(fetch, (JSON.parse(await readFile(join(homedir(), ".convex/config.json"), "utf8")) as { accessToken: string }).accessToken, signal),
    rows: () => ssh(REMOTE, signal), staging: () => ssh(STAGING_REMOTE, signal) });
  const result = report(data, dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`watchlist-green: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
