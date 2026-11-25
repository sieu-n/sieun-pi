import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, HOUR, PG, PROM, SOURCE_DEADLINE_MS, UNMEASURED, grafanaClient, missValue, num, promInstant, promRange, readGrafanaAuth, round1, sqlRows, utc, type ProdRead, prodReader,
} from "./estate-reads.ts";
import { readCrawlerKey } from "./watchlist-green.ts";

/**
 * The Engage reads working duty's precheck for launch main bro (`node --import tsx scripts/duties/engage-reads.ts`). Code only, no model
 * call, reads only. It measures goal p1, whether prod HAS THE CAPACITY to read 100k logged-in pages a day, years deep, without accounts dying
 * (the owner, 10-14: "i said 'Have the capacity to' which is what you should check"), and his standing canary rule, from:
 * - estate_pg_prod and estate_pg_stg through Grafana (grafana_ro): ig_engage_read_log, ig_engage_accounts, ig_engage_account_events, the
 *   config keys engage.canary* (canaryOf below) and pause.engage*, and on staging every pause.* row that reads 'true'
 *   with its last config_audit writer;
 * - estate_prometheus: crawler_v3_engage_admissible_now{world="prod"} (the accounts that can read now: active, bound and passing egress admission,
 *   GET /ops/engage/health admissible_now), and crawler_v3_engage_deaths_24h{cause} to cross-check the death count;
 * - prod ig_engage_session_bindings and ig_engage_session_renewals through estate_pg_prod as psql lines (estate-reads.ts prodReader), for the
 *   active accounts whose proxy session binding ran out and that the renewal loop retries (LAPSED_SQL below);
 * - prod watch_targets the same way, for the deep collab walks, and staging watch_targets through estate_pg_stg, for the oldest due staging
 *   collab read.
 * grafana_ro cannot read the actor and from_status columns of ig_engage_account_events, so a death here is a dead-outcome event, and
 * its cause is that event's error_code through CODE_CAUSES below.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "engage-reads.duty.json");

/*
 * Targets in engage-reads.duty.json and their sources (owner rule c75: one headline and at most 3 supporting metrics):
 * - prod_capacity_pages_day >= 100000 is the headline: the owner, 10-09, "read 100k pages/day". Capacity is admissible_now, the prod accounts that can
 *   read now, times provenRate(). The active accounts whose proxy session binding ran out are left out and get their own line in the capacity flag:
 *   an account that cannot read is no capacity (the launch VP, 11-18: the line read 75,460 as 140 x 539 while 116 of the 140 had no binding and
 *   waited on a proxy purchase, todo t43, so 24 accounts read).
 * - fleet_ig_killed_pct <= 2: the owner's own metric, 10-14 02:14Z, "Prod accounts outside the canary that Instagram killed in 24 h ≤ 2%" and
 *   "Canary accounts that Instagram killed in the last 60 min <= 3" "are good metrics". It counts the accounts outside the canary roster over the
 *   active accounts. His canary number stays as the run detail canary_ig_deaths_1h, the most canary accounts Instagram killed in any 60 minutes of
 *   the last 24 h, so a daily run sees an hour it did not run in: on 11-18 Instagram suspended 23 canary accounts from 23:13Z to 00:02Z, and the
 *   11-19 run read 0 for its own last hour. The canary flag line carries it, and the crawler stops the canary itself at
 *   engage.canary_stop_deaths. Its judged slot went to engage_accounts_stuck on 10-18 (c75 keeps 3 supporting metrics).
 * - engage_accounts_stuck <= 0: "without accounts dieing" (10-09). It counts the prod accounts that sit out of reading for over STUCK_HOURS
 *   on a fault our code is meant to heal, the two standing risks on the chat's risk page (wiki apps/crawler-v3/engage-reads-and-watchlist-risks):
 *   frozen for a shared exit IP and not healed (p103), active and reading only lost-session 302s, or parked with an invalid jar and not re-logged (p105).
 *   A challenge or a suspension is Instagram's verdict, which fleet_ig_killed_pct counts, so it is no stuck account.
 * - deep_walk_ok_pct >= 99: the owner, 10-09, "reliable logged-in apis including pagination api for up to years". Measured 10-14 02:30Z on
 *   prod: of the 365-day collab walks, 8,960 of 8,978 in the last 72 h reached their end (99.8%), by UTC day 10-12 5,259 of 5,259 and 10-13
 *   3,664 of 3,681 (99.5%). The target is the 72 h value rounded down to a whole percent. The metric is the walks that reached their end
 *   over those plus the error stops plus the stuck walks. An error stop is a walk that ended on an error in the last 24 h. A stuck walk is
 *   an open walk whose last chunk ended on an error and that started more than one cadence ago, at any age, so it lowers the metric every
 *   run until it moves on: on 10-19 the metric read 100% while 32 open walks sat on cursor_provenance_missing. The run detail
 *   deep_walks_open_stuck counts them. An open walk that errored and started inside one cadence is retrying, so it is left out, and the
 *   deep_walks flag shows those as their own count with their codes. NOT_PAGINATION below names the codes left out of the stops.
 * - canary_ig_deaths_1h, canary_accounts_short, staging_tagged_overdue_24h, deep_walks_open_stuck, paced_busy_hour_share, paced_accts_200plus, paced_serveable_hours, best_proven_rate and source_errors are run detail:
 *   report() writes them to the output, the server does not judge them, and the canary_short, staging_stall and busy_hour_share flags carry them to the fix jobs.
 * - paced_busy_hour_share keeps closed goal p229 ("Engage accounts spread their pages across the day on prod, busiest hour at most a tenth of the
 *   day", 0.074 on 10-28) as run detail, because c75 holds d1 at one headline and 3 supporting metrics. Over BUSY_HOUR_SHARE_MAX the busy_hour_share
 *   flag is a handOff, so a run whose metrics read met still starts or steers a fix job. It counts serveable hours as servedDays() does, and a day
 *   with fewer than PACED_HOURS_FLOOR of them, such as the GeoNode hold of 11-09, is not scored.
 * - canary_accounts_short: the owner, 10-12 13:33Z, "ALWAYS RUN ~10% account as CANARY"; CANARY_SHARE below.
 * - staging_tagged_overdue_24h: staging stays a working test bed, so no staging collab read is overdue past 24 h. It is overdue_24h.tagged on
 *   staging's /ops/watch-targets/health, the crawler's own count, which leaves out the rows the crawler refuses by design. Until 11-24 this read
 *   its own SQL over watch_targets, which counted 369 house-group tagged rows that paid_only refuses (crawl_unpaid_paused) and flagged a 5,547 min
 *   stall while the route read overdue_24h tagged 0.
 * - A source that failed fails the run: every metric it feeds (FEEDS below) reads unmeasured() and a source_error flag names it.
 * The schedule is daily (owner rule c66). The duty's timeoutMs 120000 is the runner's soft target, PRECHECK_TARGET_MS in src/shared/chat-duties.ts.
 */

export const PAGES_A_DAY_GOAL = 100_000;
/** The owner's "~10%" (10-12 13:33Z): the canary is this share of active prod accounts, rounded to the nearest whole account. */
export const CANARY_SHARE = 0.1;
/** The owner's "over at least 2 full UTC days" rule for a proven rate (10-14). */
export const PROOF_DAYS = 2;
/**
 * prod_capacity_pages_day's trailing window: the PROOF_DAYS full UTC days its proof reads. Its lastEventAt is the end of the newest window day, so d9
 * reads a headline that holds a bad day as a lagging window until that day leaves (the launch VP, 10-31: the 10-30 day, when 3 persona-held canary
 * members read 0, held the number at 66,552 and 65,136 through 7 runs while the canary read about 1,100 a day).
 */
export const CAPACITY_WINDOW_MS = PROOF_DAYS * DAY;
/** Dead statuses, as `_DEAD_STATUSES` in apps/crawler-v3/src/control/metrics/health.py. */
export const DEAD = ["challenged", "frozen", "disabled"] as const;
/** A prod row parked by auto-sns-agent's scripts/engage_world_move.py export: the account reads in another world now, so prod no longer has it on hand.
 * The same prefix as NOT_MOVED in apps/crawler-v3/src/platforms/instagram/engage/relogin_codes.py. */
export const MOVED_PREFIX = "engage-world-move ";
/**
 * A parked row whose password Instagram refused: the re-login worker's stop (BAD_PASSWORD in apps/crawler-v3/src/platforms/instagram/engage/relogin_codes.py,
 * "final for that password") or the intake's refusal. No code logs such a row in again, and the owner answered t34 "Neither, 158 accounts are close
 * enough" to a seller ask for new passwords, so it is no capacity: prod 24 and 280 and the 10 g2g-T8KX imports 282 to 294 sat parked on it from 10-28
 * to 11-25 with 0 pages read, counted on hand.
 */
export const PASSWORD_REFUSED = /^(relogin_)?bad_password\b/;
/** The prod accounts on hand: not dead, not moved to another world and not parked on a refused password (PASSWORD_REFUSED). On 10-19 15:06Z the
 * capacity line counted 170 on hand and 165 healthy, and 3 of the 5 it called unable to read (23, 27 and 28) had moved to staging on 10-18 16:54Z,
 * where 245 and 246 read on. */
export const onHandOf = (accounts: readonly Account[]): Account[] =>
  accounts.filter(account => !(DEAD as readonly string[]).includes(account.status) && !(account.reason ?? "").startsWith(MOVED_PREFIX)
    && !(account.status === "parked" && PASSWORD_REFUSED.test(account.reason ?? "")));
export type Cause = "instagram" | "first_login" | "found_idle" | "bad_password" | "ours" | "unknown";
/**
 * A copy of CODE_CAUSES in apps/crawler-v3/src/control/metrics/engage_deaths.py (auto-sns-agent dev/sieun, 2026-10-28), which also holds the two codes
 * prod accounts 55 and 74 died with on 10-12: login_redirect (every usertags read answered 302 to the login page after both had served pages) and
 * instagram_session_killed. checkpoint_required is the jar check's verdict on prod 62, 262 and 267 on 10-18. The crawler's canary stop counts the same
 * map since auto-sns-agent a92e4b001, so a code missing here would stop the canary while d1 called the death unknown.
 *
 * The relogin_ codes come on top: the re-login worker's terminal verdicts (`_PHASE_STOPS` and `GONE` in
 * apps/crawler-v3/src/platforms/instagram/engage/relogin.py), which it writes as a login event with outcome challenged and no transition, so the
 * crawler map, which reads only transitions, never needs them. relogin_gone is an Instagram removal: prod 163 (ai80052) went relogin_gone on
 * 10-28 09:53Z, and on 10-29 02:40Z its logged-out profile read "does not exist" exactly as the 9 g2g-T8KX accounts Instagram froze with
 * account_suspended on read did. relogin_bad_password is a password Instagram no longer takes: prod 24 and 280 lost their sessions on 10-28 and
 * Instagram refused the stored password, while 281 of the same batch re-logged in that day, and of the 11 T8KX accounts refused on 10-28 none
 * logged in on its own exit 2 h later and 1 on a fresh exit 6 h later. A seedless two-factor screen is our missing seed, so ours.
 */
export const CODE_CAUSES: Readonly<Record<string, Cause>> = {
  account_suspended: "instagram", action_blocked: "instagram", challenge: "instagram", challenge_required: "instagram", challenged: "instagram",
  checkpoint_required: "instagram", instagram_session_killed: "instagram", login_redirect: "instagram", sentry_block: "instagram", suspended_on_first_contact: "instagram",
  bad_password: "bad_password",
  budget_meter_failed: "ours", exit_pinned: "ours", exit_unusable: "ours", geo_blocked: "ours", proxy_blocked: "ours", transport: "ours",
  relogin_account_not_found: "instagram", relogin_challenge: "instagram", relogin_disabled: "instagram", relogin_gone: "instagram", relogin_suspended: "instagram",
  relogin_bad_password: "bad_password", relogin_two_factor: "ours",
};
export type Source = "grafana auth" | "prod read log" | "prod supply holds" | "staging read log" | "staging watch health" | "staging config" | "prod accounts" | "prod config" | "prod healthy gauge" | "prod lapsed bindings" | "prod death gauge" | "prod deep walks" | "prod stuck accounts";
/**
 * How long an account may sit frozen for a shared exit, on 302s, or parked with a dead jar before it counts as stuck. The launch VP's number
 * (10-18): the accounts job wakes every 2 h, and jar account 16 sat active on 302s for 24 h (55 of 55 reads, 10-14 13:16Z to 10-15 12:00Z).
 */
export const STUCK_HOURS = 6;
/** An active account answering at least this many lost-session redirects (lostSession) and no page in STUCK_HOURS is stuck on 302s; account 16 answered 10 in 24 h on 10-18. */
export const STUCK_302S = 3;
/**
 * The judged metrics each source feeds; a failed source makes each of them read unmeasured(). The staging sources feed only detail lines, so
 * they fail the headline, the number a run is judged on, and an unread source never leaves the run green.
 */
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  "grafana auth": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h", "paced_busy_hour_share"],
  "prod read log": ["prod_capacity_pages_day", "paced_busy_hour_share"], "prod supply holds": ["prod_capacity_pages_day", "paced_busy_hour_share"], "prod healthy gauge": ["prod_capacity_pages_day"], "prod lapsed bindings": ["prod_capacity_pages_day"],
  "prod accounts": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "prod config": ["prod_capacity_pages_day", "fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "prod death gauge": ["fleet_ig_killed_pct", "canary_ig_deaths_1h"],
  "staging read log": ["prod_capacity_pages_day"], "staging watch health": ["prod_capacity_pages_day"], "staging config": ["prod_capacity_pages_day"],
  "prod deep walks": ["deep_walk_ok_pct"],
  "prod stuck accounts": ["engage_accounts_stuck"],
};
/** The value of a metric a failed source feeds: 0 for an at-least metric (no pages counted, no walk reached), missValue() for an at-most one. */
export const unmeasured = (metric: Pick<DutyMetric, "op" | "target">): number => metric.op === ">=" ? Math.min(0, metric.target - 1) : missValue(metric);

/** Pages one prod account read on one full UTC day (YYYY-MM-DD). */
export interface DayPages { day: string; accountId: number; pages: number }
/**
 * One prod account's read-log rows in one UTC hour of a full day: the pages it read, its account_busy refusals, its reads that failed on transport
 * and its sends, the reads not refused at dispatch (HOURS_SQL).
 */
export interface AccountHour { day: string; hour: number; accountId: number; pages: number; busy: number; transport: number; sends: number }
/**
 * A dead-outcome event: Instagram's verdict when causeOf() says so. `pages24h` is what the account read in the 24 h before it. `transition` is false
 * for the re-login worker's verdicts, which leave the account parked, and crawler_v3_engage_deaths_24h counts only transitions.
 */
export interface Death { accountId: number; at: number; status: string; code: string | null; readBefore: boolean; pages24h: number; transition: boolean }
export interface Account { id: number; status: string; reason?: string }
/** Staging's collab reads as its crawler counts them on /ops/watch-targets/health: tagged rows overdue past 24 h and tagged rows due now. */
export interface StagingOverdue { overdue: number; due: number }
/** A staging pause row that reads 'true', with the config_audit row that last wrote its key (null fields when none did). */
export interface StagingPause { key: string; auditId: number | null; at: number | null; actor: string | null; reason: string | null }
/**
 * Active prod accounts whose current proxy session binding has run out (or runs out inside one page's timeout, as the egress admission
 * refuses it): `waiting` have a renewal row that is not blocked, so the renewal loop retries them; `blocked` wait for an operator.
 * `oldestAt` is when the oldest of them ran out, null when none has.
 */
export interface Lapsed { waiting: number; blocked: number; oldestAt: number | null }
/**
 * The 365-day collab walks: the walks of the last 24 h that reached their end (since or exhausted), the error stops of the last 24 h by code,
 * and by code the open walks whose last chunk errored: `stuck` when the walk started more than one cadence ago, `retrying` when it started
 * inside one cadence and its last chunk ran in the last 24 h. A retrying walk has not stopped, so it is left out of deep_walk_ok_pct.
 */
export interface DeepWalks { reached: number; errors: Record<string, number>; stuck: Record<string, number>; retrying: Record<string, number> }
/** Why a prod account is stuck (STUCK_SQL): its state, its id, and since when (the freeze or park, or its first 302 in the window). */
export type StuckKind = "frozen_shared_exit" | "active_302s" | "parked_dead_jar";
export interface StuckAccount { kind: StuckKind; accountId: number; since: number }
export interface EngageData {
  now: number;
  days?: DayPages[]; hours?: AccountHour[]; heldHours?: Set<string>; stagingLastReadAt?: number | null; stagingOverdue?: StagingOverdue; stagingPauses?: StagingPause[]; accounts?: Account[]; deaths?: Death[]; config?: Record<string, string>;
  healthy?: number; lapsed?: Lapsed; deepWalks?: DeepWalks; stuck?: StuckAccount[]; paced?: Paced;
  /** crawler_v3_engage_deaths_24h by cause. */
  deathGauge?: Record<string, number>;
  errors: { source: Source; message: string }[];
}

/** Prod's canary: its accounts (dead ones too, so their deaths count as canary deaths) and why it is empty. */
export interface Canary { ids: Set<number>; empty?: string }

/** The key the crawler's canary roster keeper (apps/crawler-v3/src/platforms/instagram/engage/canary_roster.py) sizes the roster by. */
export const CANARY_SHARE_KEY = "engage.canary_roster_pct";

/**
 * The canary accounts as the crawler reads them (`running_canary` in apps/crawler-v3/src/platforms/instagram/engage/experiment.py): the id roster
 * engage.canary_accounts, and none while it or engage.canary_started_at is empty. The roster keeper fills the roster to engage.canary_roster_pct of
 * the active accounts, and an empty row there is the crawler's default. Until 11-24 this read the retired hash keys engage.canary_pct and
 * engage.canary_offset when the roster was empty, so the 07:00Z run said "canary_pct is 0" while an 11-20 canary_roster_pct row of 0 had
 * emptied it (prod audit 49120 dropped that row, and the keeper refilled 8 members at the default).
 */
export function canaryOf(config: Readonly<Record<string, string>>): Canary {
  const roster = (config["engage.canary_accounts"] ?? "").trim();
  const started = (config["engage.canary_started_at"] ?? "").trim();
  const share = (config[CANARY_SHARE_KEY] ?? "").trim();
  if (!roster) return { ids: new Set(), empty: `engage.canary_accounts is empty and ${CANARY_SHARE_KEY} reads ${share ? `"${share}"` : "its default (empty row)"}` };
  const ids = roster.split(",").filter(text => text.trim()).map(Number);
  if (ids.some(id => !Number.isInteger(id)) || new Set(ids).size !== ids.length)
    return { ids: new Set(), empty: `engage.canary_accounts "${roster.slice(0, 80)}" is refused: a bad or repeated id` };
  if (!Number.isFinite(Date.parse(started)))
    return { ids: new Set(), empty: `engage.canary_accounts names accounts, but engage.canary_started_at "${started}" is ${started ? "not a time" : "empty"}, so the crawler runs no canary` };
  return { ids: new Set(ids) };
}

/**
 * The cause of one death, as cause_of in engage_deaths.py. grafana_ro cannot see the actor, so a death with no mapped code is unknown. An
 * Instagram verdict on an account that read no page in the 24 h before it is found_idle, as auto-sns-agent 429d03dc15: prod 158, 176 and 181
 * read their last pages at 07:25Z 11-09, sat idle 7 days with no proxy, and the re-login worker found them gone (relogin_gone) on 11-16, which
 * d1 counted as 3 read kills (2.1% of 140) while their 11 box peers with the same idle week read 482 to 496 pages each.
 */
export function causeOf(death: Pick<Death, "code" | "readBefore" | "pages24h">): Cause {
  const cause = CODE_CAUSES[death.code ?? ""];
  if (!cause) return "unknown";
  if (cause !== "instagram") return cause;
  if (!death.readBefore) return "first_login";
  return death.pages24h > 0 ? cause : "found_idle";
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
 * The significance level of deathExcessP() at which a rate counts as unsafe: the conventional 5% one-sided level. Measured on prod 10-30 over the
 * full UTC days 10-12 to 10-29, 2,224 account-days and 16 Instagram verdicts on accounts that had served a page in their last 24 h, the verdicts
 * per 100 account-days by the pages the account read that day were 0.11 under 100, 1.35 at 100 to 199, 2.03 at 200 to 299, 1.27 at 300 to 399,
 * 0.62 at 400 to 599, 1.31 at 600 to 799 and 0 in 215 account-days at 800 or more. By an account's busiest day, 5 of 42 that never read over 300
 * died, 0 of 27 at 301 to 600, 7 of 80 at 601 to 1,000 and 4 of 31 over 1,000. Deaths did not rise with pages, so a verdict proves a rate unsafe
 * only when the accounts reading it die more often than the rest.
 */
export const DEATH_EXCESS_P = 0.05;

/**
 * One-sided Fisher exact test: the chance that `hiDays` account-days drawn at random from all `hiDays + loDays` hold `hiDeaths` or more of the
 * `hiDeaths + loDeaths` verdicts. A small value says the account-days at the higher rate died more often than chance allows.
 */
export function deathExcessP(hiDays: number, hiDeaths: number, loDays: number, loDeaths: number): number {
  const total = hiDays + loDays;
  const deaths = hiDeaths + loDeaths;
  if (hiDeaths <= 0) return 1;
  const logFact = [0];
  for (let n = 1; n <= total; n++) logFact.push(logFact[n - 1]! + Math.log(n));
  const logChoose = (n: number, k: number): number => logFact[n]! - logFact[k]! - logFact[n - k]!;
  let p = 0;
  for (let k = hiDeaths; k <= Math.min(deaths, hiDays); k++) p += Math.exp(logChoose(deaths, k) + logChoose(total - deaths, hiDays - k) - logChoose(total, hiDays));
  return Math.min(1, p);
}

/** A proven rate, its days, and the death evidence it passed: account-days at or over the rate and under it since its first day, and the verdicts on each side. */
export interface Proof { rate: number; days: string[]; hiDays: number; hiDeaths: number; loDays: number; loDeaths: number; p: number }

/**
 * The highest pages a day one account is proven to read safely. A rate R is proven over PROOF_DAYS consecutive full UTC days when on each of
 * them at least `cohort` accounts (a canary's worth) read R pages or more, and from the first of those days on the accounts reading R or more
 * did not die more often than the accounts reading less: each account's first Instagram verdict counts at the pages it read in the 24 h before
 * it, every full UTC day an account read a page counts as one account-day at that day's pages, and deathExcessP() under DEATH_EXCESS_P makes R
 * unsafe. Until 10-30 any verdict at v pages unproved every rate of v or more, so prod 163 at 91 pages held the proven rate at 90 while 12 canary
 * accounts read up to 665 a day with 0 verdicts; DEATH_EXCESS_P has the data that retired it. A verdict on an account that read no page in its
 * last 24 h says nothing about a read rate and is left out (prod 55 and 74 on 10-12: every read answered 302 to login, so they read 0 pages
 * before Instagram killed the session). The rates tried are the day totals servedDays() gives each account.
 *
 * `newest` is the proof of the newest window, the last PROOF_DAYS full UTC days with reads, and it is the headline: the launch VP, 10-30, "the
 * headline must be today's capacity, not a two-week-old window", because the fleet, its seller lots and the pace changed after the 10-15 and
 * 10-16 pair proved 1,459. `best` is the highest rate any window proved, a later window winning ties, kept as run detail.
 *
 * A day a supply hold (`held`) left with fewer than PACED_HOURS_FLOOR hours is no proof day, read or served, because what its accounts read
 * there is the hold, not a rate: the hold covered 11-09 16Z through all of 11-23, the fleet read only in 23Z on 11-23, and the 11-25 run proved
 * 41 pages a day from that hour on the 11-23 and 11-24 window. A stop still shows in the headline through `healthy`, since
 * crawler_v3_engage_admissible_now read 0 through the hold until 23:00Z on 11-23.
 */
export interface ProvenRates { newestDays: string[] | null; newest: Proof | null; best: Proof | null; massActions: Death[][] }

/**
 * The saturated hours an account needs before its hourly rate counts; with fewer, its day counts at the pages it read.
 * measured: prod 11-05 to 11-07, 13 accounts with 30+ saturated hours; the median of 8 random ones fell within 10% of the account's own in 93% of 6,500 draws (5 hours 88%, 3 hours 81%).
 */
export const SATURATED_HOURS_FLOOR = 8;

/**
 * What each account could serve on each day of `hours`, so the proof reads supply and not the demand a day happened to send (c67; the launch VP,
 * 11-08: on 11-07 the canary had no throttle and no fence, and 13,348 pages split over 15 to 18 members put rank 14 at 732). An account-hour is
 * saturated when it logged an account_busy refusal, a pinned read that found the account's pace full, and read a page. The account's hourly rate
 * is its median pages over its saturated hours in `hours`, and its day is that rate times its serveable hours:
 * - an hour it logged a row counts, unless it read no page and a read failed on transport, because its exit could serve nothing then;
 * - an hour no prod account logged a row counts when no supply hold covered it (`held`, "YYYY-MM-DD H" keys), because then demand was empty
 *   (11-07 10Z), while a held hour is an outage the accounts could not serve through (the GeoNode hold from 08:44Z on 11-09; the launch VP, 11-10:
 *   a green 127,872 on that pair hid a full stop);
 * - an hour the fleet read and it logged no row does not count, because a fenced, frozen, parked or unbound account logs no row (prod 11-05 and
 *   11-06, every canary gap of 5 to 7 hours followed a 'throttled' answer with no row at all).
 * An account under SATURATED_HOURS_FLOOR, a day it read more than that, and every day outside `hours` keep the pages it read.
 */
export function servedDays(days: readonly DayPages[], hours: readonly AccountHour[], held: ReadonlySet<string> = new Set()): DayPages[] {
  const saturated = new Map<number, number[]>();
  const open = new Map<string, number>();
  const fleetHours = new Map<string, Set<number>>();
  for (const row of hours) {
    const dead = row.pages === 0 && row.transport > 0;
    if (row.busy > 0 && !dead) saturated.set(row.accountId, [...saturated.get(row.accountId) ?? [], row.pages]);
    const key = `${row.day} ${row.accountId}`;
    open.set(key, (open.get(key) ?? 0) + (dead ? 0 : 1));
    fleetHours.set(row.day, (fleetHours.get(row.day) ?? new Set()).add(row.hour));
  }
  const rates = new Map<number, number>();
  for (const [accountId, pages] of saturated) if (pages.length >= SATURATED_HOURS_FLOOR) rates.set(accountId, median(pages));
  const emptyHours = new Map<string, number>();
  for (const [day, busy] of fleetHours)
    emptyHours.set(day, Array.from({ length: 24 }, (_, hour) => hour).filter(hour => !busy.has(hour) && !held.has(`${day} ${hour}`)).length);
  const served = new Map(days.map(row => [`${row.day} ${row.accountId}`, row]));
  for (const key of open.keys()) if (!served.has(key)) { const [day, id] = key.split(" "); served.set(key, { day: day!, accountId: Number(id), pages: 0 }); }
  return [...served.values()].map(row => {
    const rate = rates.get(row.accountId);
    const hoursOn = open.get(`${row.day} ${row.accountId}`);
    if (rate === undefined || hoursOn === undefined) return row;
    return { ...row, pages: Math.max(row.pages, Math.round(rate * (hoursOn + emptyHours.get(row.day)!))) };
  });
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * More than this many first Instagram verdicts inside MASS_ACTION_MS make one mass action: the owner's canary line, 10-14, "Canary accounts that
 * Instagram killed in the last 60 min <= 3".
 */
export const MASS_ACTION_DEATHS = 3;
export const MASS_ACTION_MS = HOUR;

/**
 * The first Instagram verdicts that belong to a mass action, grouped by action, oldest first: every verdict in a MASS_ACTION_MS window that holds more
 * than MASS_ACTION_DEATHS of them, with verdicts under MASS_ACTION_MS apart joined into one action. Such an action is Instagram acting on a cluster of
 * accounts at once, and its victims' read rates do not separate them from the survivors: from 23:13Z on 11-18 to 00:02Z on 11-19 one action took 23
 * of the 24 prod box readers on 64.34.205.244, .246 and .247 and 5 of staging's 8 on .245, at every pace from about 15 to 50 pages an hour, while the
 * 23 replacements on the same addresses read about 16,000 pages the next day with 0 deaths (auto-sns-agent EVIDENCE.md L34). Counted as per-account
 * verdicts, its 23 deaths at about 1,100 pages each against the few account-days under that left the 11-18 and 11-19 window proving 37 pages a day.
 */
export function massActions(verdicts: readonly Death[]): Death[][] {
  const sorted = [...verdicts].sort((a, b) => a.at - b.at);
  const inAction = new Set<Death>();
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while (sorted[j]!.at < sorted[i]!.at - MASS_ACTION_MS) j++;
    if (i - j + 1 > MASS_ACTION_DEATHS) for (let k = j; k <= i; k++) inAction.add(sorted[k]!);
  }
  const actions: Death[][] = [];
  for (const death of sorted.filter(death => inAction.has(death))) {
    const last = actions.at(-1);
    if (last && death.at - last.at(-1)!.at < MASS_ACTION_MS) last.push(death);
    else actions.push([death]);
  }
  return actions;
}

/**
 * The newest window's proof and the best one, as ProvenRates says. `served` (servedDays) sets the rates tried and the cohort ceiling, and the
 * death evidence stays the pages each account read. A mass action (massActions) proves nothing about one account's rate, so its verdicts leave the
 * evidence, and so do its victims' account-days on the day of their verdict and the day before, read and served alike, the days its pages24h
 * covers, so those pages count neither as a death nor as a survival. ProvenRates.massActions lists the actions for the capacity line.
 */
export function provenRates(days: readonly DayPages[], deaths: readonly Death[], cohort: number, served: readonly DayPages[] = days, held: ReadonlySet<string> = new Set()): ProvenRates {
  if (cohort < 1) return { newestDays: null, newest: null, best: null, massActions: [] };
  const firstVerdicts = new Map<number, Death>();
  for (const death of [...deaths].sort((a, b) => a.at - b.at))
    if (causeOf(death) === "instagram" && death.pages24h > 0 && !firstVerdicts.has(death.accountId)) firstVerdicts.set(death.accountId, death);
  const actions = massActions([...firstVerdicts.values()]);
  const acted = new Set(actions.flat());
  const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const actedDays = new Set(actions.flat().flatMap(death => [`${dayOf(death.at - DAY)} ${death.accountId}`, `${dayOf(death.at)} ${death.accountId}`]));
  const heldCount = new Map<string, number>();
  for (const key of held) { const day = key.split(" ")[0]!; heldCount.set(day, (heldCount.get(day) ?? 0) + 1); }
  const heldDays = new Set([...heldCount].filter(([, count]) => 24 - count < PACED_HOURS_FLOOR).map(([day]) => day));
  const dayPages = (rows: readonly DayPages[]): Map<string, number[]> => {
    const byDay = new Map<string, number[]>();
    for (const row of rows) if (row.pages > 0 && !heldDays.has(row.day) && !actedDays.has(`${row.day} ${row.accountId}`)) byDay.set(row.day, [...byDay.get(row.day) ?? [], row.pages]);
    for (const pages of byDay.values()) pages.sort((a, b) => b - a);
    return byDay;
  };
  const byDay = dayPages(served);
  const readByDay = dayPages(days);
  const proofOf = (run: string[]): Proof | null => {
    const first = run[0]!;
    const start = Date.parse(`${first}T00:00:00Z`);
    const verdicts = [...firstVerdicts.values()].filter(death => death.at >= start && !acted.has(death)).map(death => death.pages24h);
    const accountDays = [...readByDay].filter(([day]) => day >= first).flatMap(([, pages]) => pages);
    const ceiling = Math.min(...run.map(day => byDay.get(day)![cohort - 1] ?? 0));
    const rates = [...new Set(run.flatMap(day => byDay.get(day)!))].filter(rate => rate <= ceiling).sort((a, b) => b - a);
    for (const rate of rates) {
      const hiDays = accountDays.filter(pages => pages >= rate).length;
      const hiDeaths = verdicts.filter(pages => pages >= rate).length;
      const evidence = { hiDays, hiDeaths, loDays: accountDays.length - hiDays, loDeaths: verdicts.length - hiDeaths };
      const p = deathExcessP(evidence.hiDays, evidence.hiDeaths, evidence.loDays, evidence.loDeaths);
      if (p >= DEATH_EXCESS_P) return { rate, days: run, ...evidence, p };
    }
    return null;
  };
  const result: ProvenRates = { newestDays: null, newest: null, best: null, massActions: actions };
  for (const first of [...byDay.keys()].sort()) {
    const run = [first];
    while (run.length < PROOF_DAYS && byDay.has(nextDay(run.at(-1)!))) run.push(nextDay(run.at(-1)!));
    if (run.length < PROOF_DAYS) continue;
    const proof = proofOf(run);
    result.newestDays = run;
    result.newest = proof;
    if (proof && (!result.best || proof.rate >= result.best.rate)) result.best = proof;
  }
  return result;
}

const fmt = (value: number): string => value.toLocaleString("en-US");

/**
 * When staging's crawler counts a collab read overdue past 24 h, the staging pause rows that read 'true' and who last wrote each. A deploy that
 * closes admissions writes pause rows as actor metal-deploy, and on 2026-10-14 staging's pause.crawl and pause.refresh had read 'true' since a
 * 2026-09-23 deploy (config_audit 13588, 13589) that never reopened them (owner rule c63). This line names such a row so the duty run clears
 * it instead of finding it weeks later.
 */
export function stagingStallFlag(data: EngageData): FlaggedSlice | null {
  if (!data.stagingOverdue || data.stagingOverdue.overdue === 0 || !data.stagingPauses) return null;
  const lastRead = data.stagingLastReadAt ? `last staging page read ${utc(data.stagingLastReadAt)}` : data.stagingLastReadAt === null ? "staging has never read a page" : "last staging read not measured";
  const late = `staging's crawler counts ${data.stagingOverdue.overdue} collab reads overdue past 24 h (target 0, ${data.stagingOverdue.due} due now), ${lastRead}`;
  const rows = data.stagingPauses.map(pause => `${pause.key}${pause.auditId === null ? " (no config_audit row)"
    : ` (audit ${pause.auditId}, ${utc(pause.at!)}, ${pause.actor === "metal-deploy" ? "LEFT BY A DEPLOY, " : ""}${pause.actor}: ${(pause.reason ?? "").slice(0, 90)})`}`);
  const excerpt = `${late}. ${rows.length ? `Staging pause rows on: ${rows.join("; ")}. A row a deploy or a stale job left on goes back to its prior value (c63, c72); a row with an owner's reason stays.` : "No staging pause row is 'true'."} `
    + "Then read the staging refusal reasons (ig_engage_read_log.reason, which grafana_ro cannot read), demand (engage_demand on /ops/watch-targets/health) and STAGING_CRAWLER_MODE.";
  return { at: data.now, kind: "staging_stall", excerpt: excerpt.slice(0, 1200) };
}

/**
 * The canary_oversize flag when the canary holds more than its ~10% of the prod accounts that read on the newest full day, a handOff so a met run
 * acts on it; null otherwise. fleet_ig_killed_pct leaves the canary out, so an oversize canary hides the fleet's deaths: on 11-18 every one of the
 * accounts that read was on engage.canary_accounts, Instagram suspended 23 of them from 23:13Z to 00:02Z, and the 11-19 run read 0%.
 */
export function canaryOversizeFlag(roster: ReadonlySet<number>, days: readonly DayPages[], day: string, at: number): FlaggedSlice | null {
  const readers = new Set(days.filter(row => row.day === day && row.pages > 0).map(row => row.accountId));
  const inCanary = [...readers].filter(id => roster.has(id)).length;
  const want = canaryWant(readers.size);
  if (inCanary <= want) return null;
  return { at, kind: "canary_oversize", handOff: true, sig: day, excerpt: (`the canary holds ${inCanary} of the ${readers.size} prod accounts that read on ${day} UTC, `
    + `and ~10% is ${want}, so fleet_ig_killed_pct leaves out ${inCanary - want} accounts that belong to the fleet. Cut engage.canary_accounts to ${want} of them.`).slice(0, 600) };
}

/** The precheck output from measured data. */
export function report(data: EngageData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const { now } = data;
  const at = now;
  const metrics: Record<string, number> = {};
  const lastEventAt: Record<string, number> = {};
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  if (data.stagingLastReadAt === null) flagged.push({ at, kind: "never_read", excerpt: "staging ig_engage_read_log has no read with pages > 0 at all" });
  if (data.stagingOverdue) metrics.staging_tagged_overdue_24h = data.stagingOverdue.overdue;
  const stagingStall = stagingStallFlag(data);
  if (stagingStall) flagged.push(stagingStall);
  if (data.accounts && data.config && data.deaths) {
    const active = data.accounts.filter(account => account.status === "active");
    const roster = canaryOf(data.config);
    const want = canaryWant(active.length);
    const have = active.filter(account => roster.ids.has(account.id)).length;
    metrics.canary_accounts_short = Math.max(0, want - have);
    const day = data.deaths.filter(death => now - death.at <= DAY);
    const killed = (deaths: readonly Death[]): number => new Set(deaths.filter(death => causeOf(death) === "instagram").map(death => death.accountId)).size;
    const fleetKilled = killed(day.filter(death => !roster.ids.has(death.accountId)));
    metrics.fleet_ig_killed_pct = active.length ? round1(100 * fleetKilled / active.length) : fleetKilled ? 100 : 0;
    const canaryDay = day.filter(death => roster.ids.has(death.accountId));
    metrics.canary_ig_deaths_1h = Math.max(0, ...canaryDay.map(start => killed(canaryDay.filter(death => death.at >= start.at && death.at - start.at < HOUR))));
    const lastDay = data.days?.reduce<string | null>((latest, row) => latest && latest > row.day ? latest : row.day, null) ?? null;
    const canaryPages = data.days?.filter(row => row.day === lastDay && roster.ids.has(row.accountId)).map(row => row.pages) ?? [];
    const pagesText = !data.days ? "their pages are not measured" : lastDay
      ? `they read ${fmt(canaryPages.reduce((sum, pages) => sum + pages, 0))} pages on ${lastDay}, the busiest ${fmt(Math.max(0, ...canaryPages))}` : "no prod account read a page on a full UTC day";
    const startAt = Date.parse((data.config["engage.canary_started_at"] ?? "").trim());
    const sinceStart = Number.isFinite(startAt) ? killed(data.deaths.filter(death => death.at >= startAt && roster.ids.has(death.accountId))) : 0;
    const stop = data.config["engage.canary_stop_deaths"]?.trim();
    flagged.push({ at, kind: metrics.canary_accounts_short ? "canary_short" : "canary", excerpt: (roster.empty
      ? `no canary runs: ${roster.empty}; 0 of ${active.length} active prod accounts are in it, and ~10% is ${want}`
      : `canary from engage.canary_accounts, started ${utc(startAt)}: ${have} of ${active.length} active prod accounts (${roster.ids.size} in it with the dead), ~10% is ${want}; ${pagesText}; `
        + `Instagram killed ${killed(canaryDay)} of them in 24 h, at most ${metrics.canary_ig_deaths_1h} in any 60 minutes, and ${sinceStart} since the start${stop ? ` (the canary stops at ${stop})` : ""}`)
      + (metrics.canary_accounts_short ? `: add ${metrics.canary_accounts_short} active accounts through ${CANARY_SHARE_KEY}` : "") });
    const oversize = data.days && lastDay ? canaryOversizeFlag(roster.ids, data.days, lastDay, at) : null;
    if (oversize) flagged.push(oversize);
    const reasonOf = (id: number): string => { const reason = data.accounts!.find(account => account.id === id)?.reason; return reason ? `; status_reason: ${reason}` : ""; };
    for (const death of day) flagged.push({ at: death.at, kind: "death",
      excerpt: `account ${death.accountId} went ${death.status} at ${utc(death.at)}, code ${death.code ?? "none"}, cause ${causeOf(death)}${roster.ids.has(death.accountId) ? ", canary" : ""}, ${fmt(death.pages24h)} pages in its last 24 h${death.readBefore ? "" : ", never read a page"}${reasonOf(death.accountId)}`.slice(0, 600) });
    const instagram = killed(day.filter(death => death.transition));
    if (data.deathGauge && Object.keys(data.deathGauge).length && (data.deathGauge.instagram ?? 0) !== instagram)
      flagged.push({ at, kind: "death_gauge", excerpt: `crawler_v3_engage_deaths_24h{cause="instagram"} reads ${data.deathGauge.instagram ?? "none"} while this precheck counts ${instagram}; the gauge sees the actor and from_status columns grafana_ro cannot, so trust the gauge and fix this precheck` });
    const pauses = Object.entries(data.config).filter(([key, value]) => key.startsWith("pause.engage") && value === "true").map(([key]) => key);
    if (pauses.length) flagged.push({ at, kind: "pause", excerpt: `prod pause keys on: ${pauses.join(", ")}` });
    if (data.days && data.healthy !== undefined && data.lapsed) {
      const { newestDays, newest: proof, best, massActions: actions } = provenRates(data.days, data.deaths, want, data.hours ? servedDays(data.days, data.hours, data.heldHours) : data.days, data.heldHours);
      const rate = proof?.rate ?? 0;
      const healthy = data.healthy;
      const counted = `${healthy} prod accounts that can read now (admissible: active, bound and passing egress admission)`;
      const waiting = data.lapsed.waiting ? ` ${data.lapsed.waiting} wait on a proxy, would add ${fmt(data.lapsed.waiting * rate)}.` : "";
      metrics.prod_capacity_pages_day = healthy * rate;
      const windowEnd = newestDays ? Date.parse(`${nextDay(newestDays.at(-1)!)}T00:00:00Z`) : undefined;
      if (windowEnd !== undefined) lastEventAt.prod_capacity_pages_day = windowEnd;
      metrics.best_proven_rate = best?.rate ?? 0;
      const onHand = onHandOf(data.accounts).length;
      const need = rate ? Math.ceil(PAGES_A_DAY_GOAL / rate) : null;
      const lag = windowEnd === undefined ? ""
        : windowEnd + CAPACITY_WINDOW_MS > at ? ` This reads the window ${newestDays!.join(" and ")}, and each day leaves it ${PROOF_DAYS} days after it ends: the newest window day leaves at ${utc(windowEnd + CAPACITY_WINDOW_MS)}.`
        : ` This reads the window ${newestDays!.join(" and ")}, the newest ${PROOF_DAYS} days in a row that a supply hold left at least ${PACED_HOURS_FLOOR} hours, and it stays until ${PROOF_DAYS} such days follow it.`;
      const older = best && best !== proof ? ` The best older window, ${best.days.join(" and ")}, proved ${fmt(best.rate)} (run detail only, not the headline).` : "";
      const action = actions.at(-1);
      const mass = action ? ` Left out as a mass action, not a rate: ${action.length} Instagram verdicts from ${utc(action[0]!.at)} to ${utc(action.at(-1)!.at)} and their accounts' days.` : "";
      flagged.push({ at, kind: "capacity", excerpt: (proof
        ? `${counted} x ${fmt(rate)} pages a day per account, proven on the newest window ${proof.days.join(" and ")} (the ${want}th account could serve that much each day, at its median pages in hours its pace was full times its serveable hours; since then ${proof.hiDeaths} Instagram verdicts in ${fmt(proof.hiDays)} account-days at or over it and ${proof.loDeaths} in ${fmt(proof.loDays)} under it, p ${proof.p.toFixed(2)}) = ${fmt(healthy * rate)} pages a day.${waiting} `
          + `${need! > healthy ? `${need! - healthy} more accounts that can read at that rate, or ${fmt(Math.ceil(PAGES_A_DAY_GOAL / Math.max(1, healthy)))} pages a day on these, reach ${fmt(PAGES_A_DAY_GOAL)}. ` : ""}`
          + `${onHand} prod accounts on hand (not dead, not moved to another world, not parked on a refused password) x ${fmt(rate)} = ${fmt(onHand * rate)}${onHand * rate < PAGES_A_DAY_GOAL ? `, short of ${fmt(PAGES_A_DAY_GOAL)}` : ", enough once they can read"}.${mass}${lag}${older}`
        : `${counted}, and the newest window ${newestDays ? newestDays.join(" and ") : "(none)"} proves no rate: it had no ${want} accounts read at one rate whose readers did not die more often than the rest.${mass}${lag}${older}`).slice(0, 1200) });
    }
    if (data.lapsed && (data.lapsed.waiting || data.lapsed.blocked)) flagged.push({ at, kind: "lapsed_bindings", excerpt: (`${data.lapsed.waiting + data.lapsed.blocked} active prod accounts have no live proxy session binding, the oldest since ${utc(data.lapsed.oldestAt!)}. `
      + `${data.lapsed.waiting} wait on the renewal loop and are left out of capacity until they read again once the proxy answers (a GeoNode supply hold or neutral_address_unresolved renewals point at the proxy). `
      + (data.lapsed.blocked ? `${data.lapsed.blocked} have a blocked renewal row that nothing retries and are left out of capacity: clear them through the shipped rotation path.` : "")).slice(0, 600) });
  }
  if (data.deepWalks) {
    const pagination = (codes: Record<string, number>): [string, number][] => Object.entries(codes).filter(([code]) => !NOT_PAGINATION.has(code));
    const sum = (entries: [string, number][]): number => entries.reduce((total, [, count]) => total + count, 0);
    const list = (entries: [string, number][]): string => entries.map(([code, count]) => `${code} ${count}`).join(", ");
    const stops = pagination(data.deepWalks.errors);
    const stuck = pagination(data.deepWalks.stuck);
    const left = [...Object.entries(data.deepWalks.errors), ...Object.entries(data.deepWalks.stuck)].filter(([code]) => NOT_PAGINATION.has(code));
    const retrying = Object.entries(data.deepWalks.retrying);
    const errorStops = sum(stops);
    const total = data.deepWalks.reached + errorStops + sum(stuck);
    metrics.deep_walk_ok_pct = total ? round1(100 * data.deepWalks.reached / total) : 100;
    metrics.deep_walks_open_stuck = sum(stuck);
    flagged.push({ at, kind: "deep_walks", excerpt: (`365-day logged-in collab walks in the last 24 h: ${fmt(data.deepWalks.reached)} reached their end, ${errorStops} stopped on an error${errorStops ? ` (${list(stops)})` : ""}; `
      + `${sum(stuck)} open walks are stuck, their last chunk ended on an error and they started more than one cadence ago${stuck.length ? ` (${list(stuck)})` : ""}; `
      + `profile_not_found and fleet_exhausted are not pagination errors and are left out${left.length ? ` (${list(left)})` : ""}`
      + (retrying.length ? `; ${sum(retrying)} open walks inside their first cadence are retrying after an error: ${list(retrying)}` : "")).slice(0, 900) });
  }
  if (data.stuck) {
    metrics.engage_accounts_stuck = data.stuck.length;
    const words: Record<StuckKind, string> = { frozen_shared_exit: "frozen for a shared exit IP, not healed", active_302s: `active, reading only 302s (${STUCK_302S} or more, no page)`, parked_dead_jar: "parked with an invalid jar, not re-logged" };
    const fixes: Record<StuckKind, string> = { frozen_shared_exit: "the exit_shared heal (p103)", active_302s: "the jar 302 park (p105)", parked_dead_jar: "the re-login worker (p105)" };
    const kinds = [...new Set(data.stuck.map(account => account.kind))];
    if (kinds.length) flagged.push({ at, kind: "stuck_accounts", excerpt: (`${data.stuck.length} prod accounts stuck over ${STUCK_HOURS} h: `
      + kinds.map(kind => `${words[kind]}: ${data.stuck!.filter(account => account.kind === kind).map(account => `${account.accountId} since ${utc(account.since)}`).join(", ")}, fixed in ${fixes[kind]}`).join("; ")
      + ". Ship the fix in that code path; a hand thaw or activation is a hand fix d3 counts (F5).").slice(0, 900) });
  }
  if (data.paced) {
    metrics.paced_accts_200plus = data.paced.accounts;
    metrics.paced_serveable_hours = data.paced.hours;
    if (data.paced.share !== null) metrics.paced_busy_hour_share = data.paced.share;
    const flag = busyHourFlag(data.paced, at);
    if (flag) flagged.push(flag);
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
  return { metrics, flagged, ...Object.keys(lastEventAt).length ? { lastEventAt, windowMs: { prod_capacity_pages_day: CAPACITY_WINDOW_MS } } : {} };
}

const DEAD_SQL = `('${DEAD.join("', '")}')`;
export const DAYS_SQL = `select to_char(l.at at time zone 'UTC', 'YYYY-MM-DD') as day, l.account_id, sum(l.pages) as pages
from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id
where a.world = 'prod' and l.at < date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' group by 1, 2 having sum(l.pages) > 0`;
/** HOURS_SQL's rows per account and UTC hour over the PROOF_DAYS full UTC days before today, the newest window servedDays() reads; pacedOf() scores its last day. */
export const HOURS_SQL = `select to_char(l.at at time zone 'UTC', 'YYYY-MM-DD') as day, extract(hour from l.at at time zone 'UTC')::int as hour, l.account_id,
  sum(l.pages) as pages, count(*) filter (where l.reason = 'account_busy') as busy, count(*) filter (where l.reason = 'transport') as transport,
  count(*) filter (where l.dispatched is distinct from false) as sends
from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id
where a.world = 'prod' and l.at >= (date_trunc('day', now() at time zone 'UTC') - interval '${PROOF_DAYS} days') at time zone 'UTC'
  and l.at < date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' group by 1, 2, 3`;
/**
 * The supply holds on the residential pool the engage exits ride (every prod engage endpoint read on 11-08 and 11-09 was a residential
 * engage-session row): a series per held proxy account, 1 while the hold lives. crawler_v3_proxy_supply_hold names the proxy account and not the
 * gateway, so a hold counts against every engage account. Each point is the hour that ends at its timestamp.
 */
export const SUPPLY_HOLD_EXPR = 'max(max_over_time(crawler_v3_proxy_supply_hold{pool="residential"}[1h]))';
/** The "YYYY-MM-DD H" hours of supply hold points, each point the hour that ends at its timestamp. */
export const heldHoursOf = (points: readonly [number, number][]): Set<string> => new Set(points.filter(([, value]) => value > 0).map(([at]) => {
  const start = new Date(at - HOUR);
  return `${start.toISOString().slice(0, 10)} ${start.getUTCHours()}`;
}));
const STAGING_SQL = `select extract(epoch from max(l.at)) * 1000 as last_read_at from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id
where a.world = 'staging' and l.pages > 0`;
/** A deploy rewrites each pause row it closes with the same value (pause.meta_ads audit 14478 and 14481 on 2026-10-21 wrote 'true' over 'true'), so the writer named is the last one that changed the value. */
const STAGING_PAUSES_SQL = `select c.key, w.id, extract(epoch from w.ts) * 1000 as at, w.actor, left(w.reason, 160) as reason from config c
left join lateral (select id, ts, actor, reason from config_audit a where a.key = c.key and a.old_value is distinct from a.new_value order by a.id desc limit 1) w on true
where c.key like 'pause.%' and c.value = 'true' order by c.key`;
const ACCOUNTS_SQL = "select id, status, status_reason as reason from ig_engage_accounts where world = 'prod' order by id";
export const DEATHS_SQL = `select e.account_id, extract(epoch from e.at) * 1000 as at, e.outcome, e.error_code, e.transition,
  exists (select 1 from ig_engage_read_log l where l.account_id = e.account_id and l.pages > 0 and l.at < e.at) as read_before,
  (select coalesce(sum(l.pages), 0) from ig_engage_read_log l where l.account_id = e.account_id and l.at <= e.at and l.at > e.at - interval '24 hours') as pages_24h
from ig_engage_account_events e join ig_engage_accounts a on a.id = e.account_id where a.world = 'prod' and (e.outcome in ${DEAD_SQL} or (e.outcome = 'active' and e.transition)) order by e.at, e.id`;
/** The lapsed session bindings, as lapsedOf parses them; the 60 s is READ_PAGE_TIMEOUT_SECONDS, the margin the egress admission keeps. */
export const LAPSED_SQL = `select count(*) filter (where r.status is distinct from 'blocked') as waiting, count(*) filter (where r.status = 'blocked') as blocked,
  coalesce(round(extract(epoch from min(b.expires_at)) * 1000), 0) as oldest_ms
from ig_engage_accounts a join ig_engage_session_bindings b on b.account_id = a.id and b.credential_generation = a.credential_generation
left join ig_engage_session_renewals r on r.account_id = a.id
where a.world = 'prod' and a.status = 'active' and b.expires_at <= now() + interval '60 seconds';`;

export function lapsedOf(tsv: string): Lapsed {
  const [waiting, blocked, oldest, ...rest] = tsv.trim().split("\t").map(Number);
  if (waiting === undefined || blocked === undefined || oldest === undefined || rest.length || ![waiting, blocked, oldest].every(Number.isFinite))
    throw new Error(`lapsed bindings: unexpected answer ${tsv.slice(0, 80)}`);
  return { waiting, blocked, oldestAt: waiting + blocked ? oldest : null };
}

const CONFIG_SQL = "select key, value from config where key like 'engage.canary%' or key like 'pause.engage%'";
/**
 * The deep collab walks on prod: watch_targets kind tagged (the logged-in usertags route) at depth 365. A walk done in the duty's 24 h window
 * is reached when it ended since or exhausted, and an error stop under its walk_end otherwise. An open walk whose last chunk errored is
 * stuck when it started (walk_since plus depth_days, as walk_since is the first deep claim minus depth_days) more than one cadence ago, at
 * any last run time, and retrying when it started inside one cadence and its last chunk ran in the window. The cadence is _interval in
 * apps/crawler-v3/src/watch_targets/cadence.py: cadence_days, else daily for a monitor row or a row active within 30 days, else weekly.
 * An open walk's walk_end is no end ('since' there marks the 30-day first pass), so it goes under last_error_code. On 10-17, 18 open
 * walks that kept reading counted as stops named "since", which hid their code permanent_error. A done walk whose target the crawler settled
 * gone counts under profile_not_found, whatever its walk_end: on 11-24 prod myfipn_official and teeheehee_official ended walk_end hidden
 * with last_outcome gone and last_error_code profile_not_found, and read as 2 pagination stops (deep_walk_ok_pct 88.9 for 16 reached).
 */
export const DEEP_WALKS_SQL = `with walks as (
  select walk_done_at, walk_end, walk_since, last_error_code, last_outcome, last_run_at,
    walk_done_at is null and walk_since + make_interval(days => depth_days) < now() - make_interval(days => coalesce(cadence_days,
    case when tier = 'monitor' or coalesce(last_activity_at, created_at) > now() - interval '30 days' then 1 else 7 end)) as past_cadence
  from watch_targets where platform = 'instagram' and kind = 'tagged' and depth_days >= 365
)
select case when walk_done_at is null then case when past_cadence then 'stuck' else 'retrying' end
    when walk_end in ('since', 'exhausted') then 'reached' else 'error' end as state,
  case when walk_done_at is null then coalesce(last_error_code, 'error') when walk_end in ('since', 'exhausted') then ''
    when last_outcome = 'gone' then 'profile_not_found' else coalesce(nullif(walk_end, ''), 'error') end as code,
  count(*) as walks
from walks
where walk_done_at > now() - interval '24 hours'
  or (walk_done_at is null and walk_since is not null and last_outcome = 'error' and (past_cadence or last_run_at > now() - interval '24 hours'))
group by 1, 2;`;

/**
 * A re-login worker's terminal verdict on `v`, an ig_engage_account_events row: `stop()` in apps/crawler-v3/src/platforms/instagram/engage/relogin.py
 * writes it as a non-transition login event with outcome challenged and a relogin_ code, and stops the jar (STOPPED_JAR in relogin_codes.py), so the
 * worker never takes that account again. grafana_ro cannot read the jar's invalid_reason, so the event stands in for it. Such an account is a death
 * that DEATHS_SQL counts with its CODE_CAUSES cause, not a stuck one: until 10-29 prod 24 and 163 read as both.
 */
export const RELOGIN_VERDICT_SQL = "v.kind = 'login' and not v.transition and v.outcome = 'challenged' and starts_with(v.error_code, 'relogin_')";

/**
 * The stuck prod accounts, as stuckOf parses them: kind, account and since, then a redirect's reason, Location and count. A freeze for a shared exit is SHARED_EXIT_FREEZE in
 * apps/crawler-v3/src/platforms/instagram/engage/shared_exit_freeze.py, read on the account's last status change. A parked account with a dead jar is
 * stuck unless the re-login worker gave a terminal verdict (RELOGIN_VERDICT_SQL) after its last status change.
 */
export const STUCK_SQL = `with last_change as (
  select distinct on (e.account_id) e.account_id, e.id, e.at, e.outcome, e.error_code from ig_engage_account_events e
  join ig_engage_accounts a on a.id = e.account_id where a.world = 'prod' and e.transition order by e.account_id, e.id desc
)
select 'frozen_shared_exit' as kind, a.id, round(extract(epoch from e.at) * 1000) as since, '' as reason, '' as location, 0 as redirects from ig_engage_accounts a join last_change e on e.account_id = a.id
where a.world = 'prod' and a.status = 'frozen' and e.outcome = 'frozen' and e.at < now() - interval '${STUCK_HOURS} hours' and (
  e.error_code = 'exit_shared' or (coalesce(e.error_code, '') = '' and exists (
    select 1 from ig_engage_session_bindings fb where fb.account_id = e.account_id and fb.started_at <= e.at and fb.expires_at > e.at and (
      exists (select 1 from ig_engage_session_bindings pb where pb.account_id <> fb.account_id and pb.egress_ip = fb.egress_ip and pb.started_at <= e.at and pb.expires_at > e.at)
      or exists (select 1 from ig_engage_accounts pa where pa.id <> fb.account_id and pa.original_egress_ip = fb.egress_ip)))))
union all
select 'active_redirects', a.id, round(extract(epoch from min(l.at)) * 1000), coalesce(l.reason, ''), coalesce(l.response_headers->>'location', ''), count(*)
from ig_engage_accounts a join ig_engage_read_log l on l.account_id = a.id
where a.world = 'prod' and a.status = 'active' and l.at > now() - interval '${STUCK_HOURS} hours' and l.http_status between 300 and 399
  and not exists (select 1 from ig_engage_read_log p where p.account_id = a.id and p.at > now() - interval '${STUCK_HOURS} hours' and p.pages > 0)
group by a.id, 4, 5
union all
select 'parked_dead_jar', a.id, round(extract(epoch from e.at) * 1000), '', '', 0 from ig_engage_accounts a join last_change e on e.account_id = a.id
join ig_engage_browser_jars j on j.account_id = a.id
where a.world = 'prod' and a.status = 'parked' and not j.valid and e.at < now() - interval '${STUCK_HOURS} hours'
  and not exists (select 1 from ig_engage_account_events v where v.account_id = a.id and v.id > e.id and ${RELOGIN_VERDICT_SQL});`;

const STUCK_KINDS: ReadonlySet<string> = new Set<StuckKind>(["frozen_shared_exit", "parked_dead_jar"]);
/** The redirect paths that mean a lost session, as _LOGIN_REDIRECT_PATHS in apps/crawler-v3/src/platforms/instagram/engage/classify.py. */
export const LOST_SESSION_PATHS = ["/accounts/login", "/challenge/"] as const;
/** The read log codes classify.verdict gives a redirect to the login page or a challenge. */
const LOST_SESSION_CODES: ReadonlySet<string> = new Set(["login_redirect", "jar_login_redirect"]);
/**
 * Whether a logged-in read's redirect means its session is gone, as classify.verdict reads it: a login or challenge code, no Location (the
 * dead session of accounts 16, 55 and 74 on 10-14), or a Location under the login or challenge paths. Any other Location is about the page.
 * On 10-22 the story route answered 42 reads on 18 prod accounts with /stories/instagram/?r=1, 9 of those accounts served pages after it,
 * and that redirect alone made account 201 read as stuck.
 */
export function lostSession(reason: string, location: string): boolean {
  if (LOST_SESSION_CODES.has(reason.split(" ").at(-1) ?? "")) return true;
  if (!location) return true;
  const path = URL.parse(location, "https://www.instagram.com")?.pathname ?? location;
  return LOST_SESSION_PATHS.some(prefix => path.startsWith(prefix));
}
export function stuckOf(tsv: string): StuckAccount[] {
  const stuck: StuckAccount[] = [];
  const redirects = new Map<number, { count: number; since: number }>();
  for (const line of tsv.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    const [kind = "", id, since, reason = "", location = "", count = ""] = fields;
    const redirect = kind === "active_redirects" && Number(count) > 0;
    if (fields.length !== 6 || !(redirect || STUCK_KINDS.has(kind)) || !Number.isInteger(Number(id)) || !Number.isFinite(Number(since)) || !Number.isInteger(Number(count))) throw new Error(`stuck accounts: unexpected line ${line.slice(0, 80)}`);
    if (!redirect) { stuck.push({ kind: kind as StuckKind, accountId: Number(id), since: Number(since) }); continue; }
    if (!lostSession(reason, location)) continue;
    const seen = redirects.get(Number(id)) ?? { count: 0, since: Number(since) };
    redirects.set(Number(id), { count: seen.count + Number(count), since: Math.min(seen.since, Number(since)) });
  }
  for (const [accountId, { count, since }] of redirects) if (count >= STUCK_302S) stuck.push({ kind: "active_302s", accountId, since });
  return stuck;
}

/** Staging's watch health route, which the crawler's own CRAWLER_API_KEY of apps/crawler-v3/.env.staging reads. */
export const STAGING_WATCH_HEALTH = "https://staging-crawler.virev.ai/ops/watch-targets/health";

export function stagingOverdueOf(body: unknown): StagingOverdue {
  const data = (body as { data?: { overdue_24h?: { tagged?: unknown }; due_now?: { tagged?: unknown } } } | null)?.data;
  const overdue = num(data?.overdue_24h?.tagged), due = num(data?.due_now?.tagged);
  if (overdue === null || due === null || !Number.isFinite(overdue) || !Number.isFinite(due)) throw new Error(`staging watch health: unexpected answer ${JSON.stringify(body).slice(0, 80)}`);
  return { overdue, due };
}

/** Goal p229's target: the median paced account's busiest hour holds at most this share of its day's sends. */
export const BUSY_HOUR_SHARE_MAX = 0.1;
/**
 * The fewest serveable backlog hours a day needs before pacedOf() scores it. Fewer than 1 / BUSY_HOUR_SHARE_MAX hours cannot meet the target at
 * any pace, and a short day reads its normal pace as a miss: on 11-09 the GeoNode hold left 8 hours, and its 19 accounts read 0.153 of their day in
 * the busiest hour at 1.22 times their mean hour, which 11-08 matched at 1.40 over 23 hours (0.061).
 * measured: prod 10-15 to 11-08, every day had 18 to 24 backlog hours; the 11-09 hold left 8.
 */
export const PACED_HOURS_FLOOR = 18;
/**
 * The last full UTC day's paced score from its HOURS_SQL rows, after the 'paced' row of p98-paced-grafana.sql (job g2g accounts setup 10-20): over
 * the backlog hours, the hours with an account_busy refusal, each account's busiest hour over its day's sends, and the median of that over the
 * accounts with 200 or more sends. It counts the hours servedDays() counts: an hour a supply hold covered (`held`) is no backlog hour, and an
 * account-hour that read no page while a read failed on transport is left out. `share` is null when no account sent 200 or the day had fewer than
 * PACED_HOURS_FLOOR backlog hours.
 */
export interface Paced { day: string; share: number | null; accounts: number; hours: number }
export function pacedOf(hours: readonly AccountHour[], day: string, held: ReadonlySet<string>): Paced {
  const live = hours.filter(cell => cell.day === day && !held.has(`${day} ${cell.hour}`) && !(cell.pages === 0 && cell.transport > 0));
  const backlog = new Set(live.filter(cell => cell.busy > 0).map(cell => cell.hour));
  const accounts = new Map<number, { sends: number; top: number }>();
  for (const cell of live) {
    if (!(cell.busy > 0 || (cell.sends > 0 && backlog.has(cell.hour)))) continue;
    const account = accounts.get(cell.accountId) ?? { sends: 0, top: 0 };
    accounts.set(cell.accountId, { sends: account.sends + cell.sends, top: Math.max(account.top, cell.sends) });
  }
  const shares = [...accounts.values()].filter(account => account.sends >= 200).map(account => account.top / account.sends);
  const share = shares.length && backlog.size >= PACED_HOURS_FLOOR ? Math.round(median(shares) * 1000) / 1000 : null;
  return { day, share, accounts: shares.length, hours: backlog.size };
}

/** The busy_hour_share flag when the day's paced share is over BUSY_HOUR_SHARE_MAX, a handOff so a met run acts on it; null otherwise. */
export function busyHourFlag(paced: Paced, at: number): FlaggedSlice | null {
  if (paced.share === null || paced.share <= BUSY_HOUR_SHARE_MAX) return null;
  return { at, kind: "busy_hour_share", handOff: true, sig: paced.day, excerpt: (`paced_busy_hour_share ${paced.share} on ${paced.day} UTC (target at most ${BUSY_HOUR_SHARE_MAX}, closed goal p229): `
    + `over the ${paced.hours} serveable hours with account_busy refusals, the median of the ${paced.accounts} prod accounts with 200+ sends (paced_accts_200plus) read ${Math.round(paced.share * 1000) / 10}% of its day in its busiest hour. `
    + "Put a d1/paced_busy_hour_share fix step under p168 with a live job, as for a missed metric.").slice(0, 600) };
}

export const daysOf = (rows: Record<string, unknown>[]): DayPages[] => rows.map(row => ({ day: String(row.day), accountId: Number(row.account_id), pages: Number(row.pages) }));
export const hoursOf = (rows: Record<string, unknown>[]): AccountHour[] => rows.map(row => ({ day: String(row.day), hour: Number(row.hour), accountId: Number(row.account_id), pages: Number(row.pages), busy: Number(row.busy), transport: Number(row.transport ?? 0), sends: Number(row.sends) }));
export const accountsOf = (rows: Record<string, unknown>[]): Account[] => rows.map(row => ({ id: Number(row.id), status: String(row.status), ...(row.reason ? { reason: String(row.reason) } : {}) }));
export const stagingPausesOf = (rows: Record<string, unknown>[]): StagingPause[] => rows.map(row => ({
  key: String(row.key), auditId: num(row.id), at: num(row.at), actor: row.actor == null ? null : String(row.actor), reason: row.reason == null ? null : String(row.reason),
}));
/**
 * The deaths from DEATHS_SQL rows, each account's Instagram death once: a dead-status row after an Instagram verdict on the same account, with no
 * move back to active between them, is the same death written again and is left out. Prod 163 went relogin_gone on 10-28 09:53Z and was disabled
 * with that code on 10-29 05:04Z after its profile read "does not exist", and until 10-30 d1 counted that one death in the 24 h windows after both.
 */
export const deathsOf = (rows: Record<string, unknown>[]): Death[] => {
  const killed = new Set<number>();
  const deaths: Death[] = [];
  for (const row of rows) {
    const accountId = Number(row.account_id);
    if (row.outcome === "active") { killed.delete(accountId); continue; }
    if (killed.has(accountId)) continue;
    const death: Death = { accountId, at: Number(row.at), status: String(row.outcome), code: row.error_code == null ? null : String(row.error_code),
      readBefore: row.read_before === true, pages24h: Number(row.pages_24h ?? 0), transition: row.transition === true };
    if (causeOf(death) === "instagram" || causeOf(death) === "found_idle") killed.add(accountId);
    deaths.push(death);
  }
  return deaths;
};
export function deepWalksOf(tsv: string): DeepWalks {
  const walks: DeepWalks = { reached: 0, errors: {}, stuck: {}, retrying: {} };
  for (const line of tsv.split("\n").filter(Boolean)) {
    const [kind, code, count] = line.split("\t");
    if (kind === "reached") walks.reached += Number(count);
    else if (kind === "error" || kind === "stuck" || kind === "retrying") walks[kind === "error" ? "errors" : kind][code || "error"] = Number(count);
    else throw new Error(`deep walks: unexpected line ${line.slice(0, 80)}`);
  }
  return walks;
}

export async function measure(query: DsQuery | null, authError: string | null, now: number, prodRead: ProdRead): Promise<EngageData> {
  const data: EngageData = { now, errors: [] };
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  // step never rejects, so a failed prod read does not stop the others.
  const deepWalks = step("prod deep walks", async () => deepWalksOf(await prodRead(DEEP_WALKS_SQL)));
  const lapsedBindings = step("prod lapsed bindings", async () => lapsedOf(await prodRead(LAPSED_SQL)));
  const stuckAccounts = step("prod stuck accounts", async () => stuckOf(await prodRead(STUCK_SQL)));
  const stagingOverdue = step("staging watch health", async () => {
    const response = await fetch(STAGING_WATCH_HEALTH, { headers: { "x-api-key": await readCrawlerKey("apps/crawler-v3/.env.staging") }, signal: AbortSignal.timeout(SOURCE_DEADLINE_MS) });
    if (!response.ok) throw new Error(`staging watch health: HTTP ${response.status}`);
    return stagingOverdueOf(await response.json());
  });
  if (!query) {
    data.errors.push({ source: "grafana auth", message: authError ?? "no Grafana login" });
    for (const source of ["prod read log", "prod supply holds", "staging read log", "staging config", "prod accounts", "prod config", "prod healthy gauge"] as const) data.errors.push({ source, message: "not read: no Grafana login" });
    const [walks, lapsed, stuck, due] = await Promise.all([deepWalks, lapsedBindings, stuckAccounts, stagingOverdue]);
    if (walks) data.deepWalks = walks;
    if (due) data.stagingOverdue = due;
    if (stuck) data.stuck = stuck;
    if (lapsed) data.lapsed = lapsed;
    return data;
  }
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const daysRead = step("prod read log", async () => daysOf(await sqlRows(query, PG.prod, DAYS_SQL)));
  // The holds cover every day provenRates() may prove on, from the read log's first day.
  const firstDay = daysRead.then(rows => rows?.map(row => row.day).sort()[0]);
  const [days, hours, heldHours, staging, stagingPauses, accounts, deaths, config, healthy, gauge, walks, due, lapsed, stuck] = await Promise.all([
    daysRead,
    step("prod read log", async () => hoursOf(await sqlRows(query, PG.prod, HOURS_SQL))),
    step("prod supply holds", async () => {
      const first = await firstDay;
      const from = first ? Date.parse(`${first}T00:00:00Z`) : today - PROOF_DAYS * DAY;
      return heldHoursOf((await promRange(query, PROM.prod, SUPPLY_HOLD_EXPR, from + HOUR, today, HOUR)).flatMap(series => series.points));
    }),
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
    stagingOverdue,
    lapsedBindings,
    stuckAccounts,
  ]);
  Object.assign(data, days && { days }, hours && { hours }, heldHours && { heldHours }, staging !== undefined && { stagingLastReadAt: staging }, stagingPauses && { stagingPauses }, accounts && { accounts }, deaths && { deaths }, config && { config },
    healthy !== undefined && { healthy }, lapsed && { lapsed }, gauge && { deathGauge: gauge }, walks && { deepWalks: walks }, due && { stagingOverdue: due }, stuck && { stuck },
    hours && heldHours && { paced: pacedOf(hours, new Date(today - DAY).toISOString().slice(0, 10), heldHours) });
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
  const prodRead: ProdRead = query ? prodReader(query) : async () => { throw new Error("not read: no Grafana login"); };
  const result = report(await measure(query, authError, now, prodRead), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`engage-reads: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
