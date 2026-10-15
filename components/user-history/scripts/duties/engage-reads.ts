import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, HOUR, PG, PROM, SOURCE_DEADLINE_MS, UNMEASURED, grafanaClient, missValue, num, promInstant, readGrafanaAuth, round1, sqlRows, ssh, utc,
} from "./estate-reads.ts";

/**
 * The Engage reads scale safely duty's precheck for launch main bro (`node --import tsx scripts/duties/engage-reads.ts`). Code only, no model
 * call, reads only. It measures goal p1, whether prod HAS THE CAPACITY to read 100k logged-in pages a day, years deep, without accounts dying
 * (the owner, 10-14: "i said 'Have the capacity to' which is what you should check"), and his standing canary rule, from:
 * - estate_pg_prod and estate_pg_stg through Grafana (grafana_ro): ig_engage_read_log, ig_engage_accounts, ig_engage_account_events, the
 *   config keys engage.rate_test_arms, engage.rate_test_started_at and pause.engage*, and on staging every pause.* row that reads 'true'
 *   with its last config_audit writer;
 * - estate_prometheus: crawler_v3_engage_admissible_now{world="prod"} (the accounts that can read now: active, bound and passing egress admission,
 *   GET /ops/engage/health admissible_now), and crawler_v3_engage_deaths_24h{cause} to cross-check the death count;
 * - prod ig_engage_session_bindings and ig_engage_session_renewals through the same ssh as owner_ro (grafana_ro cannot read the renewals), for
 *   the active accounts whose proxy session binding ran out and that the renewal loop retries (LAPSED_REMOTE below);
 * - prod watch_targets through one ssh to us-metal01 as owner_ro (grafana_ro cannot read watch_targets), for the deep collab walks, and
 *   staging watch_targets the same way, for the oldest due staging collab read.
 * grafana_ro cannot read the actor, transition and from_status columns of ig_engage_account_events, so a death here is a dead-outcome event, and
 * its cause is that event's error_code through CODE_CAUSES below.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "engage-reads.duty.json");

/*
 * Targets in engage-reads.duty.json and their sources (owner rule c75: one headline and at most 3 supporting metrics):
 * - prod_capacity_pages_day >= 100000 is the headline: the owner, 10-09, "read 100k pages/day". Capacity is the healthy prod accounts times provenRate(). Healthy is
 *   admissible_now plus the active accounts whose proxy session binding ran out while the renewal loop retries it: Instagram did nothing to
 *   them, and they read again on their own once the proxy gives them an exit. A GeoNode outage from 23:05Z on 10-14 let 20 bindings lapse
 *   and dropped admissible_now from 122 to 106 with 0 Instagram verdicts; the proxy outage is the proxy's alert, not lost account capacity.
 * - fleet_ig_killed_pct <= 2 and canary_ig_deaths_1h <= 3: the owner's own numbers, 10-14 02:13Z.
 * - deep_walk_ok_pct >= 99: the owner, 10-09, "reliable logged-in apis including pagination api for up to years". Measured 10-14 02:30Z on
 *   prod: of the 365-day collab walks, 8,960 of 8,978 in the last 72 h reached their end (99.8%), by UTC day 10-12 5,259 of 5,259 and 10-13
 *   3,664 of 3,681 (99.5%). The target is the 72 h value rounded down to a whole percent.
 * - canary_accounts_short, staging_due_wait_min and source_errors are run detail: report() writes them to the output, the server does not judge
 *   them, and the canary_short and staging_stall flags carry them to the fix jobs.
 * - canary_accounts_short: the owner, 10-12 13:33Z, "ALWAYS RUN ~10% account as CANARY"; CANARY_SHARE below.
 * - staging_due_wait_min: staging stays a working test bed, so a due staging collab read starts within STAGING_WAIT_MIN. The owner keeps about
 *   10 monitored accounts on staging (t17, 10-12), so staging reads come in bursts hours apart by design, and the time since the last read
 *   says nothing; the wait of the oldest due, unpaused, unclaimed tagged row does. The 60 min is the launch VP's number, not the owner's.
 * - A source that failed fails the run: every metric it feeds (FEEDS below) reads unmeasured() and a source_error flag names it.
 * The schedule is daily (owner rule c66). The duty's timeoutMs 120000 is the runner's own cap, PRECHECK_TIMEOUT_MS in src/shared/chat-duties.ts.
 */

export const PAGES_A_DAY_GOAL = 100_000;
/** The owner's "~10%" (10-12 13:33Z): the canary is this share of active prod accounts, rounded to the nearest whole account. */
export const CANARY_SHARE = 0.1;
/** The owner's "over at least 2 full UTC days" rule for a proven rate (10-14). */
export const PROOF_DAYS = 2;
/** Dead statuses, as `_DEAD_STATUSES` in apps/crawler-v3/src/control/metrics/health.py. */
export const DEAD = ["challenged", "frozen", "disabled"] as const;
export type Cause = "instagram" | "first_login" | "bad_password" | "ours" | "unknown";
/**
 * A copy of CODE_CAUSES in apps/crawler-v3/src/control/metrics/engage_deaths.py (sieun/dev, 2026-10-12), plus the two codes prod accounts 55 and 74
 * died with on 10-12: login_redirect (every usertags read answered 302 to the login page after both had served pages) and instagram_session_killed.
 */
export const CODE_CAUSES: Readonly<Record<string, Cause>> = {
  account_suspended: "instagram", action_blocked: "instagram", challenge: "instagram", challenge_required: "instagram", challenged: "instagram",
  instagram_session_killed: "instagram", login_redirect: "instagram", sentry_block: "instagram", suspended_on_first_contact: "instagram",
  bad_password: "bad_password",
  budget_meter_failed: "ours", exit_pinned: "ours", exit_unusable: "ours", geo_blocked: "ours", proxy_blocked: "ours", transport: "ours",
};
/** The staging stall line's limit: the oldest due staging collab read waits at most this long. The launch VP's number. */
export const STAGING_WAIT_MIN = 60;
export type Source = "grafana auth" | "prod read log" | "staging read log" | "staging due reads" | "staging config" | "prod accounts" | "prod config" | "prod healthy gauge" | "prod lapsed bindings" | "prod death gauge" | "prod deep walks";
/**
 * The judged metrics each source feeds; a failed source makes each of them read unmeasured(). The staging sources feed only detail lines, so
 * they fail the headline, the number a run is judged on, and an unread source never leaves the run green.
 */
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  "grafana auth": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "prod read log": ["prod_capacity_pages_day"], "prod healthy gauge": ["prod_capacity_pages_day"], "prod lapsed bindings": ["prod_capacity_pages_day"],
  "prod accounts": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "prod config": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "prod death gauge": ["fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "staging read log": ["prod_capacity_pages_day"], "staging due reads": ["prod_capacity_pages_day"], "staging config": ["prod_capacity_pages_day"],
  "prod deep walks": ["deep_walk_ok_pct"],
};
/** The value of a metric a failed source feeds: 0 for an at-least metric (no pages counted, no walk reached), missValue() for an at-most one. */
export const unmeasured = (metric: Pick<DutyMetric, "op" | "target">): number => metric.op === ">=" ? Math.min(0, metric.target - 1) : missValue(metric);

/** Pages one prod account read on one full UTC day (YYYY-MM-DD). */
export interface DayPages { day: string; accountId: number; pages: number }
/** A dead-outcome event: Instagram's verdict when causeOf() says so. `pages24h` is what the account read in the 24 h before it. */
export interface Death { accountId: number; at: number; status: string; code: string | null; readBefore: boolean; pages24h: number }
export interface Account { id: number; status: string; reason?: string }
/** Staging's due collab reads: tagged rows past next_due_at, unpaused and with no open claim, and the oldest one's wait in minutes. */
export interface StagingDue { due: number; waitMin: number }
/** A staging pause row that reads 'true', with the config_audit row that last wrote its key (null fields when none did). */
export interface StagingPause { key: string; auditId: number | null; at: number | null; actor: string | null; reason: string | null }
/**
 * Active prod accounts whose current proxy session binding has run out (or runs out inside one page's timeout, as the egress admission
 * refuses it): `waiting` have a renewal row that is not blocked, so the renewal loop retries them; `blocked` wait for an operator.
 * `oldestAt` is when the oldest of them ran out, null when none has.
 */
export interface Lapsed { waiting: number; blocked: number; oldestAt: number | null }
/** The 365-day collab walks of the last 24 h: walks that reached their end (since or exhausted), and error stops by code. */
export interface DeepWalks { reached: number; errors: Record<string, number> }
export interface EngageData {
  now: number;
  days?: DayPages[]; stagingLastReadAt?: number | null; stagingDue?: StagingDue; stagingPauses?: StagingPause[]; accounts?: Account[]; deaths?: Death[]; config?: Record<string, string>;
  healthy?: number; lapsed?: Lapsed; deepWalks?: DeepWalks;
  /** crawler_v3_engage_deaths_24h by cause. */
  deathGauge?: Record<string, number>;
  errors: { source: Source; message: string }[];
}

/** The rate-test roster from `engage.rate_test_arms` (`cap:id,id;cap:id`), as parse_arms in apps/crawler-v3/src/fleet/rate_test.py. Throws on a bad roster. */
export function parseArms(raw: string): { dailyPages: number; ids: number[] }[] {
  const arms: { dailyPages: number; ids: number[] }[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(";").map(piece => piece.trim()).filter(Boolean)) {
    const colon = part.indexOf(":");
    if (colon < 0) throw new Error(`arm ${part} is not in the form cap:id,id`);
    const dailyPages = Number(part.slice(0, colon));
    if (!Number.isInteger(dailyPages) || dailyPages <= 0) throw new Error(`arm ${part} needs a daily cap above 0`);
    const ids = part.slice(colon + 1).split(",").filter(text => text.trim()).map(Number);
    if (!ids.length || ids.some(id => !Number.isInteger(id))) throw new Error(`arm ${part} names no account or a bad id`);
    if (new Set(ids).size !== ids.length || ids.some(id => seen.has(id))) throw new Error(`an account of arm ${dailyPages} is in the roster twice`);
    ids.forEach(id => seen.add(id));
    arms.push({ dailyPages, ids });
  }
  return arms;
}

/** The canary accounts running now: the roster once engage.rate_test_started_at has passed, else none, and why. */
export function canaryRoster(config: Record<string, string>, now: number): { ids: Set<number>; note: string } {
  const raw = (config["engage.rate_test_arms"] ?? "").trim();
  const started = (config["engage.rate_test_started_at"] ?? "").trim();
  if (!raw || !started) return { ids: new Set(), note: `no canary runs: engage.rate_test_arms is ${raw ? "set" : "empty"} and engage.rate_test_started_at is ${started ? "set" : "empty"}` };
  let arms: { dailyPages: number; ids: number[] }[];
  try { arms = parseArms(raw); } catch (error) { return { ids: new Set(), note: `no canary runs: engage.rate_test_arms is refused (${error instanceof Error ? error.message : String(error)})` }; }
  const startAt = Date.parse(started);
  if (!Number.isFinite(startAt) || !/(Z|[+-]\d\d:?\d\d)$/.test(started)) return { ids: new Set(), note: `no canary runs: engage.rate_test_started_at "${started}" is not an ISO time with its UTC offset` };
  if (startAt > now) return { ids: new Set(), note: `no canary runs yet: the rate test starts at ${utc(startAt)}` };
  return { ids: new Set(arms.flatMap(arm => arm.ids)), note: `canary arms ${arms.map(arm => `${arm.dailyPages}/day x ${arm.ids.length}`).join(", ")}, started ${utc(startAt)}` };
}

/** The cause of one death, as cause_of in engage_deaths.py. grafana_ro cannot see the actor, so a death with no mapped code is unknown. */
export function causeOf(death: Pick<Death, "code" | "readBefore">): Cause {
  const cause = CODE_CAUSES[death.code ?? ""];
  if (!cause) return "unknown";
  return cause === "instagram" && !death.readBefore ? "first_login" : cause;
}

/** The canary size the owner's ~10% asks for: at least one account once any is active. */
export const canaryWant = (active: number): number => active ? Math.max(1, Math.round(CANARY_SHARE * active)) : 0;

const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/**
 * Walk stops that say nothing about pagination, left out of deep_walk_ok_pct as its line says: profile_not_found is a handle Instagram no longer
 * has (prod vivliv_official on 10-15, "Instagram profile @vivliv_official does not exist"), and fleet_exhausted is no free reader, which the
 * capacity metric measures. Until 10-15 the line said both were left out while the count still held them.
 */
export const NOT_PAGINATION: ReadonlySet<string> = new Set(["profile_not_found", "fleet_exhausted"]);

/**
 * The highest pages a day one account is proven to read safely. A rate R is proven over PROOF_DAYS consecutive full UTC days when on each of
 * them at least `cohort` accounts (a canary's worth) read R pages or more, and every Instagram verdict from the first of those days on hit an
 * account that read more than R in the 24 h before it: a verdict at v pages unproves every rate of v or more, so a canary death at a higher
 * rate leaves a lower rate proven. A verdict on an account that read no page in its last 24 h says nothing about a read rate and is left out
 * (prod 55 and 74 on 10-12: every read answered 302 to login, so they read 0 pages before Instagram killed the session). The rates tried are
 * the day totals accounts read. Returns the best rate and its days, or null.
 */
export function provenRate(days: readonly DayPages[], deaths: readonly Death[], cohort: number): { rate: number; days: string[] } | null {
  if (cohort < 1) return null;
  const verdicts = deaths.filter(death => causeOf(death) === "instagram");
  const byDay = new Map<string, number[]>();
  for (const row of days) if (row.pages > 0) byDay.set(row.day, [...byDay.get(row.day) ?? [], row.pages]);
  for (const pages of byDay.values()) pages.sort((a, b) => b - a);
  let best: { rate: number; days: string[] } | null = null;
  for (const first of [...byDay.keys()].sort()) {
    const run = [first];
    while (run.length < PROOF_DAYS && byDay.has(nextDay(run.at(-1)!))) run.push(nextDay(run.at(-1)!));
    if (run.length < PROOF_DAYS) continue;
    const start = Date.parse(`${first}T00:00:00Z`);
    const unsafe = Math.min(Infinity, ...verdicts.filter(death => death.at >= start && death.pages24h > 0).map(death => death.pages24h));
    const rates = run.map(day => byDay.get(day)!.slice(cohort - 1).find(pages => pages < unsafe));
    if (rates.some(rate => rate === undefined)) continue;
    const rate = Math.min(...rates as number[]);
    if (!best || rate > best.rate || (rate === best.rate && first > best.days[0]!)) best = { rate, days: run };
  }
  return best;
}

const fmt = (value: number): string => value.toLocaleString("en-US");

/**
 * When the oldest due staging collab read has waited past its target, the staging pause rows that read 'true' and who last wrote each. A deploy that
 * closes admissions writes pause rows as actor metal-deploy, and on 2026-10-14 staging's pause.crawl and pause.refresh had read 'true' since a
 * 2026-09-23 deploy (config_audit 13588, 13589) that never reopened them (owner rule c63). This line names such a row so the duty run clears
 * it instead of finding it weeks later.
 */
export function stagingStallFlag(data: EngageData): FlaggedSlice | null {
  const target = STAGING_WAIT_MIN;
  if (!data.stagingDue || data.stagingDue.waitMin <= target || !data.stagingPauses) return null;
  const lastRead = data.stagingLastReadAt ? `last staging page read ${utc(data.stagingLastReadAt)}` : data.stagingLastReadAt === null ? "staging has never read a page" : "last staging read not measured";
  const late = `the oldest of ${data.stagingDue.due} due staging collab reads has waited ${data.stagingDue.waitMin} min (target ${target}), ${lastRead}`;
  const rows = data.stagingPauses.map(pause => `${pause.key}${pause.auditId === null ? " (no config_audit row)"
    : ` (audit ${pause.auditId}, ${utc(pause.at!)}, ${pause.actor === "metal-deploy" ? "LEFT BY A DEPLOY, " : ""}${pause.actor}: ${(pause.reason ?? "").slice(0, 90)})`}`);
  const excerpt = `${late}. ${rows.length ? `Staging pause rows on: ${rows.join("; ")}. A row a deploy or a stale job left on goes back to its prior value (c63, c72); a row with an owner's reason stays.` : "No staging pause row is 'true'."} `
    + "Then read the staging refusal reasons (ig_engage_read_log.reason, which grafana_ro cannot read), demand (engage_demand on /ops/watch-targets/health) and STAGING_CRAWLER_MODE.";
  return { at: data.now, kind: "staging_stall", excerpt: excerpt.slice(0, 1200) };
}

/** The precheck output from measured data. */
export function report(data: EngageData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const { now } = data;
  const at = now;
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  if (data.stagingLastReadAt === null) flagged.push({ at, kind: "never_read", excerpt: "staging ig_engage_read_log has no read with pages > 0 at all" });
  if (data.stagingDue) metrics.staging_due_wait_min = data.stagingDue.waitMin;
  const stagingStall = stagingStallFlag(data);
  if (stagingStall) flagged.push(stagingStall);
  if (data.accounts && data.config && data.deaths) {
    const active = data.accounts.filter(account => account.status === "active");
    const roster = canaryRoster(data.config, now);
    const want = canaryWant(active.length);
    const have = active.filter(account => roster.ids.has(account.id)).length;
    metrics.canary_accounts_short = Math.max(0, want - have);
    flagged.push({ at, kind: metrics.canary_accounts_short ? "canary_short" : "canary", excerpt: `${roster.note}; ${have} of ${active.length} active prod accounts are in it, and ~10% is ${want}`
      + (metrics.canary_accounts_short ? `: add ${metrics.canary_accounts_short} active accounts to engage.rate_test_arms` : "") });
    const day = data.deaths.filter(death => now - death.at <= DAY);
    const killed = (deaths: readonly Death[]): number => new Set(deaths.filter(death => causeOf(death) === "instagram").map(death => death.accountId)).size;
    const fleetKilled = killed(day.filter(death => !roster.ids.has(death.accountId)));
    metrics.fleet_ig_killed_pct = active.length ? round1(100 * fleetKilled / active.length) : fleetKilled ? 100 : 0;
    metrics.canary_ig_deaths_1h = killed(day.filter(death => now - death.at <= HOUR && roster.ids.has(death.accountId)));
    const reasonOf = (id: number): string => { const reason = data.accounts!.find(account => account.id === id)?.reason; return reason ? `; status_reason: ${reason}` : ""; };
    for (const death of day) flagged.push({ at: death.at, kind: "death",
      excerpt: `account ${death.accountId} went ${death.status} at ${utc(death.at)}, code ${death.code ?? "none"}, cause ${causeOf(death)}${roster.ids.has(death.accountId) ? ", canary" : ""}, ${fmt(death.pages24h)} pages in its last 24 h${death.readBefore ? "" : ", never read a page"}${reasonOf(death.accountId)}`.slice(0, 600) });
    const instagram = killed(day);
    if (data.deathGauge && Object.keys(data.deathGauge).length && (data.deathGauge.instagram ?? 0) !== instagram)
      flagged.push({ at, kind: "death_gauge", excerpt: `crawler_v3_engage_deaths_24h{cause="instagram"} reads ${data.deathGauge.instagram ?? "none"} while this precheck counts ${instagram}; the gauge sees the actor and from_status columns grafana_ro cannot, so trust the gauge and fix this precheck` });
    const pauses = Object.entries(data.config).filter(([key, value]) => key.startsWith("pause.engage") && value === "true").map(([key]) => key);
    if (pauses.length) flagged.push({ at, kind: "pause", excerpt: `prod pause keys on: ${pauses.join(", ")}` });
    if (data.days && data.healthy !== undefined && data.lapsed) {
      const proof = provenRate(data.days, data.deaths, want);
      const rate = proof?.rate ?? 0;
      const healthy = data.healthy + data.lapsed.waiting;
      const counted = `${healthy} healthy prod accounts (${data.healthy} admissible now${data.lapsed.waiting ? `, ${data.lapsed.waiting} waiting on a proxy session renewal` : ""})`;
      metrics.prod_capacity_pages_day = healthy * rate;
      const onHand = data.accounts.filter(account => !(DEAD as readonly string[]).includes(account.status)).length;
      const need = rate ? Math.ceil(PAGES_A_DAY_GOAL / rate) : null;
      flagged.push({ at, kind: "capacity", excerpt: (proof
        ? `${counted} x ${fmt(rate)} pages a day per account, proven on ${proof.days.join(" and ")} (the ${want}th busiest account read that much each day, 0 Instagram verdicts at or under it) = ${fmt(healthy * rate)} pages a day. `
          + `${need! > healthy ? `${need! - healthy} more healthy accounts at that rate reach ${fmt(PAGES_A_DAY_GOAL)}. ` : ""}`
          + `${onHand} prod accounts on hand (not dead) x ${fmt(rate)} = ${fmt(onHand * rate)}${onHand * rate < PAGES_A_DAY_GOAL ? `, short of ${fmt(PAGES_A_DAY_GOAL)}: only more accounts or a higher proven rate reach it` : ", enough once they are healthy"}.`
        : `${counted}, and no rate is proven: no ${PROOF_DAYS} consecutive full UTC days had ${want} accounts read at one rate with 0 Instagram verdicts at or under it.`).slice(0, 600) });
    }
    if (data.lapsed && (data.lapsed.waiting || data.lapsed.blocked)) flagged.push({ at, kind: "lapsed_bindings", excerpt: (`${data.lapsed.waiting + data.lapsed.blocked} active prod accounts have no live proxy session binding, the oldest since ${utc(data.lapsed.oldestAt!)}. `
      + `${data.lapsed.waiting} wait on the renewal loop and count as capacity: they read again once the proxy answers (a GeoNode supply hold or neutral_address_unresolved renewals point at the proxy). `
      + (data.lapsed.blocked ? `${data.lapsed.blocked} have a blocked renewal row that nothing retries and are left out of capacity: clear them through the shipped rotation path.` : "")).slice(0, 600) });
  }
  if (data.deepWalks) {
    const stops = Object.entries(data.deepWalks.errors).filter(([code]) => !NOT_PAGINATION.has(code));
    const left = Object.entries(data.deepWalks.errors).filter(([code]) => NOT_PAGINATION.has(code));
    const errorStops = stops.reduce((sum, [, count]) => sum + count, 0);
    const total = data.deepWalks.reached + errorStops;
    metrics.deep_walk_ok_pct = total ? round1(100 * data.deepWalks.reached / total) : 100;
    const list = (entries: [string, number][]): string => entries.map(([code, count]) => `${code} ${count}`).join(", ");
    flagged.push({ at, kind: "deep_walks", excerpt: `365-day logged-in collab walks in the last 24 h: ${fmt(data.deepWalks.reached)} reached their end, ${errorStops} stopped on an error${errorStops ? ` (${list(stops)})` : ""}; `
      + `profile_not_found and fleet_exhausted are not pagination errors and are left out${left.length ? ` (${list(left)})` : ""}` });
  }
  metrics.source_errors = data.errors.length;
  const failed = new Set(data.errors.flatMap(error => FEEDS[error.source]));
  const replaced: string[] = [];
  for (const metric of dutyMetrics) {
    if (!failed.has(metric.key) && Number.isFinite(metrics[metric.key])) continue;
    metrics[metric.key] = unmeasured(metric);
    replaced.push(metric.key);
  }
  if (replaced.length) flagged.push({ at, kind: "unmeasured", excerpt: `A source failed, so these read 0 (at least) or ${UNMEASURED} (at most) and miss: ${replaced.join(", ")}. Fix the read each source_error line names.`.slice(0, 300) });
  return { metrics, flagged };
}

const DEAD_SQL = `('${DEAD.join("', '")}')`;
const DAYS_SQL = `select to_char(l.at at time zone 'UTC', 'YYYY-MM-DD') as day, l.account_id, sum(l.pages) as pages
from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id
where a.world = 'prod' and l.at < date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' group by 1, 2 having sum(l.pages) > 0`;
const STAGING_SQL = `select extract(epoch from max(l.at)) * 1000 as last_read_at from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id
where a.world = 'staging' and l.pages > 0`;
const STAGING_PAUSES_SQL = `select c.key, w.id, extract(epoch from w.ts) * 1000 as at, w.actor, left(w.reason, 160) as reason from config c
left join lateral (select id, ts, actor, reason from config_audit a where a.key = c.key order by a.id desc limit 1) w on true
where c.key like 'pause.%' and c.value = 'true' order by c.key`;
const ACCOUNTS_SQL = "select id, status, status_reason as reason from ig_engage_accounts where world = 'prod' order by id";
const DEATHS_SQL = `select e.account_id, extract(epoch from e.at) * 1000 as at, e.outcome, e.error_code,
  exists (select 1 from ig_engage_read_log l where l.account_id = e.account_id and l.pages > 0 and l.at < e.at) as read_before,
  (select coalesce(sum(l.pages), 0) from ig_engage_read_log l where l.account_id = e.account_id and l.at <= e.at and l.at > e.at - interval '24 hours') as pages_24h
from ig_engage_account_events e join ig_engage_accounts a on a.id = e.account_id where a.world = 'prod' and e.outcome in ${DEAD_SQL} order by e.at`;
/** The lapsed session bindings, as lapsedOf parses them; the 60 s is READ_PAGE_TIMEOUT_SECONDS, the margin the egress admission keeps. */
export const LAPSED_REMOTE = `set -u
PW=$(tr -d '\\n' < /root/prod-pg-owner-ro.txt)
docker exec -i -e PGAPPNAME=engage-reads-duty -e PGPASSWORD="$PW" virev-prod-postgres psql -X -h 127.0.0.1 -U owner_ro -d crawler_v3 -q -t -A -F '\t' -v ON_ERROR_STOP=1 <<'SQL'
set default_transaction_read_only = on;
select count(*) filter (where r.status is distinct from 'blocked'), count(*) filter (where r.status = 'blocked'),
  coalesce(round(extract(epoch from min(b.expires_at)) * 1000), 0)
from ig_engage_accounts a join ig_engage_session_bindings b on b.account_id = a.id and b.credential_generation = a.credential_generation
left join ig_engage_session_renewals r on r.account_id = a.id
where a.world = 'prod' and a.status = 'active' and b.expires_at <= now() + interval '60 seconds';
SQL
`;

export function lapsedOf(tsv: string): Lapsed {
  const [waiting, blocked, oldest, ...rest] = tsv.trim().split("\t").map(Number);
  if (waiting === undefined || blocked === undefined || oldest === undefined || rest.length || ![waiting, blocked, oldest].every(Number.isFinite))
    throw new Error(`lapsed bindings: unexpected answer ${tsv.slice(0, 80)}`);
  return { waiting, blocked, oldestAt: waiting + blocked ? oldest : null };
}

const CONFIG_SQL = "select key, value from config where key like 'engage.rate_test%' or key like 'pause.engage%'";
/** The deep collab walks on prod: watch_targets kind tagged (the logged-in usertags route) at depth 365, the 24 h window of the duty. */
export const DEEP_WALKS_REMOTE = `set -u
PW=$(tr -d '\\n' < /root/prod-pg-owner-ro.txt)
docker exec -i -e PGAPPNAME=engage-reads-duty -e PGPASSWORD="$PW" virev-prod-postgres psql -X -h 127.0.0.1 -U owner_ro -d crawler_v3 -q -t -A -F '\t' -v ON_ERROR_STOP=1 <<'SQL'
set default_transaction_read_only = on;
select case when walk_done_at is not null and walk_end in ('since', 'exhausted') then 'reached' else 'error' end,
  case when walk_done_at is not null and walk_end in ('since', 'exhausted') then '' else coalesce(nullif(walk_end, ''), last_error_code, 'error') end, count(*)
from watch_targets where platform = 'instagram' and kind = 'tagged' and depth_days >= 365
  and ((walk_done_at > now() - interval '24 hours')
    or (walk_done_at is null and walk_since is not null and last_run_at > now() - interval '24 hours' and last_outcome = 'error'))
group by 1, 2;
SQL
`;

/** The oldest due staging collab read, as stagingDueOf parses it: tagged rows past next_due_at, unpaused and with no open claim. */
export const STAGING_DUE_REMOTE = `set -u
PW=$(tr -d '\\n' < /root/staging-pg-owner-ro.txt)
docker exec -i -e PGAPPNAME=engage-reads-duty -e PGPASSWORD="$PW" virev-staging-postgres psql -X -h 127.0.0.1 -U owner_ro -d crawler_v3 -q -t -A -F '\t' -v ON_ERROR_STOP=1 <<'SQL'
set default_transaction_read_only = on;
select count(*), coalesce(round((extract(epoch from now() - min(w.next_due_at)) / 60)::numeric, 1), 0)
from watch_targets w where w.platform = 'instagram' and w.kind = 'tagged' and not w.paused and w.next_due_at < now()
  and not exists (select 1 from watch_target_claims c where c.platform = w.platform and c.kind = w.kind and c.target = w.target and c.settled_at is null);
SQL
`;

export function stagingDueOf(tsv: string): StagingDue {
  const [due, waitMin, ...rest] = tsv.trim().split("\t").map(Number);
  if (due === undefined || waitMin === undefined || rest.length || !Number.isFinite(due) || !Number.isFinite(waitMin)) throw new Error(`staging due reads: unexpected answer ${tsv.slice(0, 80)}`);
  return { due, waitMin };
}

export const daysOf = (rows: Record<string, unknown>[]): DayPages[] => rows.map(row => ({ day: String(row.day), accountId: Number(row.account_id), pages: Number(row.pages) }));
export const accountsOf = (rows: Record<string, unknown>[]): Account[] => rows.map(row => ({ id: Number(row.id), status: String(row.status), ...(row.reason ? { reason: String(row.reason) } : {}) }));
export const stagingPausesOf = (rows: Record<string, unknown>[]): StagingPause[] => rows.map(row => ({
  key: String(row.key), auditId: num(row.id), at: num(row.at), actor: row.actor == null ? null : String(row.actor), reason: row.reason == null ? null : String(row.reason),
}));
export const deathsOf = (rows: Record<string, unknown>[]): Death[] => rows.map(row => ({
  accountId: Number(row.account_id), at: Number(row.at), status: String(row.outcome), code: row.error_code == null ? null : String(row.error_code),
  readBefore: row.read_before === true, pages24h: Number(row.pages_24h ?? 0),
}));
export function deepWalksOf(tsv: string): DeepWalks {
  const walks: DeepWalks = { reached: 0, errors: {} };
  for (const line of tsv.split("\n").filter(Boolean)) {
    const [kind, code, count] = line.split("\t");
    if (kind === "reached") walks.reached += Number(count);
    else if (kind === "error") walks.errors[code || "error"] = Number(count);
    else throw new Error(`deep walks: unexpected line ${line.slice(0, 80)}`);
  }
  return walks;
}

export async function measure(query: DsQuery | null, authError: string | null, now: number, remote: () => Promise<string>, stagingRemote: () => Promise<string>,
  lapsedRemote: () => Promise<string>): Promise<EngageData> {
  const data: EngageData = { now, errors: [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const deepWalks = step("prod deep walks", async () => deepWalksOf(await remote()));
  const stagingDue = step("staging due reads", async () => stagingDueOf(await stagingRemote()));
  const lapsedBindings = step("prod lapsed bindings", async () => lapsedOf(await lapsedRemote()));
  if (!query) {
    data.errors.push({ source: "grafana auth", message: authError ?? "no Grafana login" });
    for (const source of ["prod read log", "staging read log", "staging config", "prod accounts", "prod config", "prod healthy gauge"] as const) data.errors.push({ source, message: "not read: no Grafana login" });
    const [walks, due, lapsed] = await Promise.all([deepWalks, stagingDue, lapsedBindings]);
    if (walks) data.deepWalks = walks;
    if (due) data.stagingDue = due;
    if (lapsed) data.lapsed = lapsed;
    return data;
  }
  const [days, staging, stagingPauses, accounts, deaths, config, healthy, gauge, walks, due, lapsed] = await Promise.all([
    step("prod read log", async () => daysOf(await sqlRows(query, PG.prod, DAYS_SQL))),
    step("staging read log", async () => num((await sqlRows(query, PG.staging, STAGING_SQL))[0]?.last_read_at)),
    step("staging config", async () => stagingPausesOf(await sqlRows(query, PG.staging, STAGING_PAUSES_SQL))),
    step("prod accounts", async () => accountsOf(await sqlRows(query, PG.prod, ACCOUNTS_SQL))),
    step("prod accounts", async () => deathsOf(await sqlRows(query, PG.prod, DEATHS_SQL))),
    step("prod config", async () => Object.fromEntries((await sqlRows(query, PG.prod, CONFIG_SQL)).map(row => [String(row.key), String(row.value ?? "")]))),
    step("prod healthy gauge", async () => {
      const series = await promInstant(query, PROM.prod, 'max(crawler_v3_engage_admissible_now{world="prod"})');
      if (!series.length || !Number.isFinite(series[0]!.value)) throw new Error("crawler_v3_engage_admissible_now has no prod sample");
      return series[0]!.value;
    }),
    step("prod death gauge", async () => Object.fromEntries((await promInstant(query, PROM.prod, 'max by (cause)(crawler_v3_engage_deaths_24h{world="prod"})')).map(series => [series.labels.cause ?? "?", series.value]))),
    deepWalks,
    stagingDue,
    lapsedBindings,
  ]);
  Object.assign(data, days && { days }, staging !== undefined && { stagingLastReadAt: staging }, stagingPauses && { stagingPauses }, accounts && { accounts }, deaths && { deaths }, config && { config },
    healthy !== undefined && { healthy }, lapsed && { lapsed }, gauge && { deathGauge: gauge }, walks && { deepWalks: walks }, due && { stagingDue: due });
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("engage-reads: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  const signal = AbortSignal.timeout(SOURCE_DEADLINE_MS);
  let query: DsQuery | null = null;
  let authError: string | null = null;
  try { query = grafanaClient(fetch, await readGrafanaAuth(), now, signal); } catch (error) { authError = error instanceof Error ? error.message : String(error); }
  const result = report(await measure(query, authError, now, () => ssh(DEEP_WALKS_REMOTE, signal), () => ssh(STAGING_DUE_REMOTE, signal), () => ssh(LAPSED_REMOTE, signal)), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`engage-reads: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
