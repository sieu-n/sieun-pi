import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, PG, PROM, SOURCE_DEADLINE_MS, grafanaClient, promInstant, readGrafanaAuth, round1, settle, sqlRows, unmeasuredFlag,
} from "./estate-reads.ts";

/**
 * The Watchlist shows green duty's precheck for launch main bro (`node --import tsx scripts/duties/watchlist-green.ts`). Code only, no model
 * call, reads only. It measures goal p35 (the Watchlist screen, /app/analytics/monitor, all green on staging and prod, collabs included) from:
 * - the owner org's watch keys: prod Convex befitting-sparrow-356, internalQuery search/watchTargets:pageKeys with orgId, paged in this one node
 *   process with an admin key the owner's Convex CLI login (~/.convex/config.json) authorizes, the call `convex run --deployment-name` makes;
 * - prod watch_targets monitor rows: one ssh to us-metal01, psql as owner_ro in a read-only transaction (grafana_ro cannot read watch_targets);
 * - the watch gauges of estate_prometheus and estate_prometheus_stg through Grafana, and pause.watch from estate_pg_prod.
 * Green follows sessions/2026/10/10/1026-prod-watchlist-readback/findings.md in auto-sns-agent: an unpaused monitor row whose last_outcome is
 * ok and whose last_run_at is inside 24 h. An owner account is green when every watch the org has on it (posts and collab) is green.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "watchlist-green.duty.json");

/*
 * Targets in watchlist-green.duty.json and their sources:
 * - owner_green_pct >= 100, prod_posts_fresh_pct >= 100, staging_posts_fresh_pct >= 100 and prod_read_error_pct <= 0: the owner, 10-09,
 *   "make this screen functional all green, including collabs", and 10-10, "most importantly staging and prod watchlist all green".
 * - collab_pushed_pct >= 100: the same "including collabs"; a collab watch with no unpaused prod tagged monitor row can never turn green.
 * - prod_loop_age_s <= 300: the prod watch-scheduler alert, apps/infra/metal/config/obs/grafana/alerting/crawler-health.yaml (loop age over 300 s).
 * - staging_tagged_overdue <= 0: "including collabs" on staging; the gauge already counts only rows overdue past 24 h.
 * - source_errors <= 0: a source that failed is reported, never shown as green.
 * The 24 h freshness line is the one the gauges (crawler_v3_watch_targets_overdue_24h_by_tier) and findings.md use. The schedule, every
 * 120 min, keeps the Convex walk (22 pages, 10.4 s measured 2026-10-12) and the ssh read (3.2 s) to 12 a day; freshness is a 24 h window.
 * The duty's timeoutMs 120000 is the runner's own cap, PRECHECK_TIMEOUT_MS in src/shared/chat-duties.ts.
 */

/** The owner's org on prod, from findings.md ("the only prod org with about 9,846 watched accounts"). */
export const OWNER_ORG = "org_3IrtoOAEP0nk1aCQHGVME02Dy6E";
export const PROD_CONVEX = "befitting-sparrow-356";
const BOX = "root@64.34.205.243";

export type Source = "grafana auth" | "prod gauges" | "staging gauges" | "prod config" | "convex keys" | "prod rows";
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  owner_green_pct: ["convex keys", "prod rows"], collab_pushed_pct: ["convex keys", "prod rows"],
  prod_posts_fresh_pct: ["prod gauges"], prod_read_error_pct: ["prod gauges"], prod_loop_age_s: ["prod gauges"],
  staging_tagged_overdue: ["staging gauges"], staging_posts_fresh_pct: ["staging gauges"],
};

/** One watch_targets monitor row: platform, kind (posts, tagged, post, ads), lower-case target. */
export interface WatchRow { platform: string; kind: string; target: string; paused: boolean; lastOutcome: string; lastRunAt: number | null }
export interface Gauges { rows: Record<string, number>; overdue: Record<string, number>; receipts?: Record<string, number>; loopAge?: number }
export interface WatchData {
  now: number;
  keys?: string[]; rows?: WatchRow[]; prod?: Gauges; staging?: Gauges; pauseWatch?: string;
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
    if (!green) {
      const reason = !row ? `${want.kind} no monitor row` : row.paused ? `${want.kind} paused` : !row.lastOutcome ? `${want.kind} never ran`
        : row.lastOutcome !== "ok" ? `${want.kind} last ${row.lastOutcome}` : `${want.kind} ok but older than 24 h`;
      why.set(reason, (why.get(reason) ?? 0) + 1);
    }
  }
  const green = [...accounts.values()].filter(Boolean).length;
  return { accounts: accounts.size, green, collabs, pushed, unread, why: [...why.entries()].sort((a, b) => b[1] - a[1]) };
}

/** Rows read ok in 24 h, in percent, from the monitor-tier rows and overdue_24h gauges of one kind; 0 rows reads 0. */
export function freshPct(gauges: Gauges, kind: string): number {
  const rows = gauges.rows[`${kind}/monitor`] ?? 0;
  return rows ? round1(100 * (1 - (gauges.overdue[`${kind}/monitor`] ?? 0) / rows)) : 0;
}

export function report(data: WatchData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const { now } = data;
  const at = now;
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  const failed = new Set(data.errors.map(error => error.source));
  const unmeasured = new Set(Object.keys(NEEDS).filter(key => NEEDS[key]!.some(source => failed.has(source))));
  if (data.keys && data.rows) {
    const owner = ownerGreen(data.keys, data.rows, now);
    metrics.owner_green_pct = owner.accounts ? round1(100 * owner.green / owner.accounts) : 0;
    metrics.collab_pushed_pct = owner.collabs ? round1(100 * owner.pushed / owner.collabs) : 100;
    flagged.push({ at, kind: "owner_watchlist", excerpt: `${owner.green} of ${owner.accounts} owner org accounts green on prod; ${owner.pushed} of ${owner.collabs} collab watches have an unpaused prod tagged monitor row` +
      (owner.why.length ? `; watches not green: ${owner.why.map(([reason, count]) => `${count} ${reason}`).join(", ")}` : "") + (owner.unread ? `; ${owner.unread} keys not in platform:kind:target form` : "") });
    if (!owner.accounts) flagged.push({ at, kind: "no_keys", excerpt: `Convex pageKeys returned no watch key for ${OWNER_ORG}` });
  }
  if (data.prod) {
    metrics.prod_posts_fresh_pct = freshPct(data.prod, "posts");
    const receipts = data.prod.receipts ?? {};
    const total = Object.values(receipts).reduce((sum, value) => sum + value, 0);
    metrics.prod_read_error_pct = total ? round1(100 * (receipts.error ?? 0) / total) : 0;
    if (!total) flagged.push({ at, kind: "no_reads", excerpt: "prod crawler_v3_watch_targets_receipts_1h shows no watch read in the last hour" });
    else if (receipts.error) flagged.push({ at, kind: "read_errors", excerpt: `prod watch reads in the last hour: ${Object.entries(receipts).map(([outcome, value]) => `${value} ${outcome}`).join(", ")}` });
    if (data.prod.loopAge === undefined || !Number.isFinite(data.prod.loopAge)) { unmeasured.add("prod_loop_age_s"); flagged.push({ at, kind: "loop", excerpt: "prod crawler_v3_watch_targets_loop_age_seconds is NaN or missing: the watch scheduler never ticked since the API started" }); }
    else metrics.prod_loop_age_s = Math.round(data.prod.loopAge);
    flagged.push({ at, kind: "prod_monitor_rows", excerpt: `prod monitor rows: posts ${data.prod.rows["posts/monitor"] ?? 0} (${data.prod.overdue["posts/monitor"] ?? 0} overdue past 24 h), tagged ${data.prod.rows["tagged/monitor"] ?? 0} (${data.prod.overdue["tagged/monitor"] ?? 0} overdue)` });
  }
  if (data.staging) {
    metrics.staging_tagged_overdue = data.staging.overdue["tagged/monitor"] ?? 0;
    metrics.staging_posts_fresh_pct = freshPct(data.staging, "posts");
    flagged.push({ at, kind: "staging_monitor_rows", excerpt: `staging monitor rows: posts ${data.staging.rows["posts/monitor"] ?? 0} (${data.staging.overdue["posts/monitor"] ?? 0} overdue past 24 h), tagged ${data.staging.rows["tagged/monitor"] ?? 0} (${metrics.staging_tagged_overdue} overdue); the owner's t17 answer asked for "only like 10 accounts" monitored in staging` });
  }
  if (data.pauseWatch === "true") flagged.push({ at, kind: "pause", excerpt: "prod pause.watch is true, so the watch scheduler claims nothing" });
  metrics.source_errors = data.errors.length;
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics, flagged };
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

/** One gauge read as `kind/tier` -> value. */
export const byKindTier = (series: { labels: Record<string, string>; value: number }[]): Record<string, number> =>
  Object.fromEntries(series.map(item => [`${item.labels.kind ?? "?"}/${item.labels.tier ?? "?"}`, item.value]));

async function gauges(query: DsQuery, world: "prod" | "staging"): Promise<Gauges> {
  const uid = PROM[world];
  const [rows, overdue, receipts, loop] = await Promise.all([
    promInstant(query, uid, `max by (kind, tier)(crawler_v3_watch_targets_rows{world="${world}"})`),
    promInstant(query, uid, `max by (kind, tier)(crawler_v3_watch_targets_overdue_24h_by_tier{world="${world}"})`),
    promInstant(query, uid, `max by (outcome)(crawler_v3_watch_targets_receipts_1h{world="${world}"})`),
    promInstant(query, uid, `max(crawler_v3_watch_targets_loop_age_seconds{world="${world}"})`),
  ]);
  if (!rows.length || !overdue.length) throw new Error(`no crawler_v3_watch_targets_rows or overdue_24h_by_tier series for world ${world}`);
  return { rows: byKindTier(rows), overdue: byKindTier(overdue), receipts: Object.fromEntries(receipts.map(item => [item.labels.outcome ?? "?", item.value])),
    ...(loop[0] ? { loopAge: loop[0].value } : {}) };
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

/** The one remote read: prod watch_targets monitor rows as owner_ro in a read-only transaction, the path crawler-pipeline.mjs uses. */
export const REMOTE = `set -u
PW=$(tr -d '\\n' < /root/prod-pg-owner-ro.txt)
docker exec -i -e PGAPPNAME=watchlist-green-duty -e PGPASSWORD="$PW" virev-prod-postgres psql -X -h 127.0.0.1 -U owner_ro -d crawler_v3 -q -t -A -F '\t' -v ON_ERROR_STOP=1 <<'SQL'
set default_transaction_read_only = on;
select platform, kind, lower(target), case when paused then 't' else 'f' end, coalesce(last_outcome, ''), coalesce((extract(epoch from last_run_at) * 1000)::bigint::text, '') from watch_targets where tier = 'monitor';
SQL
`;

function ssh(script: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", BOX, "bash -s"], { stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`ssh exit ${code}: ${(err || out).trim().slice(-300)}`)));
    child.stdin.end(script);
  });
}

export interface WatchDeps { query: DsQuery | null; authError: string | null; keys: () => Promise<string[]>; rows: () => Promise<string>; now: number }

export async function measure(deps: WatchDeps): Promise<WatchData> {
  const data: WatchData = { now: deps.now, errors: [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const query = deps.query;
  if (!query) {
    data.errors.push({ source: "grafana auth", message: deps.authError ?? "no Grafana login" });
    for (const source of ["prod gauges", "staging gauges"] as const) data.errors.push({ source, message: "not read: no Grafana login" });
  }
  const [keys, rows, prod, staging, pause] = await Promise.all([
    step("convex keys", deps.keys),
    step("prod rows", async () => parseRows(await deps.rows())),
    query ? step("prod gauges", () => gauges(query, "prod")) : undefined,
    query ? step("staging gauges", () => gauges(query, "staging")) : undefined,
    query ? step("prod config", async () => String((await sqlRows(query, PG.prod, "select value from config where key = 'pause.watch'"))[0]?.value ?? "")) : undefined,
  ]);
  if (rows && !rows.length) data.errors.push({ source: "prod rows", message: "the ssh read returned no watch_targets monitor row" });
  Object.assign(data, keys && { keys }, rows?.length && { rows }, prod && { prod }, staging && { staging }, pause !== undefined && { pauseWatch: pause });
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
    rows: () => ssh(REMOTE, signal) });
  const result = report(data, dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`watchlist-green: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
