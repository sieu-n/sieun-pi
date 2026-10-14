import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, HOUR, PG, PROM, SOURCE_DEADLINE_MS, grafanaClient, num, promInstant, readGrafanaAuth, round1, settle, sqlRows, ssh,
  unmeasuredFlag, utc,
} from "./estate-reads.ts";

/**
 * The Engage reads scale safely duty's precheck for launch main bro (`node --import tsx scripts/duties/engage-reads.ts`). Code only, no model
 * call, reads only. It measures goal p1, whether prod HAS THE CAPACITY to read 100k logged-in pages a day, years deep, without accounts dying
 * (the owner, 10-14: "i said 'Have the capacity to' which is what you should check"), and his standing canary rule, from:
 * - estate_pg_prod and estate_pg_stg through Grafana (grafana_ro): ig_engage_read_log, ig_engage_accounts, ig_engage_account_events, the
 *   config keys engage.rate_test_arms, engage.rate_test_started_at and pause.engage*, and on staging every pause.* row that reads 'true'
 *   with its last config_audit writer;
 * - estate_prometheus: crawler_v3_engage_admissible_now{world="prod"} (the healthy accounts: active, bound and passing egress admission, GET
 *   /ops/engage/health admissible_now), and crawler_v3_engage_deaths_24h{cause} to cross-check the death count;
 * - prod watch_targets through one ssh to us-metal01 as owner_ro (grafana_ro cannot read watch_targets), for the deep collab walks, and
 *   staging watch_targets the same way, for the oldest due staging collab read.
 * grafana_ro cannot read the actor, transition and from_status columns of ig_engage_account_events, so a death here is a dead-outcome event, and
 * its cause is that event's error_code through CODE_CAUSES below.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "engage-reads.duty.json");

/*
 * Targets in engage-reads.duty.json and their sources:
 * - prod_capacity_pages_day >= 100000: the owner, 10-09, "read 100k pages/day". Capacity is the healthy prod accounts times provenRate().
 * - fleet_ig_killed_pct <= 2 and canary_ig_deaths_1h <= 3: the owner's own numbers, 10-14 02:13Z.
 * - deep_walk_ok_pct >= 99: the owner, 10-09, "reliable logged-in apis including pagination api for up to years". Measured 10-14 02:30Z on
 *   prod: of the 365-day collab walks, 8,960 of 8,978 in the last 72 h reached their end (99.8%), by UTC day 10-12 5,259 of 5,259 and 10-13
 *   3,664 of 3,681 (99.5%). The target is the 72 h value rounded down to a whole percent.
 * - canary_accounts_short <= 0: the owner, 10-12 13:33Z, "ALWAYS RUN ~10% account as CANARY"; CANARY_SHARE below.
 * - staging_due_wait_min <= 60: staging stays a working test bed, so a due staging collab read starts within an hour. The owner keeps about
 *   10 monitored accounts on staging (t17, 10-12), so staging reads come in bursts hours apart by design, and the time since the last read
 *   says nothing; the wait of the oldest due, unpaused, unclaimed tagged row does. The 60 min is the launch VP's number, not the owner's.
 * - source_errors <= 0: a source that failed is reported, never shown as green.
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
/** The data each metric reads; a metric whose source failed is not measured. */
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  prod_capacity_pages_day: ["prod read log", "prod accounts", "prod healthy gauge"],
  staging_due_wait_min: ["staging due reads"],
  fleet_ig_killed_pct: ["prod accounts", "prod config"], canary_ig_deaths_1h: ["prod accounts", "prod config"],
  canary_accounts_short: ["prod accounts", "prod config"],
  deep_walk_ok_pct: ["prod deep walks"],
};
export type Source = "grafana auth" | "prod read log" | "staging read log" | "staging due reads" | "staging config" | "prod accounts" | "prod config" | "prod healthy gauge" | "prod death gauge" | "prod deep walks";

/** Pages one prod account read on one full UTC day (YYYY-MM-DD). */
export interface DayPages { day: string; accountId: number; pages: number }
/** A dead-outcome event: Instagram's verdict when causeOf() says so. `pages24h` is what the account read in the 24 h before it. */
export interface Death { accountId: number; at: number; status: string; code: string | null; readBefore: boolean; pages24h: number }
export interface Account { id: number; status: string; reason?: string }
/** Staging's due collab reads: tagged rows past next_due_at, unpaused and with no open claim, and the oldest one's wait in minutes. */
export interface StagingDue { due: number; waitMin: number }
/** A staging pause row that reads 'true', with the config_audit row that last wrote its key (null fields when none did). */
export interface StagingPause { key: string; auditId: number | null; at: number | null; actor: string | null; reason: string | null }
/** The 365-day collab walks of the last 24 h: walks that reached their end (since or exhausted), and error stops by code. */
export interface DeepWalks { reached: number; errors: Record<string, number> }
export interface EngageData {
  now: number;
  days?: DayPages[]; stagingLastReadAt?: number | null; stagingDue?: StagingDue; stagingPauses?: StagingPause[]; accounts?: Account[]; deaths?: Death[]; config?: Record<string, string>;
  healthy?: number; deepWalks?: DeepWalks;
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
export function stagingStallFlag(data: EngageData, dutyMetrics: readonly DutyMetric[]): FlaggedSlice | null {
  const target = dutyMetrics.find(metric => metric.key === "staging_due_wait_min")?.target ?? 60;
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
  const failed = new Set(data.errors.map(error => error.source));
  const unmeasured = new Set(Object.keys(NEEDS).filter(key => NEEDS[key]!.some(source => failed.has(source))));
  if (data.stagingLastReadAt === null) flagged.push({ at, kind: "never_read", excerpt: "staging ig_engage_read_log has no read with pages > 0 at all" });
  if (data.stagingDue) metrics.staging_due_wait_min = data.stagingDue.waitMin;
  const stagingStall = stagingStallFlag(data, dutyMetrics);
  if (stagingStall) flagged.push(stagingStall);
  if (data.accounts && data.config && data.deaths) {
    const active = data.accounts.filter(account => account.status === "active");
    const roster = canaryRoster(data.config, now);
    const want = canaryWant(active.length);
    const have = active.filter(account => roster.ids.has(account.id)).length;
    metrics.canary_accounts_short = Math.max(0, want - have);
    flagged.push({ at, kind: "canary", excerpt: `${roster.note}; ${have} of ${active.length} active prod accounts are in it, and ~10% is ${want}` });
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
    if (data.days && data.healthy !== undefined) {
      const proof = provenRate(data.days, data.deaths, want);
      const rate = proof?.rate ?? 0;
      metrics.prod_capacity_pages_day = data.healthy * rate;
      const onHand = data.accounts.filter(account => !(DEAD as readonly string[]).includes(account.status)).length;
      const need = rate ? Math.ceil(PAGES_A_DAY_GOAL / rate) : null;
      flagged.push({ at, kind: "capacity", excerpt: (proof
        ? `${data.healthy} healthy prod accounts (crawler_v3_engage_admissible_now) x ${fmt(rate)} pages a day per account, proven on ${proof.days.join(" and ")} (the ${want}th busiest account read that much each day, 0 Instagram verdicts at or under it) = ${fmt(data.healthy * rate)} pages a day. `
          + `${need! > data.healthy ? `${need! - data.healthy} more healthy accounts at that rate reach ${fmt(PAGES_A_DAY_GOAL)}. ` : ""}`
          + `${onHand} prod accounts on hand (not dead) x ${fmt(rate)} = ${fmt(onHand * rate)}${onHand * rate < PAGES_A_DAY_GOAL ? `, short of ${fmt(PAGES_A_DAY_GOAL)}: only more accounts or a higher proven rate reach it` : ", enough once they are healthy"}.`
        : `${data.healthy} healthy prod accounts, and no rate is proven: no ${PROOF_DAYS} consecutive full UTC days had ${want} accounts read at one rate with 0 Instagram verdicts at or under it.`).slice(0, 600) });
    }
  }
  if (data.deepWalks) {
    const errorStops = Object.values(data.deepWalks.errors).reduce((sum, count) => sum + count, 0);
    const total = data.deepWalks.reached + errorStops;
    metrics.deep_walk_ok_pct = total ? round1(100 * data.deepWalks.reached / total) : 100;
    flagged.push({ at, kind: "deep_walks", excerpt: `365-day logged-in collab walks in the last 24 h: ${fmt(data.deepWalks.reached)} reached their end, ${errorStops} stopped on an error${errorStops ? ` (${Object.entries(data.deepWalks.errors).map(([code, count]) => `${code} ${count}`).join(", ")})` : ""}; profile_not_found and fleet_exhausted are not pagination errors and are left out` });
  }
  metrics.source_errors = data.errors.length;
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
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

export async function measure(query: DsQuery | null, authError: string | null, now: number, remote: () => Promise<string>, stagingRemote: () => Promise<string>): Promise<EngageData> {
  const data: EngageData = { now, errors: [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const deepWalks = step("prod deep walks", async () => deepWalksOf(await remote()));
  const stagingDue = step("staging due reads", async () => stagingDueOf(await stagingRemote()));
  if (!query) {
    data.errors.push({ source: "grafana auth", message: authError ?? "no Grafana login" });
    for (const source of ["prod read log", "staging read log", "staging config", "prod accounts", "prod config", "prod healthy gauge"] as const) data.errors.push({ source, message: "not read: no Grafana login" });
    const [walks, due] = await Promise.all([deepWalks, stagingDue]);
    if (walks) data.deepWalks = walks;
    if (due) data.stagingDue = due;
    return data;
  }
  const [days, staging, stagingPauses, accounts, deaths, config, healthy, gauge, walks, due] = await Promise.all([
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
  ]);
  Object.assign(data, days && { days }, staging !== undefined && { stagingLastReadAt: staging }, stagingPauses && { stagingPauses }, accounts && { accounts }, deaths && { deaths }, config && { config },
    healthy !== undefined && { healthy }, gauge && { deathGauge: gauge }, walks && { deepWalks: walks }, due && { stagingDue: due });
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
  const result = report(await measure(query, authError, now, () => ssh(DEEP_WALKS_REMOTE, signal), () => ssh(STAGING_DUE_REMOTE, signal)), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`engage-reads: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
