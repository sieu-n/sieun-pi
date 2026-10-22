import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, PG, PROM, REPO, SOURCE_DEADLINE_MS, grafanaClient, prodReader, promInstant, readGrafanaAuth, round1, settle, sqlRows, unmeasuredFlag,
} from "./estate-reads.ts";

/**
 * The Watchlist green duty's precheck for launch main bro (`node --import tsx scripts/duties/watchlist-green.ts`). Code only, no model
 * call, reads only. It measures goal p35 (the Watchlist screen, /app/analytics/monitor, all green on staging and prod, collabs included) from:
 * - the owner org's watch keys: prod Convex befitting-sparrow-356, internalQuery search/watchTargets:pageKeys with orgId, paged in this one node
 *   process with an admin key the owner's Convex CLI login (~/.convex/config.json) authorizes, the call `convex run --deployment-name` makes;
 * - prod watch_targets monitor rows and the watch runs settled in 24 h (watch_target_claims): one psql session as owner_ro in a read-only
 *   transaction (estate-reads.ts prodReader; grafana_ro cannot read watch_targets on prod), and staging watch_targets monitor rows from estate_pg_stg;
 * - the prod watch gauges of estate_prometheus through Grafana (detail and the loop age), and pause.watch from estate_pg_prod.
 * Green follows sessions/2026/10/10/1026-prod-watchlist-readback/findings.md in auto-sns-agent: an unpaused monitor row whose last_outcome is
 * ok and whose last_run_at is inside 24 h. An unpaused row on an account the platform removed or holds private is green at any age, as the
 * Watchlist reads it checked ("Removed on Instagram", "Private on Instagram", apps/search/src/lib/watchlist/words.ts walkGone and walkPrivate):
 * the crawler reads it again only on its weekly recheck. An unpaused row added under 24 h ago that the Watchlist does not read Stopped is green
 * too: it has its first day to be read, as crawler health.py _NO_GOOD_READ gives it. On 10-20 at 01:30:40Z d2 read staging at 98.1% for one
 * tagged row 40 s old, the glossier watch a hosted e2e run added at 01:30Z: the collab lane opened its run at 01:31Z and the run's cleanup
 * deleted the row at 01:37Z (crawler_v3_watch_targets_rows and lane_open_runs on estate_prometheus_stg). An owner account is green when every
 * watch the org has on it (posts and collab) is green.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "watchlist-green.duty.json");

/*
 * The four judged metrics in watchlist-green.duty.json (c75: one headline and at most 3 more) and their sources:
 * - owner_green_pct >= 100 is the headline: the owner, 10-09, "make this screen functional all green, including collabs", and 10-10, "most
 *   importantly staging and prod watchlist all green". An owner account is green when every watch on it, posts and collab, is green.
 * - staging_green_pct >= 100: the staging half of that sentence. It is the share of unpaused staging monitor rows, posts and collabs, read ok in
 *   24 h, from staging watch_targets itself, so a row whose reads keep failing counts (the overdue gauge misses those, health.py _NO_GOOD_READ).
 *   Paused staging rows are out of the staging Watchlist by design: the owner's t17 answer asked for "only like 10 accounts" in staging.
 * - watchlist_risks <= 0: the standing risks on the chat's risk page (wiki apps/crawler-v3/engage-reads-and-watchlist-risks) that fire, counted
 *   one each: an owner watch whose chip reads Stopped (stopReason below, the rules of apps/search/src/lib/watchlist/words.ts; p119) other than
 *   a hidden account, which the owner's t31 answer of 2026-10-21 keeps Stopped as an accepted state (isAcceptedHidden: green, no risk, its
 *   own owner_hidden line, where a dead doc_id, F16, shows as a wave), a prod Kafka stream whose unread records fill over BUS_FILL_LIMIT of its byte cap or whose
 *   broker retention.bytes differs from the registry in code (p116, the two crawler-bus-retention.yaml alerts), 1 while those byte gauges are
 *   missing on prod (no alert can fire then), and an owner collab watch with no unpaused prod tagged monitor row (it can never turn green).
 *   It took collab_pushed_pct's slot on 10-18 (c75); collab_pushed_pct stays as run detail.
 * - prod_read_error_pct <= READ_ERROR_TARGET_PCT: the error share of prod watch runs that settled with an answer (ok, error or gone) in 24 h, from
 *   watch_target_claims. A proxy connect a retry recovered settles ok, so it is no error here (c73: up to about half of connects fail by design).
 *   Starved runs (no account free) and superseded runs never asked Instagram, so they are detail lines.
 * The rest is run detail, written to output.metrics after the judged keys and never judged: collab_pushed_pct, owner_stopped_watches, prod_posts_fresh_pct, prod_loop_age_s,
 * staging_posts_green_pct, staging_tagged_not_green and source_errors. A failed source still misses the metrics it feeds (NEEDS), and a prod
 * watch scheduler loop that is stalled past LOOP_STALL_S, or never ticked, misses prod_read_error_pct, since no read can finish while it stands.
 * The schedule, daily at 06:28 (c66), runs the Convex walk (22 pages, 10.4 s measured 2026-10-12) and the owner_ro and staging reads once a day.
 * The duty's timeoutMs 120000 is the runner's soft target, PRECHECK_TARGET_MS in src/shared/chat-duties.ts.
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
/** Staging's Convex and the owner's org on it (Adapt Korea, the 23,877-key org t17 keeps about 10 accounts of on): staging_green_pct
 *  judges only the rows of this org's watch keys, so a sign-up check's throwaway org (mac-management, 2026-10-20 16:17Z and 17:0xZ, which
 *  unpaused about 1,000 and 21 old rows for minutes) never moves it. */
export const STAGING_CONVEX = "tremendous-eel-825";
export const STAGING_OWNER_ORG = "org_3FLEJTtegZpZqZPYYByywRFfDjI";

/** The unread-records fill of a stream's byte cap that the bus-unread-near-cap alert fires at (crawler-bus-retention.yaml, 2b5d936b50). */
export const BUS_FILL_LIMIT = 0.8;

export type Source = "grafana auth" | "prod gauges" | "prod config" | "convex keys" | "prod rows" | "staging rows" | "prod streams" | "screen read" | "staging keys";
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  owner_green_pct: ["convex keys", "prod rows"], staging_green_pct: ["staging rows"],
  prod_read_error_pct: ["prod rows", "grafana auth", "prod gauges", "prod config"],
  watchlist_risks: ["convex keys", "prod rows", "grafana auth", "prod streams", "screen read"],
};

/** One watch_targets monitor row: platform, kind (posts, tagged, post, ads), lower-case target, its last run, and whether the crawler holds
 *  the Instagram account as private (instagram_accounts.is_private). */
export interface WatchRow {
  platform: string; kind: string; target: string; paused: boolean; lastOutcome: string; lastRunAt: number | null;
  lastStopReason: string; lastErrorCode: string; isPrivate: boolean;
  /** err_streak, whether next_due_at is set, and for a row waiting for an account the time of its last ok run (else its created_at). */
  errStreak: number; due: boolean; noAccountSince: number | null;
  /** created_at, epoch ms: when the row joined the monitor rows. */
  addedAt: number | null;
  /** The row's last run named the account's newer handle (crawl_batch_targets.retry_evidence renamed_to, as read.py's renamed_to). */
  renamed: boolean;
}
/** One prod Kafka stream fault watchlist_risks counts: a fill over BUS_FILL_LIMIT, a retention.bytes changed by hand, or missing byte gauges. */
export interface StreamFault { topic: string; why: string }
export interface Gauges { rows: Record<string, number>; overdue: Record<string, number>; loopAge?: number }
export interface WatchData {
  now: number;
  keys?: string[]; stagingKeys?: string[]; rows?: WatchRow[]; receipts?: Record<string, number>; staging?: WatchRow[]; prod?: Gauges; pauseWatch?: string; streams?: StreamFault[];
  screen?: ScreenChunk[];
  errors: { source: Source; message: string }[];
}

/** A Convex watch key `platform:kind:target` as the watch_targets row it pushes: Convex kind `account` is the `posts` row. */
export function rowKeyOf(key: string): { platform: string; kind: string; target: string } | null {
  const [platform, kind, ...rest] = key.split(":");
  if (!platform || !kind || !rest.length) return null;
  return { platform, kind: kind === "account" ? "posts" : kind, target: rest.join(":").toLowerCase() };
}
const id = (row: { platform: string; kind: string; target: string }): string => `${row.platform}:${row.kind}:${row.target}`;
/** The not-found codes words.ts reads as a removed account (NOT_FOUND_CODES). */
const NOT_FOUND_CODES = new Set(["profile_not_found", "post_not_found", "advertiser_not_found", "not_found"]);
/** A row whose account the platform removed, or holds private: words.ts walkGone and walkPrivate, which read it checked. */
export const isClosed = (row: WatchRow): boolean =>
  row.lastOutcome === "gone" || (row.lastOutcome === "error" && NOT_FOUND_CODES.has(row.lastErrorCode))
  || row.isPrivate || (row.lastOutcome === "ok" && row.lastStopReason === "private") || renamedHidden(row);
/** A row whose last run found the account hidden from every reader we have: words.ts hidden(), a Stopped chip. */
const isHidden = (row: WatchRow): boolean =>
  (row.lastOutcome === "ok" && row.lastStopReason === "hidden") || (row.lastOutcome === "error" && HIDDEN_CODES.has(row.lastErrorCode));
/** A hidden row whose last run named the account's newer handle: words.ts hidden() reads it as gone, "Removed on Instagram" with a use-handle action. */
const renamedHidden = (row: WatchRow): boolean => row.renamed && isHidden(row);
/**
 * A hidden row that keeps its Stopped chip is an accepted state, not a miss: the owner's t31 answer of 2026-10-21, "Keep them Stopped as they
 * are now". It counts green and is not a watchlist risk, and the report shows the count on its own line (owner_hidden_watches), so a wave
 * of them (a dead doc_id, F16) stays visible. A rule about the row's state, never a list of handles.
 */
export const isAcceptedHidden = (row: WatchRow): boolean => !row.paused && !renamedHidden(row) && isHidden(row);
/** The codes and limits of words.ts that decide a Stopped chip. */
const HIDDEN_CODES = new Set(["timeline_hidden"]);
const TRANSIENT_CODES = new Set(["scrape_blocked", "login_wall", "rate_limited", "challenge", "blocked", "asset_error", "transport", "timeout", "unreachable", "upstream_unavailable", "geo_target_unavailable"]);
const NO_ACCOUNT_CODES = new Set(["fleet_exhausted", "no_serveable_persona", "leased_persona_unavailable", "fleet_starved"]);
const NO_ACCOUNT_STOP_MS = 2 * DAY;
const STOP_AFTER_FAILURES = 3;
/**
 * Why an unpaused row's Watchlist chip reads Stopped, or null, by watchWords in apps/search/src/lib/watchlist/words.ts: Instagram hides the
 * account from logged-out readers, no account for 2 days, or a failed check the crawler no longer retries. A removed or private account reads
 * checked there, never Stopped. Holds (heldBy) read Waiting and are not modelled; pause.watch has its own flag.
 */
export function stopReason(row: WatchRow, now: number): string | null {
  if (row.paused || isClosed(row)) return null;
  const code = row.lastErrorCode;
  if ((row.lastOutcome === "ok" && row.lastStopReason === "hidden") || (row.lastOutcome === "error" && HIDDEN_CODES.has(code))) return "Instagram hides this account";
  if (row.lastOutcome === "starved" || (row.lastOutcome === "error" && NO_ACCOUNT_CODES.has(code)))
    return row.noAccountSince !== null && now - row.noAccountSince >= NO_ACCOUNT_STOP_MS ? "no account for 2 days" : null;
  if (row.lastOutcome !== "error") return null;
  const forGood = row.errStreak >= STOP_AFTER_FAILURES && !TRANSIENT_CODES.has(code);
  return row.due && !forGood ? null : `failed ${code || "error"}`;
}
const readOk = (row: WatchRow, now: number): boolean =>
  row.lastOutcome === "ok" && row.lastStopReason !== "hidden" && row.lastRunAt !== null && now - row.lastRunAt <= DAY;
/** A row added under 24 h ago that does not read Stopped: its first read is not late yet (crawler health.py _NO_GOOD_READ). */
export const isYoung = (row: WatchRow, now: number): boolean => row.addedAt !== null && now - row.addedAt < DAY && stopReason(row, now) === null;
export const isGreen = (row: WatchRow | undefined, now: number): boolean =>
  !!row && !row.paused && (isClosed(row) || isAcceptedHidden(row) || readOk(row, now) || isYoung(row, now));
/** Why a watch is not green, as a flag phrase. */
const notGreen = (kind: string, row: WatchRow | undefined): string => !row ? `${kind} no monitor row` : row.paused ? `${kind} paused`
  : !row.lastOutcome ? `${kind} never ran` : row.lastOutcome !== "ok" ? `${kind} last ${row.lastOutcome}` : row.lastStopReason === "hidden" ? `${kind} Stopped, hidden` : `${kind} ok but older than 24 h`;
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
  const stops = new Map<string, number>();
  let hidden = 0;
  for (const key of keys) {
    const want = rowKeyOf(key);
    if (!want) { unread++; continue; }
    const row = byId.get(id(want));
    const green = isGreen(row, now);
    const account = `${want.platform}:${want.target}`;
    accounts.set(account, (accounts.get(account) ?? true) && green);
    if (want.kind === "tagged") { collabs++; if (row && !row.paused) pushed++; }
    if (!green) { const reason = notGreen(want.kind, row); why.set(reason, (why.get(reason) ?? 0) + 1); }
    if (row && isAcceptedHidden(row)) { hidden++; continue; }
    const stop = row && stopReason(row, now);
    if (stop) { const reason = `${want.kind} ${stop}`; stops.set(reason, (stops.get(reason) ?? 0) + 1); }
  }
  const green = [...accounts.values()].filter(Boolean).length;
  const stopped = [...stops.values()].reduce((sum, count) => sum + count, 0);
  return { accounts: accounts.size, green, collabs, pushed, unread, why: tally(why), stopped, stops: tally(stops), hidden };
}

/** The unpaused monitor rows of the given kinds (posts and tagged: the Watchlist's posts and collabs), how many are green, and why the rest are not. */
export function rowsGreen(rows: readonly WatchRow[], now: number, kinds: readonly string[] = ["posts", "tagged"]) {
  const live = rows.filter(row => !row.paused && kinds.includes(row.kind));
  const why = new Map<string, number>();
  const byKind: Record<string, { rows: number; green: number }> = Object.fromEntries(kinds.map(kind => [kind, { rows: 0, green: 0 }]));
  let young = 0;
  for (const row of live) {
    const green = isGreen(row, now);
    byKind[row.kind]!.rows++;
    if (green) byKind[row.kind]!.green++;
    else { const reason = notGreen(row.kind, row); why.set(reason, (why.get(reason) ?? 0) + 1); }
    if (green && !isClosed(row) && !readOk(row, now)) young++;
  }
  return { rows: live.length, green: Object.values(byKind).reduce((sum, kind) => sum + kind.green, 0), byKind, why: tally(why), young };
}

/** The staging rows of the owner org's watch keys, and the rest. With no keys read (the Convex read failed), every row is the owner's,
 *  as before 2026-10-20, so a failed key read never empties staging_green_pct. */
export function splitByKeys(rows: readonly WatchRow[], keys: readonly string[] | undefined): { owned: WatchRow[]; others: WatchRow[] } {
  if (!keys?.length) return { owned: [...rows], others: [] };
  const wanted = new Set(keys.map(rowKeyOf).filter(key => key !== null).map(key => id(key!)));
  const owned: WatchRow[] = [];
  const others: WatchRow[] = [];
  for (const row of rows) (wanted.has(id(row)) ? owned : others).push(row);
  return { owned, others };
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
  const screen = data.screen ?? [];
  const late = screenFailed(screen);
  if (data.screen) {
    const asked = screen.reduce((sum, chunk) => sum + chunk.keys, 0);
    detail.screen_read_ok_pct = asked ? round1(100 * (asked - late.reduce((sum, chunk) => sum + chunk.keys, 0)) / asked) : 0;
    detail.screen_read_max_s = round1(Math.max(0, ...screen.map(chunk => chunk.ms)) / 1000);
    flagged.push({ at, kind: "screen_read", excerpt: `the Watchlist status read of ${asked} owner keys in ${screen.length} chunks of ${SCREEN.chunkKeys}: ${late.length} would read Status unavailable (not 200 or past ${SCREEN.budgetMs / 1000} s); times ${screen.map(chunk => round1(chunk.ms / 1000)).join(", ")} s` });
  }
  if (data.keys && data.rows) {
    const owner = ownerGreen(data.keys, data.rows, now);
    metrics.owner_green_pct = owner.accounts ? round1(100 * owner.green / owner.accounts) : 0;
    detail.collab_pushed_pct = owner.collabs ? round1(100 * owner.pushed / owner.collabs) : 100;
    detail.owner_stopped_watches = owner.stopped;
    detail.owner_hidden_watches = owner.hidden;
    flagged.push({ at, kind: "owner_hidden", excerpt: `${owner.hidden} hidden by Instagram: owner watches that read Stopped because Instagram hides the account, kept Stopped by the owner's t31 answer and counted green; a wave of them can mean a dead doc_id, F16` });
    if (data.streams) {
      metrics.watchlist_risks = owner.stopped + data.streams.length + (owner.collabs - owner.pushed) + (late.length || !screen.length ? 1 : 0);
      flagged.push({ at, kind: "watchlist_risks", excerpt: (`${metrics.watchlist_risks} Watchlist risks firing: ${owner.stopped} owner watches read Stopped`
        + (owner.stops.length ? ` (${listWhy(owner.stops)})` : "")
        + `; ${data.streams.length} prod Kafka stream faults${data.streams.length ? ` (${data.streams.map(fault => `${fault.topic}: ${fault.why}`).join("; ")})` : ""}`
        + `; ${owner.collabs - owner.pushed} owner collab watches prod does not read`
        + `; ${late.length || !screen.length ? 1 : 0} Watchlist status read failing (${late.length} of ${screen.length} chunks would read Status unavailable). Risk page: wiki apps/crawler-v3/engage-reads-and-watchlist-risks.`).slice(0, 1200) });
    }
    flagged.push({ at, kind: "owner_watchlist", excerpt: `${owner.green} of ${owner.accounts} owner org accounts green on prod; ${owner.pushed} of ${owner.collabs} collab watches have an unpaused prod tagged monitor row` +
      (owner.why.length ? `; watches not green: ${listWhy(owner.why)}` : "") + (owner.unread ? `; ${owner.unread} keys not in platform:kind:target form` : "") });
    if (!owner.accounts) flagged.push({ at, kind: "no_keys", excerpt: `Convex pageKeys returned no watch key for ${OWNER_ORG}` });
  }
  if (data.staging) {
    const { owned, others } = splitByKeys(data.staging, data.stagingKeys);
    const staging = rowsGreen(owned, now);
    metrics.staging_green_pct = staging.rows ? round1(100 * staging.green / staging.rows) : 0;
    const posts = staging.byKind.posts!;
    const tagged = staging.byKind.tagged!;
    detail.staging_posts_green_pct = posts.rows ? round1(100 * posts.green / posts.rows) : 0;
    detail.staging_tagged_not_green = tagged.rows - tagged.green;
    flagged.push({ at, kind: "staging_monitor_rows", excerpt: `${staging.green} of ${staging.rows} unpaused staging monitor rows read ok in 24 h: posts ${posts.green} of ${posts.rows}, collabs ${tagged.green} of ${tagged.rows}` +
      (staging.why.length ? `; not green: ${listWhy(staging.why)}` : "") + (staging.young ? `; ${staging.young} added under 24 h ago and not read ok yet` : "") + `; ${owned.length - staging.rows} paused or other rows are left out (t17: "only like 10 accounts" in staging)` });
    const leaking = rowsGreen(others, now);
    detail.staging_other_org_unpaused = leaking.rows;
    if (leaking.rows) flagged.push({ at, kind: "staging_other_orgs", excerpt: `${leaking.rows} unpaused staging monitor rows (posts ${leaking.byKind.posts!.rows}, collabs ${leaking.byKind.tagged!.rows}) belong to no key of ${STAGING_OWNER_ORG}; they are not scored in staging_green_pct, and a test org left after its check shows here` });
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

/** The tab-separated monitor rows psql prints (rowLines for Grafana's): platform, kind, target, paused (t or f), last_outcome, last_run_at epoch ms or empty,
 *  last_stop_reason, last_error_code, the account's is_private (t or f), err_streak, next_due_at set (t or f), the no-account since time and created_at. */
export function parseRows(text: string): WatchRow[] {
  const rows: WatchRow[] = [];
  for (const line of text.split("\n")) {
    const cells = line.split("\t");
    if (cells.length !== 14) continue;
    const [platform, kind, target, paused, lastOutcome, lastRunAt, lastStopReason, lastErrorCode, isPrivate, errStreak, due, noAccountSince, addedAt, renamed] = cells as
      [string, string, string, string, string, string, string, string, string, string, string, string, string, string];
    rows.push({ platform, kind, target, paused: paused === "t", lastOutcome, lastRunAt: lastRunAt ? Number(lastRunAt) : null,
      lastStopReason, lastErrorCode, isPrivate: isPrivate === "t", errStreak: Number(errStreak) || 0, due: due === "t", noAccountSince: noAccountSince ? Number(noAccountSince) : null,
      addedAt: addedAt ? Number(addedAt) : null, renamed: renamed === "t" });
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

/**
 * The prod Kafka stream faults: each topic whose unread records fill over BUS_FILL_LIMIT of its byte cap, each topic whose broker
 * retention.bytes differs from the registry's, and one fault while the byte gauges are missing, by the two prod rules of
 * apps/infra/metal/config/obs/grafana/alerting/crawler-bus-retention.yaml.
 */
export async function streamFaults(query: DsQuery): Promise<StreamFault[]> {
  const uid = PROM.prod;
  const [fill, caps, records] = await Promise.all([
    promInstant(query, uid, 'max by (topic, group) (crawler_v3_bus_group_lag_records{world="prod"}) / on(topic) group_left() max by (topic) (crawler_v3_bus_topic_retained_records{world="prod"} > 0) * on(topic) group_left() max by (topic) (crawler_v3_bus_topic_fullest_partition_bytes{world="prod"}) / on(topic) group_left() max by (topic) (crawler_v3_bus_topic_retention_bytes{world="prod",source="broker"})'),
    promInstant(query, uid, 'max by (topic, source) (crawler_v3_bus_topic_retention_bytes{world="prod"})'),
    promInstant(query, uid, 'max by (topic, group) (crawler_v3_bus_group_lag_records{world="prod"}) / on(topic) group_left() max by (topic) (crawler_v3_bus_topic_retained_records{world="prod"} > 0)'),
  ]);
  if (!caps.length) {
    const top = records.sort((a, b) => b.value - a.value)[0];
    return [{ topic: "all", why: `crawler_v3_bus_topic_retention_bytes is missing on prod, so neither size alert can fire${top ? ` (fullest unread share of retained records: ${top.labels.topic} ${round1(100 * top.value)}%)` : ""}` }];
  }
  const faults: StreamFault[] = [];
  const over = new Map<string, number>();
  for (const series of fill) if (series.value > BUS_FILL_LIMIT) over.set(series.labels.topic ?? "?", Math.max(over.get(series.labels.topic ?? "?") ?? 0, series.value));
  for (const [topic, value] of over) faults.push({ topic, why: `unread records fill ${round1(100 * value)}% of its byte cap` });
  const byTopic = new Map<string, Record<string, number>>();
  for (const series of caps) byTopic.set(series.labels.topic ?? "?", { ...byTopic.get(series.labels.topic ?? "?"), [series.labels.source ?? "?"]: series.value });
  for (const [topic, cap] of byTopic) if (cap.broker !== undefined && cap.registry !== undefined && cap.broker !== cap.registry)
    faults.push({ topic, why: `broker retention.bytes ${cap.broker} differs from the registry's ${cap.registry}, a change by hand` });
  return faults;
}

/**
 * Where convexKeys keeps each org's last key walk with the stamp it read before the walk, shared by every checkout on the host. The duty
 * server and jobs that run this precheck by hand walked the owner org about 65 times a day per env on 10-19 to 10-21, 19,710 rows on prod and
 * about 23,900 on staging a walk, 1.49 GB and 2.16 GB of Convex DB I/O in 3 days (otel_logs, search/watchTargets:pageKeys), while the
 * org's keys had not changed for 9 days.
 */
export const KEYS_CACHE_DIR = join(homedir(), ".cache", "watchlist-green");

/**
 * Every distinct watch key of one org on a Convex deployment, read with the owner's Convex CLI login. It reads the org's watch-key stamp
 * first (search/watchTargets:watchKeysStamp, 3 documents), and when the stamp equals the one KEYS_CACHE_DIR holds for the org, the keys there
 * are the answer and nothing is walked. A deployment without the stamp query walks every time and keeps nothing.
 * Before a deployment has answered a stamp, which leaves a file in KEYS_CACHE_DIR, it reads the deployment's function list
 * (_system/cli/modules:apiSpec, the list `convex run` reads, about 0.6 MB and 0.2 s on staging) and asks for the stamp only when the list has
 * it. A stamp call to a deployment without the query is a refused call that pages ops through search-convex-call-refused, which happened at
 * 2026-10-22 16:47:45Z on prod, because sieun-pi 414dba9c went live before auto-sns-agent a6786dc14 reached prod Convex. The apiSpec read
 * logs no function_execution row.
 */
export async function convexKeys(fetcher: typeof fetch, accessToken: string, signal: AbortSignal,
  deployment: string = PROD_CONVEX, orgId: string = OWNER_ORG, cacheDir: string = KEYS_CACHE_DIR): Promise<string[]> {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" };
  const auth = await fetcher("https://api.convex.dev/api/deployment/authorize_within_current_project", { method: "POST", headers, signal,
    body: JSON.stringify({ selectedDeploymentName: deployment, projectSelection: { kind: "deploymentName", deploymentName: deployment, deploymentType: null } }) });
  const credentials = await auth.json().catch(() => null) as { adminKey?: string; url?: string } | null;
  if (!auth.ok || !credentials?.adminKey || !credentials.url) throw new Error(`Convex authorize for ${deployment} gave HTTP ${auth.status}`);
  const query = async <T>(path: string, args: Record<string, unknown>): Promise<T> => {
    const response = await fetcher(`${credentials.url}/api/query`, { method: "POST", signal,
      headers: { authorization: `Convex ${credentials.adminKey}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" },
      body: JSON.stringify({ path, args, format: "json" }) });
    const body = await response.json().catch(() => null) as { status?: string; errorMessage?: string; value?: T } | null;
    if (body?.status !== "success" || body.value === undefined) {
      throw new Error(`${path.split(":")[1]}: HTTP ${response.status} ${String(body?.errorMessage ?? "no value").slice(0, 200)}`);
    }
    return body.value;
  };
  const file = join(cacheDir, `${deployment}-${orgId}.json`);
  const kept = await readFile(file, "utf8").then(text => JSON.parse(text) as { stamp?: unknown; keys?: unknown }).catch(() => null);
  const served = kept !== null || await query<{ identifier: string }[]>("_system/cli/modules:apiSpec", {})
    .then(spec => spec.some(fn => fn.identifier === "search/watchTargets.js:watchKeysStamp"), () => false);
  const stamp = served ? await query<string>("search/watchTargets:watchKeysStamp", { orgId }).catch(() => null) : null;
  if (stamp !== null && kept?.stamp === stamp && Array.isArray(kept.keys)) return kept.keys as string[];
  const keys = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { keys: string[]; continueCursor: string; isDone: boolean } = await query<{ keys: string[]; continueCursor: string; isDone: boolean }>("search/watchTargets:pageKeys", { orgId, cursor });
    page.keys.forEach(key => keys.add(key));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  if (stamp !== null) {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ stamp, keys: [...keys] }));
    await rename(tmp, file);
  }
  return [...keys];
}

/*
 * The screen read: the Watchlist chips come from POST /api/monitoring/watch-targets, which sends the keys on screen to the crawler's
 * POST https://crawler.virev.ai/api/watch-targets/summary. On 10-19 every 200-key read took 5.1 to 11.1 s against the route's 4 s budget, so
 * every prod chip read "Status unavailable" while owner_green_pct read 91.8%. The probe sends SCREEN_SAMPLE owner keys, spread over the whole
 * org, to the same API in the screen's chunks and budget, through crawler.virev.ai with the search app's prod key, the path the search server
 * takes (owner rule c146, 2026-10-19, took it off root ssh into virev-prod-crawler-api).
 * A chunk past the budget or not answering 200 is a chunk of chips that reads Status unavailable, and counts once in watchlist_risks.
 */
/** apps/search/src/lib/watchlist/crawl.svelte.ts READ_CHUNK_KEYS and READS_IN_FLIGHT, and SUMMARY_BUDGET_MS in
 *  apps/search/src/lib/server/monitoring/watch-targets.ts, at auto-sns-agent e6623349e. */
export const SCREEN = { chunkKeys: 25, inFlight: 4, budgetMs: 20_000 } as const;
/** Owner keys the probe reads: 8 chunks, two waves of 4. measured: 50-key reads took 1.2 to 18.4 s on prod 10-19, so it ends inside 40 s. */
export const SCREEN_SAMPLE = 200;
/** One chunk of the screen read: keys asked, HTTP status (0 when the request failed), and milliseconds. */
export interface ScreenChunk { keys: number; status: number; ms: number }

/** SCREEN_SAMPLE crawler keys (`posts` for an account watch) taken evenly over the org's watch keys. */
export function screenKeys(keys: readonly string[]): string[] {
  const crawler = keys.map(rowKeyOf).filter((row): row is NonNullable<typeof row> => !!row && (row.kind === "posts" || row.kind === "tagged")).map(id);
  const step = Math.max(1, crawler.length / SCREEN_SAMPLE);
  return Array.from({ length: Math.min(SCREEN_SAMPLE, crawler.length) }, (_, i) => crawler[Math.floor(i * step)]!);
}

/** The crawler route the search server reads for the chips, and the key it sends: CRAWLER_API_URL and CRAWLER_API_KEY of apps/search/.env, prod. */
export const SUMMARY_URL = "https://crawler.virev.ai/api/watch-targets/summary";
export async function readCrawlerKey(): Promise<string> {
  const { stdout } = await promisify(execFile)(join(REPO, "node_modules/.bin/dotenvx"), ["get", "CRAWLER_API_KEY", "-f", join(REPO, "apps/search/.env")]);
  const key = stdout.trim();
  if (!key || key.startsWith("encrypted:")) throw new Error("CRAWLER_API_KEY did not decrypt from apps/search/.env");
  return key;
}

/** Reads the keys in the screen's chunks, SCREEN.inFlight at a time, each with the screen's budget, as one ScreenChunk per chunk in order. */
export async function screenRead(fetcher: typeof fetch, apiKey: string, keys: readonly string[], signal: AbortSignal): Promise<ScreenChunk[]> {
  const chunks = Array.from({ length: Math.ceil(keys.length / SCREEN.chunkKeys) }, (_, i) => keys.slice(i * SCREEN.chunkKeys, (i + 1) * SCREEN.chunkKeys));
  const read = async (chunk: readonly string[]): Promise<ScreenChunk> => {
    const start = performance.now();
    let status = 0;
    try {
      const response = await fetcher(SUMMARY_URL, { method: "POST", body: JSON.stringify({ keys: chunk }),
        headers: { "content-type": "application/json", "x-api-key": apiKey }, signal: AbortSignal.any([signal, AbortSignal.timeout(SCREEN.budgetMs)]) });
      await response.arrayBuffer();
      status = response.status;
    } catch { status = 0; }
    return { keys: chunk.length, status, ms: Math.round(performance.now() - start) };
  };
  const out: ScreenChunk[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SCREEN.inFlight, chunks.length) }, async () => {
    while (next < chunks.length) { const i = next++; out[i] = await read(chunks[i]!); }
  }));
  return out;
}
/** Chunks a screen would show as Status unavailable: not a 200, or past the route's budget. */
export const screenFailed = (chunks: readonly ScreenChunk[]): ScreenChunk[] => chunks.filter(chunk => chunk.status !== 200 || chunk.ms > SCREEN.budgetMs);

const ROWS_SQL = "select w.platform, w.kind, lower(w.target) as target, case when w.paused then 't' else 'f' end as paused, coalesce(w.last_outcome, '') as last_outcome, " +
  "coalesce((extract(epoch from w.last_run_at) * 1000)::bigint::text, '') as last_run_at, coalesce(w.last_stop_reason, '') as last_stop_reason, coalesce(w.last_error_code, '') as last_error_code, " +
  "case when w.platform = 'instagram' and exists (select 1 from instagram_accounts a where a.username = w.target and a.is_private) then 't' else 'f' end as is_private, " +
  "w.err_streak, case when w.next_due_at is null then 'f' else 't' end as due, " +
  "case when w.last_outcome = 'starved' or w.last_error_code in ('fleet_exhausted', 'no_serveable_persona', 'leased_persona_unavailable', 'fleet_starved') then " +
  "(extract(epoch from coalesce((select max(c.settled_at) from watch_target_claims c where c.platform = w.platform and c.kind = w.kind and c.target = w.target and c.outcome = 'ok'), w.created_at)) * 1000)::bigint::text else '' end as no_account_since, " +
  "(extract(epoch from w.created_at) * 1000)::bigint::text as added_at, ";
/** Whether the row's last run named a newer handle. Only a hidden row can read renamed (renamedHidden), so the CASE asks the claims
 *  join of hidden rows alone: asked of all 19,700 monitor rows it ran past prod's statement_timeout at 17:00Z on 2026-10-20. Staging's Grafana role (grafana_ro on estate_pg_stg) has no SELECT on
 *  watch_target_claims, so the staging read sends 'f' and its rows never read renamed. */
const RENAMED_SQL = "case when w.platform <> 'instagram' or w.last_batch_id is null " +
  "or not (coalesce(w.last_stop_reason, '') = 'hidden' or coalesce(w.last_error_code, '') = 'timeline_hidden') then 'f' " +
  "when exists (select 1 from watch_target_claims c join crawl_batch_targets t on t.batch_id = c.batch_id " +
  "and t.index = any(c.op_indexes) where c.batch_id = w.last_batch_id and c.platform = w.platform and c.kind = w.kind and c.target = w.target " +
  "and jsonb_typeof(t.retry_evidence -> 'renamed_to') = 'object') then 't' else 'f' end as renamed from watch_targets w where w.tier = 'monitor'";
const PROD_ROWS_SQL = ROWS_SQL + RENAMED_SQL;
const STAGING_ROWS_SQL = ROWS_SQL + "'f' as renamed from watch_targets w where w.tier = 'monitor'";
/** ROWS_SQL's columns in parseRows order, to print Grafana's table rows as the lines psql prints. */
const ROW_COLUMNS = ["platform", "kind", "target", "paused", "last_outcome", "last_run_at", "last_stop_reason", "last_error_code", "is_private", "err_streak", "due", "no_account_since", "added_at", "renamed"];
export const rowLines = (rows: Record<string, unknown>[]): string => rows.map(row => ROW_COLUMNS.map(column => String(row[column] ?? "")).join("\t")).join("\n");
const RECEIPTS_SQL = "select 'receipt', outcome, count(*) from watch_target_claims where settled_at > now() - interval '24 hours' and outcome is not null group by outcome;";

export interface WatchDeps {
  query: DsQuery | null; authError: string | null; keys: () => Promise<string[]>; rows: () => Promise<string>; staging: () => Promise<string>;
  stagingKeys: () => Promise<string[]>;
  screen: (keys: string[]) => Promise<ScreenChunk[]>; now: number;
}

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
  const keysRead = step("convex keys", deps.keys);
  const [keys, screen, prodText, stagingText, prod, pause, streams, stagingKeys] = await Promise.all([
    keysRead,
    keysRead.then(read => read?.length ? step("screen read", () => deps.screen(screenKeys(read))) : undefined),
    step("prod rows", deps.rows),
    step("staging rows", deps.staging),
    query ? step("prod gauges", () => gauges(query)) : undefined,
    query ? step("prod config", async () => String((await sqlRows(query, PG.prod, "select value from config where key = 'pause.watch'"))[0]?.value ?? "")) : undefined,
    query ? step("prod streams", () => streamFaults(query)) : undefined,
    step("staging keys", deps.stagingKeys),
  ]);
  const rows = prodText === undefined ? undefined : parseRows(prodText);
  const staging = stagingText === undefined ? undefined : parseRows(stagingText);
  if (rows && !rows.length) data.errors.push({ source: "prod rows", message: "the owner_ro read returned no prod watch_targets monitor row" });
  if (staging && !staging.length) data.errors.push({ source: "staging rows", message: "estate_pg_stg returned no staging watch_targets monitor row" });
  if (screen && !screen.length) data.errors.push({ source: "screen read", message: "the screen read sent no chunk to crawler.virev.ai" });
  Object.assign(data, keys && { keys }, screen?.length && { screen }, rows?.length && { rows, receipts: parseReceipts(prodText!) }, staging?.length && { staging }, stagingKeys?.length && { stagingKeys },
    prod && { prod }, pause !== undefined && { pauseWatch: pause }, streams && { streams });
  return data;
}

const convexToken = async (): Promise<string> =>
  (JSON.parse(await readFile(join(homedir(), ".convex/config.json"), "utf8")) as { accessToken: string }).accessToken;

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
    keys: async () => convexKeys(fetch, await convexToken(), signal),
    stagingKeys: async () => convexKeys(fetch, await convexToken(), signal, STAGING_CONVEX, STAGING_OWNER_ORG),
    rows: () => prodReader("watchlist-green-duty", signal)(`${PROD_ROWS_SQL};\n${RECEIPTS_SQL}`),
    staging: async () => { if (!query) throw new Error("not read: no Grafana login"); return rowLines(await sqlRows(query, PG.staging, STAGING_ROWS_SQL)); },
    screen: async keys => screenRead(fetch, await readCrawlerKey(), keys, signal) });
  const result = report(data, dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`watchlist-green: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
