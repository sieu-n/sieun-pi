import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  type DsQuery, DAY, HOUR, MINUTE, PG, PROM, SOURCE_DEADLINE_MS, grafanaClient, num, promInstant, readGrafanaAuth, round1, settle, sqlRows,
  unmeasuredFlag, utc,
} from "./estate-reads.ts";

/**
 * The Engage reads scale safely duty's precheck for launch main bro (`node --import tsx scripts/duties/engage-reads.ts`). Code only, no model
 * call, reads only. It measures goal p1 (logged-in Instagram engage reads at 100k pages a day without accounts dying) and the owner's standing
 * canary rule (about 10% of accounts always run as a canary) from:
 * - estate_pg_prod and estate_pg_stg through Grafana (grafana_ro): ig_engage_read_log, ig_engage_accounts, ig_engage_account_events and the
 *   config keys engage.rate_test_arms, engage.rate_test_started_at and pause.engage*;
 * - estate_prometheus: crawler_v3_engage_deaths_24h{cause}, only to cross-check the death count once land 32b ships that gauge.
 * grafana_ro cannot read the actor, transition and from_status columns of ig_engage_account_events, so a death here is an account whose status
 * is dead now with last_error_at in the window, and its cause is the latest dead-outcome event's error_code through CODE_CAUSES below.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "engage-reads.duty.json");

/*
 * Targets in engage-reads.duty.json and their sources:
 * - prod_pages_24h >= 100000: the owner, 10-09, "read 100k pages/day".
 * - prod_pages_1h >= 4167: 100000 / 24 rounded up, the hourly pace of the same 100k a day.
 * - prod_last_read_min and staging_last_read_min <= 60: the duty runs every 60 min, so an older last read means nothing read since the last run.
 * - prod_reading_pct >= 90: every active account reads except the ~10% canary the owner named on 10-12, whose arm may be stopped
 *   (apps/crawler-v3/src/fleet/rate_test.py: a stopped arm reads nothing).
 * - fleet_ig_deaths_24h <= 0: the owner, 10-09, "without accounts dieing".
 * - canary_ig_deaths_1h <= 3: the chat's own canary stop rule (10-12 13:3xZ), "stop if more than 3 accounts die or challenge within any hour".
 * - canary_accounts_short <= 0: the owner, 10-12 13:33Z, "ALWAYS RUN ~10% account as CANARY"; CANARY_SHARE below.
 * - source_errors <= 0: a source that failed is reported, never shown as green.
 * The schedule, every 60 min, follows the hourly stop rule above and the owner's "PUSH HARD" (10-12 13:31Z).
 * The duty's timeoutMs 120000 is the runner's own cap, PRECHECK_TIMEOUT_MS in src/shared/chat-duties.ts; the 2026-10-12 14:13Z run took 2.0 s.
 */

/** The owner's "~10%" (10-12 13:33Z): the canary is this share of active prod accounts, rounded to the nearest whole account. */
export const CANARY_SHARE = 0.1;
/** Dead statuses, as `_DEAD_STATUSES` in apps/crawler-v3/src/control/metrics/health.py. */
export const DEAD = ["challenged", "frozen", "disabled"] as const;
export type Cause = "instagram" | "first_login" | "bad_password" | "ours" | "unknown";
/** A copy of CODE_CAUSES in apps/crawler-v3/src/control/metrics/engage_deaths.py (sieun/dev, 2026-10-12). */
export const CODE_CAUSES: Readonly<Record<string, Cause>> = {
  account_suspended: "instagram", action_blocked: "instagram", challenge: "instagram", challenge_required: "instagram", challenged: "instagram",
  sentry_block: "instagram", suspended_on_first_contact: "instagram",
  bad_password: "bad_password",
  budget_meter_failed: "ours", exit_pinned: "ours", exit_unusable: "ours", geo_blocked: "ours", proxy_blocked: "ours", transport: "ours",
};
/** The data each metric reads; a metric whose source failed is not measured. */
export const NEEDS: Readonly<Record<string, readonly Source[]>> = {
  prod_pages_24h: ["prod read log"], prod_pages_1h: ["prod read log"], prod_last_read_min: ["prod read log"],
  staging_last_read_min: ["staging read log"],
  prod_reading_pct: ["prod accounts"],
  fleet_ig_deaths_24h: ["prod accounts", "prod config"], canary_ig_deaths_1h: ["prod accounts", "prod config"],
  canary_accounts_short: ["prod accounts", "prod config"],
};
export type Source = "grafana auth" | "prod read log" | "staging read log" | "prod accounts" | "prod config" | "prod death gauge";

export interface ReadLog { pages24h: number; pages1h: number; lastReadAt: number | null }
export interface Account { id: number; status: string; reason?: string; diedAt: number | null; deathCode: string | null; evented: boolean; readBefore: boolean; read24h: boolean }
export interface EngageData {
  now: number;
  prod?: ReadLog; staging?: ReadLog; accounts?: Account[]; config?: Record<string, string>;
  /** crawler_v3_engage_deaths_24h by cause; empty until land 32b ships the gauge. */
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
export function causeOf(account: Pick<Account, "deathCode" | "evented" | "readBefore">): Cause {
  if (!account.evented) return "unknown";
  const cause = CODE_CAUSES[account.deathCode ?? ""];
  if (!cause) return "unknown";
  return cause === "instagram" && !account.readBefore ? "first_login" : cause;
}

/** Accounts dead now whose death time is inside the last `windowMs`. */
export const deathsWithin = (accounts: readonly Account[], now: number, windowMs: number): Account[] =>
  accounts.filter(account => (DEAD as readonly string[]).includes(account.status) && account.diedAt !== null && now - account.diedAt <= windowMs);

const minutesSince = (now: number, at: number | null): number | null => at === null ? null : round1((now - at) / MINUTE);

/** The precheck output from measured data. */
export function report(data: EngageData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const { now } = data;
  const at = now;
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = data.errors.map(error => ({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 400) }));
  const failed = new Set(data.errors.map(error => error.source));
  if (data.prod) {
    metrics.prod_pages_24h = data.prod.pages24h;
    metrics.prod_pages_1h = data.prod.pages1h;
    const age = minutesSince(now, data.prod.lastReadAt);
    if (age === null) flagged.push({ at, kind: "never_read", excerpt: "prod ig_engage_read_log has no read with pages > 0 at all" });
    else metrics.prod_last_read_min = age;
    if (data.prod.lastReadAt !== null && now - data.prod.lastReadAt > HOUR) flagged.push({ at, kind: "prod_stopped", excerpt: `prod read ${data.prod.pages24h} pages in 24 h and ${data.prod.pages1h} in the last hour; its last page read was at ${utc(data.prod.lastReadAt)}` });
  }
  if (data.staging) {
    const age = minutesSince(now, data.staging.lastReadAt);
    if (age === null) flagged.push({ at, kind: "never_read", excerpt: "staging ig_engage_read_log has no read with pages > 0 at all" });
    else metrics.staging_last_read_min = age;
  }
  const unmeasured = new Set(Object.keys(NEEDS).filter(key => NEEDS[key]!.some(source => failed.has(source))));
  if (data.accounts) {
    const active = data.accounts.filter(account => account.status === "active");
    const reading = active.filter(account => account.read24h);
    metrics.prod_reading_pct = active.length ? round1(100 * reading.length / active.length) : 0;
    const idle = active.filter(account => !account.read24h).map(account => account.id);
    if (idle.length) flagged.push({ at, kind: "idle_accounts", excerpt: `${idle.length} of ${active.length} active prod accounts read no page in 24 h: ids ${idle.join(", ")}` });
    if (data.config) {
      const roster = canaryRoster(data.config, now);
      const inCanary = (account: Account): boolean => roster.ids.has(account.id);
      const day = deathsWithin(data.accounts, now, DAY);
      metrics.fleet_ig_deaths_24h = day.filter(account => !inCanary(account) && causeOf(account) === "instagram").length;
      metrics.canary_ig_deaths_1h = deathsWithin(data.accounts, now, HOUR).filter(account => inCanary(account) && causeOf(account) === "instagram").length;
      const want = Math.round(CANARY_SHARE * active.length);
      const have = active.filter(inCanary).length;
      metrics.canary_accounts_short = Math.max(0, want - have);
      flagged.push({ at, kind: "canary", excerpt: `${roster.note}; ${have} of ${active.length} active prod accounts are in it, and ~10% is ${want}` });
      for (const account of day) flagged.push({ at: account.diedAt ?? at, kind: "death",
        excerpt: `account ${account.id} went ${account.status} at ${utc(account.diedAt!)}, code ${account.deathCode ?? "none"}, cause ${causeOf(account)}${inCanary(account) ? ", canary" : ""}${account.readBefore ? "" : ", never read a page"}${account.reason ? `; status_reason: ${account.reason}` : ""}` });
      const instagram = day.filter(account => causeOf(account) === "instagram").length;
      if (data.deathGauge && Object.keys(data.deathGauge).length && data.deathGauge.instagram !== instagram)
        flagged.push({ at, kind: "death_gauge", excerpt: `crawler_v3_engage_deaths_24h{cause="instagram"} reads ${data.deathGauge.instagram ?? "none"} while this precheck counts ${instagram}; the gauge sees the actor and from_status columns grafana_ro cannot, so trust the gauge and fix this precheck` });
      const pauses = Object.entries(data.config).filter(([key, value]) => key.startsWith("pause.engage") && value === "true").map(([key]) => key);
      if (pauses.length) flagged.push({ at, kind: "pause", excerpt: `prod pause keys on: ${pauses.join(", ")}` });
    }
  }
  metrics.source_errors = data.errors.length;
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics, flagged };
}

const READ_LOG_SQL = (world: string): string => `select coalesce(sum(l.pages) filter (where l.at > now() - interval '24 hours'), 0) as pages_24h,
  coalesce(sum(l.pages) filter (where l.at > now() - interval '1 hour'), 0) as pages_1h,
  extract(epoch from max(l.at) filter (where l.pages > 0)) * 1000 as last_read_at
from ig_engage_read_log l join ig_engage_accounts a on a.id = l.account_id where a.world = '${world}'`;
const DEAD_SQL = `('${DEAD.join("', '")}')`;
const ACCOUNTS_SQL = `select a.id, a.status, a.status_reason as reason, extract(epoch from a.last_error_at) * 1000 as died_at,
  (select e.error_code from ig_engage_account_events e where e.account_id = a.id and e.outcome in ${DEAD_SQL} order by e.at desc limit 1) as death_code,
  exists (select 1 from ig_engage_account_events e where e.account_id = a.id and e.outcome in ${DEAD_SQL}) as evented,
  exists (select 1 from ig_engage_read_log l where l.account_id = a.id and l.pages > 0 and l.at < coalesce(a.last_error_at, now())) as read_before,
  exists (select 1 from ig_engage_read_log l where l.account_id = a.id and l.pages > 0 and l.at > now() - interval '24 hours') as read_24h
from ig_engage_accounts a where a.world = 'prod' order by a.id`;
const CONFIG_SQL = "select key, value from config where key like 'engage.rate_test%' or key like 'pause.engage%'";

export const readLogOf = (rows: Record<string, unknown>[]): ReadLog => {
  const row = rows[0];
  if (!row) throw new Error("the read log query returned no row");
  return { pages24h: num(row.pages_24h) ?? 0, pages1h: num(row.pages_1h) ?? 0, lastReadAt: num(row.last_read_at) };
};
export const accountsOf = (rows: Record<string, unknown>[]): Account[] => rows.map(row => ({
  id: Number(row.id), status: String(row.status), ...(row.reason ? { reason: String(row.reason) } : {}), diedAt: num(row.died_at), deathCode: row.death_code == null ? null : String(row.death_code),
  evented: row.evented === true, readBefore: row.read_before === true, read24h: row.read_24h === true,
}));

export async function measure(query: DsQuery | null, authError: string | null, now: number): Promise<EngageData> {
  const data: EngageData = { now, errors: [] };
  if (!query) { data.errors.push({ source: "grafana auth", message: authError ?? "no Grafana login" }); for (const source of ["prod read log", "staging read log", "prod accounts", "prod config"] as const) data.errors.push({ source, message: "not read: no Grafana login" }); return data; }
  const step = async <T>(source: Source, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const [prod, staging, accounts, config, gauge] = await Promise.all([
    step("prod read log", async () => readLogOf(await sqlRows(query, PG.prod, READ_LOG_SQL("prod")))),
    step("staging read log", async () => readLogOf(await sqlRows(query, PG.staging, READ_LOG_SQL("staging")))),
    step("prod accounts", async () => accountsOf(await sqlRows(query, PG.prod, ACCOUNTS_SQL))),
    step("prod config", async () => Object.fromEntries((await sqlRows(query, PG.prod, CONFIG_SQL)).map(row => [String(row.key), String(row.value ?? "")]))),
    step("prod death gauge", async () => Object.fromEntries((await promInstant(query, PROM.prod, 'max by (cause)(crawler_v3_engage_deaths_24h{world="prod"})')).map(series => [series.labels.cause ?? "?", series.value]))),
  ]);
  Object.assign(data, prod && { prod }, staging && { staging }, accounts && { accounts }, config && { config }, gauge && { deathGauge: gauge });
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
  const result = report(await measure(query, authError, now), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`engage-reads: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
