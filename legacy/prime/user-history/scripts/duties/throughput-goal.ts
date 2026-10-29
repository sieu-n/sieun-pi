import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, HOUR, MINUTE, PG, PROM, grafanaClient, num, promInstant, promRange, readGrafanaAuth, round1, settle, sqlRows, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The Throughput goal achieved duty's precheck for the Crawler VP chat (`node --import tsx scripts/duties/throughput-goal.ts`). Code only, reads only.
 * The owner, 10-22 (msg mvj491h5): "Crawler running -> Throughput goal achieved ( unified for all platform )". The headline counts the
 * throughput goals on this chat's board that prod misses, over every platform that has one, each read the way the crawler Throughput
 * dashboard on obs.virev.ai reads it:
 * - Instagram profiles (p826, 10,000 a minute held 6 h): the slowest rolling hour of the
 *   last 6 h outside prod deploys (DEPLOY_EXPR), the dashboard's "slowest hour, 6 h" stats. Instagram counts crawler.instagram_account_snapshots,
 *   one row per profile read on any path, the number p826's target and its census canary run read; census jobs that ended gone or private
 *   read no profile, so crawler.instagram_census_reads ran about 1,350 a minute over it at 06:00-06:30Z on 10-22 (11,002 against 9,648).
 *   TikTok Shop (p696) reads coverage instead since 10-23: live US products with an ok read in the last 7 days over the frontier's live
 *   products, against TTS_WEEKLY_PCT; its slowest-hour rate of ok product rows stays in the line as detail. Instagram reads
 *   ClickHouse rows, because the dashboard's gauge crawler_v3_rate_controller_good_per_minute keeps its last value while the controller is
 *   down: on 10-22 it read 11,100 from 00:55 to 01:50Z while census finished 56,843 jobs in the 01:00Z hour, so a stopped crawl would read green there;
 * - Meta Ads advertiser re-reads (p850, every due advertiser read within 7 days): advertiser walks finished a minute over 24 h (prod Postgres
 *   meta_ads_walks, as auto-sns-agent scripts/duties/crawler/meta-ads-crawl.mjs reads it) against the walks due now spread over the 7 days;
 * - Instagram re-reads (p683, owner 10-26: "1k+ every month, 10K+ every week" and "under 1k also monthly", at most 1% of read accounts with
 *   10,000+ followers past 7 days and at most 1% of the rest past 30 days): three 0.1% samples of prod instagram_census (REFRESH_SEEDS).
 *   p829's 14-day line left on 10-26, when the owner's t65 answer replaced it with p683 and the board dropped p829.
 * Each goal number comes from the board item at run time: its target, or the number in its title when it has none. Platforms that crawl on
 * prod with no goal on the board (crawler.job_run_events crawl_profile, and Instagram posts) are listed in the run detail and left out of the count.
 * The supporting metrics keep the rest of the owner's 10-19 duties for crawler-v3 (msg mvfe8foz): "Geonode mbps >=100mbps always", "nothing is
 * backlogging" (p827) and "Check the Observability and Metrics", every panel of the crawler dashboards run the way Grafana draws it.
 * GeoNode bytes follow auto-sns-agent scripts/duties/crawler/geonode-proxy-use.mjs geonodeBytes: HTTP bytes of each ledger plus 8,678 bytes of
 * CONNECT and TLS per new proxied connection, the size that file measured.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "throughput-goal.duty.json");
export const CHAT_ID = "01a115e2-9544-7204-b8db-8ce4d5319048";
const BOARD = join(homedir(), ".prime/agent/browser-chat/boards", `${CHAT_ID}.json`);
const CH = "estate_ch_prod";
/**
 * Rows still in the ClickHouse writer's queue (about 1,000 records, 10-19 15:17Z) would count short, so the GeoNode hours end at the last full
 * hour 5 minutes ago. "Geonode mbps >=100mbps always" is read as its slowest hour over the 24 hours since the last daily run.
 */
export const SETTLE_MS = 5 * MINUTE;
export const GEONODE_HOURS = 24;
/** The hold the goals read: p826's "held 6 h straight", and the same window on the dashboard's TikTok Shop stat. */
export const HOLD_MS = 6 * HOUR;
/**
 * p696's line since 10-23: the share of live US TikTok Shop products with an ok read in the last 7 days, the owner's "each re-read every week"
 * for p681. Crawler ops set it at 99.5% on 10-23 04:5xZ. A product read rate swings with how many are due (c67): on 10-23 the lane read about
 * 330 distinct products a minute because 1 live product was due and 99.98% had a 7-day ok read, so the old 2,000-a-minute line read Missed on
 * a finished week. Live leaves out frontier rows TikTok answered gone (151,705 of 6,442,529 on 10-23), which cannot be indexed.
 */
export const TTS_WEEKLY_PCT = 99.5;
export const TTS_WEEKLY_CH = "SELECT uniqExact(key) AS n FROM crawler.tiktok_shop_reads WHERE kind = 'product' AND outcome = 'ok' AND region = 'US' AND observed_at > now() - INTERVAL 7 DAY";
export const TTS_LIVE_PG = "SELECT count(*) AS n FROM tiktok_shop_frontier WHERE kind = 'product' AND region = 'US' AND last_outcome IS DISTINCT FROM 'gone'";
/** CONNECT and TLS bytes per new proxied connection, measured in geonode-proxy-use.mjs NEW_CONNECTION_BYTES. */
export const NEW_CONNECTION_BYTES = 8_678;
/** The meter's lane for census attempts; once the meter carries it, census connections come from the meter (geonode-proxy-use.mjs). */
const CENSUS_METER_LANE = "instagram_census";
/**
 * A queue grew when its 15-minute mean now is over 6 h ago's by more than 10% and by more than about one minute of census intake, its lowest
 * point over 30 minutes rose past the same line, and its 6 h slope is up. On 10-19 at 15:17Z the m-backlogs read of 38 prod series found every
 * rise under 10% inside the queue's normal 24 h bursts, and census ran 450k to 490k reads an hour, about 8,000 a minute, so a smaller rise
 * (crawl.videos at 280 records, 15:33Z) is no backlog. The low point keeps a buffer that fills and drains with intake out: on 10-20 the search
 * sync profile outbox swung 6k to 38k within an hour at 13k census reads a minute, so its 07:30Z mean read 22k against 11k 6 h earlier while its
 * 30-minute low read 14k against 7.8k. Real backlogs rise at their low point too: census-pg at 04:00Z on 10-20 (103k against 0), crawl.videos
 * at 07:30Z on 10-20 (532k against 438k) and the profile outbox at 21:30Z on 10-19 (731k against 2.6k).
 * ig_queues_growing_6h's `lastEventAt` is this run whenever it is above 0: each run reads every queue's mean, low and slope again at its own
 * time, so a counted queue grows now and drops out the run it stops. It is an open count, like seo-new-articles' new_unindexed_3d, and no
 * old event waits in it to leave a window. A failed queue read counts as unmeasured, and it failed at this run too. A count of 0 gives none.
 */
export const GROW_SHARE = 0.1;
export const GROW_MIN = 8_000;
/**
 * A queue with a wait gauge grew only when its oldest write also waits longer than this, in seconds. The search sync outbox holds the rows a
 * search backfill stages in its own lane (auto-sns-agent apps/crawler-v3 src/catalog/search_outbox.py BACKFILL_DUE), which the drain takes only
 * when no write is due, so a running backfill swells the outbox without holding a write. On 10-20 at 16:15Z the profile outbox held 359,538
 * rows, 328,299 of them the profile restage's backfill lane, while its oldest write waited 76 s. The number is the line of the repo's alert
 * crawler-prod-search-sync-backlog (apps/infra/metal/config/obs/grafana/alerting/crawler-health.yaml). Over 48 h of 30-minute points to 10-20
 * 16:00Z the profile outbox's oldest wait read 61 to 513 s outside its backlogs and 1,262 to 7,705 s inside them (10-18 16:00Z to 21:30Z,
 * 10-19 18:00Z to 10-20 01:00Z).
 */
export const WAIT_LINE_S = 300;
/**
 * A queue also backlogs while its 30-minute low stands over this many records, whether it grows or not (p827, "Instagram queues over 80k").
 * Growth alone read 0 on 10-22 while media.fetch/image-worker held 5.5M to 7.8M records and fell only because Kafka retention drops what the
 * media workers never read (p827's note). Over the 3 days to 10-22 07:20Z the largest 30-minute low of a group that held no backlog was 66,844
 * (instagram-census-ch) and 51,376 (instagram-census-crawl), while every backlog in those days stood far over it (census-pg 502k, crawl.posts
 * 387k, crawl.profiles 411k, crawl.videos 3.7M), and the smallest one measured, census-pg on 10-20 at 04:00Z, was 103k. A search sync
 * outbox over it whose oldest write waits under WAIT_LINE_S is a backfill, as above, and does not count.
 */
export const QUEUE_LINE = 80_000;

/**
 * The census Postgres writer's worst lag over 24 h, read only in the 5-minute slots where Instagram profiles read at p826's rate or more and no
 * deploy holds prod (p895, closed 10-23 on 2,613 records at most from 10-22 18:45Z to 00:44Z, against its line of 5,000). A slower census leaves
 * the writer idle, so its lag says nothing there; on 10-22 the lag passed 5,000 on 36 of 130 minutes from 06:00 to 08:00Z at 10,900 ok a minute,
 * while the lane scaler had stopped with 16 writers. The lag is crawler_v3_bus_group_lag_records of instagram-census-pg, its most in each slot. It is
 * one goal row of the headline (writerLagRow), so the duty keeps its headline and 3 supporting metrics (c75).
 * The headline's `lastEventAt` is the newest slot that keeps a missed row missed, when every missed row reads a trailing window's worst slot (this
 * row; geonode_mbps does the same with its newest hour under 100 Mbps). Before it the p895 miss carried no time over 21 d9 runs to 10-27
 * 00:25Z, so a miss that only waits for old slots to leave the 24 h read the same as one that new slots keep raising.
 */
export const WRITER_LAG_MS = 24 * HOUR;
export const WRITER_LAG_LINE = 5_000;
export const WRITER_LAG_EXPR = 'max(max_over_time(crawler_v3_bus_group_lag_records{world="prod",group="instagram-census-pg"}[5m]))';

/**
 * The refresh age of read Instagram accounts (p683, owner 10-26: "1k+ every month, 10K+ every week", "under 1k also monthly"). One 1% TABLESAMPLE
 * of instagram_census timed out under grafana_ro's 30 s statement_timeout on 10-20, so the read sums 0.1% samples with fixed seeds, all at once,
 * and keeps the ones that answered. Ten seeds read two at a time timed out on 10-29 at 22:47Z with the precheck at 134 s; one seed alone took 14.6 s
 * cold at 00:50Z and held 200,851 read rows of a 347M-row table, so three seeds hold about 600,000, more than the 397,538 ten held on 10-21.
 * A GONE row is an account Instagram no longer serves (the two-surface rule, auto-sns-agent census crawl.py), so it is left out.
 */
export const REFRESH_SEEDS: readonly number[] = [101, 102, 103];
/** The weekly tier's floor (owner 10-26, "10K+ every week"), as the census reads it: no follower count reads as 0 (auto-sns-agent census policy.cadence). */
export const WEEKLY_MIN_FOLLOWERS = 10_000;
const BIG = `coalesce(followers, 0) >= ${WEEKLY_MIN_FOLLOWERS}`;
export const refreshSql = (seed: number): string => `SELECT
  count(*) FILTER (WHERE last_ok_at IS NOT NULL AND state <> 'gone') AS read,
  count(*) FILTER (WHERE last_ok_at IS NOT NULL AND state <> 'gone' AND ${BIG}) AS "readBig",
  count(*) FILTER (WHERE last_ok_at < now() - interval '7 days' AND state <> 'gone' AND ${BIG}) AS "past7Big",
  count(*) FILTER (WHERE last_ok_at < now() - interval '30 days' AND state <> 'gone' AND NOT ${BIG}) AS "past30Rest"
FROM instagram_census TABLESAMPLE SYSTEM(0.1) REPEATABLE(${seed})`;
export interface RefreshSample { read: number; readBig: number; past7Big: number; past30Rest: number }
export interface RefreshShares { big7Pct: number | null; rest30Pct: number | null; sum: RefreshSample }
/** Sums the samples; null when none answered, so the metrics stay unmeasured instead of reading 0%. A tier with no sampled row reads null. */
export function refreshShares(samples: readonly RefreshSample[]): RefreshShares | null {
  const sum = samples.reduce((acc, s) => ({ read: acc.read + s.read, readBig: acc.readBig + s.readBig,
    past7Big: acc.past7Big + s.past7Big, past30Rest: acc.past30Rest + s.past30Rest }), { read: 0, readBig: 0, past7Big: 0, past30Rest: 0 });
  if (!sum.read) return null;
  const pct = (n: number, of: number): number | null => (of ? Math.round((100_000 * n) / of) / 1000 : null);
  return { big7Pct: pct(sum.past7Big, sum.readBig), rest30Pct: pct(sum.past30Rest, sum.read - sum.readBig), sum };
}

/** The Instagram pipeline queues: Kafka consumer lag, dead letters, search sync outbox and Redis stream lag. */
export const QUEUES: { family: string; expr: string; by: string[]; wait?: string }[] = [
  { family: "kafka lag", by: ["topic", "group"], expr: 'max by (topic, group) (crawler_v3_bus_group_lag_records{world="prod",topic=~"instagram.*|media.fetch|crawl_profile.instagram|crawl[.](profiles|posts|related_profiles|videos)"})' },
  { family: "dead letters", by: ["topic"], expr: 'max by (topic) (crawler_v3_bus_topic_retained_records{world="prod",topic=~"(instagram.*|media.fetch|crawl_profile.instagram|crawl[.].*)[.]dlq"})' },
  { family: "search sync outbox", by: ["kind"], expr: 'max by (kind) (crawler_v3_search_sync_outbox_rows{world="prod",kind=~"profile|content"})',
    wait: 'max by (kind) (crawler_v3_search_sync_outbox_oldest_age_seconds{world="prod",kind=~"profile|content"})' },
  { family: "redis stream lag", by: ["stream", "group"], expr: "max by (stream, group) (crawler_v3_stream_group_lag)" },
];

const GRAFANA = "https://obs.virev.ai";
/**
 * The crawler dashboards the owner opens: the "Crawler and data" folder's dashboards tagged for the crawler owner whose variables all hold a
 * set value. That leaves out the Engage fleet (owner:crawler-engage, the Engage chat's) and the profile and live trace lookups, whose query
 * variables wait for a key the owner types. On 10-19 at 15:55Z it picked 6 dashboards with 124 queried panels.
 */
export const DASHBOARD_FOLDER = "Crawler and data";
export const DASHBOARD_TAGS: readonly string[] = ["owner:crawler", "owner:crawler-v3"];

export type GrafanaApi = (path: string, body?: unknown) => Promise<unknown>;
export interface PanelTarget { refId?: string; hide?: boolean; datasource?: { type?: string; uid?: string } | null; [field: string]: unknown }
export interface DashPanel { id?: number; type?: string; title?: string; datasource?: PanelTarget["datasource"]; targets?: PanelTarget[]; panels?: DashPanel[] }
export interface Dashboard { uid: string; title: string; time?: { from?: string; to?: string }; panels?: DashPanel[];
  templating?: { list?: { name: string; type?: string; current?: { value?: unknown; text?: unknown } }[] } }
export interface PanelRead { dashboard: string; title: string; state: "ok" | "no data" | "error"; detail: string }

/** Every non-row panel, with the panels folded inside a collapsed row. */
export const leafPanels = (panels: readonly DashPanel[] = []): DashPanel[] =>
  panels.flatMap(panel => panel.type === "row" ? leafPanels(panel.panels) : [panel]);

/**
 * Fills ${name}, ${name:format} and $name with the variable's set value, quoted for the sqlstring, singlequote and doublequote formats.
 * ${name:text} reads the shown text, kept under "name:text": the Crawler · Sources and Daily brand pipe panels pick estate_pg_${env:text},
 * whose env value is a Prometheus uid and whose text is prod or stg, and read 26 panels as "Data source not found" on 10-22 13:32Z.
 */
export function interpolate(text: string, vars: ReadonlyMap<string, string>): string {
  const format = (value: string, as: string | undefined): string =>
    as === "sqlstring" || as === "singlequote" ? `'${value.replaceAll("'", "''")}'` : as === "doublequote" ? `"${value}"` : value;
  return text.replace(/\$\{(\w+)(?::(\w+))?\}|\$(\w+)\b/g, (whole, braced: string | undefined, as: string | undefined, bare: string | undefined) => {
    const value = (as === "text" ? vars.get(`${braced}:text`) : undefined) ?? vars.get(braced ?? bare ?? "");
    return value === undefined ? whole : format(value, as);
  });
}

/** A datasource whose uid names a variable, like estate_pg_${env:text}, filled the way Grafana fills it before it picks the source. */
const withUid = <T extends { uid?: string } | null | undefined>(ref: T, vars: ReadonlyMap<string, string>): T =>
  ref?.uid === undefined ? ref : { ...ref, uid: interpolate(ref.uid, vars) };

/** The ds/query body a panel sends: its shown targets, plus the hidden ones when a server-side expression reads them. */
export function panelQueries(panel: DashPanel, vars: ReadonlyMap<string, string>): { queries: Record<string, unknown>[]; shown: string[] } {
  const targets = panel.targets ?? [];
  const expression = targets.some(target => target.datasource?.type === "__expr__");
  const fill = (value: unknown): unknown => typeof value === "string" ? interpolate(value, vars) : value;
  const queries = targets.filter(target => expression || !target.hide).map(target => ({
    ...Object.fromEntries(Object.entries(target).map(([key, value]) => [key, fill(value)])),
    // measured: 1 minute is the finest step on these dashboards, and a 6 h range at it is 360 points, inside Prometheus's 11,000-point limit.
    refId: target.refId ?? "A", datasource: withUid(target.datasource ?? panel.datasource, vars), intervalMs: MINUTE,
  }));
  return { queries, shown: targets.filter(target => !target.hide).map(target => target.refId ?? "A") };
}

interface QueryAnswer { results?: Record<string, { error?: string; frames?: { data?: { values?: unknown[][] } }[] }>; message?: string }
/** A panel is ok when one shown query returns a value, an error when one fails, and No data when all return nothing. */
export function panelState(answer: QueryAnswer | null, shown: readonly string[]): Pick<PanelRead, "state" | "detail"> {
  let empty = 0;
  for (const refId of shown) {
    const result = answer?.results?.[refId];
    if (!result || result.error) return { state: "error", detail: String(result?.error ?? answer?.message ?? `no answer for ${refId}`) };
    if (!(result.frames ?? []).some(frame => (frame.data?.values ?? []).some((column, index, columns) =>
      (index > 0 || columns.length === 1) && column.some(cell => cell !== null && cell !== undefined)))) empty++;
  }
  return empty === shown.length ? { state: "no data", detail: "" } : { state: "ok", detail: "" };
}

/** Runs every panel of the owner's crawler dashboards the way Grafana draws it, over the dashboard's own time range. */
export async function readPanels(api: GrafanaApi): Promise<PanelRead[]> {
  const found = await api("/api/search?type=dash-db") as { uid: string; folderTitle?: string; tags?: string[] }[];
  const uids = found.filter(hit => hit.folderTitle === DASHBOARD_FOLDER && hit.tags?.some(tag => DASHBOARD_TAGS.includes(tag))).map(hit => hit.uid);
  const reads: PanelRead[] = [];
  for (const uid of uids) {
    const dash = ((await api(`/api/dashboards/uid/${uid}`)) as { dashboard: Dashboard }).dashboard;
    const variables = dash.templating?.list ?? [];
    if (variables.some(v => v.type === "query")) continue;
    const first = (cell: unknown): string => String(Array.isArray(cell) ? cell[0] ?? "" : cell ?? "");
    const vars = new Map(variables.flatMap(v => [[v.name, first(v.current?.value)], ...(v.current?.text === undefined ? [] : [[`${v.name}:text`, first(v.current.text)]])] as [string, string][]));
    const range = { from: dash.time?.from ?? "now-6h", to: dash.time?.to ?? "now" };
    reads.push(...await Promise.all(leafPanels(dash.panels).filter(panel => panel.targets?.length).map(async panel => {
      const { queries, shown } = panelQueries(panel, vars);
      const answer = await api("/api/ds/query", { queries, ...range }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      return { dashboard: dash.title, title: panel.title ?? `panel ${panel.id}`, ...panelState(answer as QueryAnswer, shown) };
    })));
  }
  return reads;
}

export function grafanaApi(fetcher: typeof fetch, auth: string, signal: AbortSignal): GrafanaApi {
  return async (path, body) => {
    const response = await fetcher(`${GRAFANA}${path}`, { method: body === undefined ? "GET" : "POST", signal,
      headers: { authorization: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok && path !== "/api/ds/query") throw new Error(`Grafana ${path} HTTP ${response.status}`);
    return parsed;
  };
}

export interface Queue { family: string; name: string; now: number; ago6h: number | null; slope6h: number | null; low?: number | null; low6h?: number | null; wait?: number | null }
export interface CensusWindow { jobs: number; bad: number; att: number; okAtt: number; wire: number }
export interface ProxyLane { lane: string; wire: number; newSessions: number }
export interface WireDay { day: number; wire: number; updated: number }
/** One hour of GeoNode ledgers, keyed by the hour's start. */
export interface GeoHour { hour: number; census?: CensusWindow; proxy: ProxyLane[] }
/** Prod Meta advertiser walks idle and due now, and advertiser walks finished in the last 24 h. */
export interface MetaWalks { due: number; finished24h: number }
/** A crawl with no goal on the board: good results a minute in the slowest full hour of the last 6 h (0 when an hour had none) and the 24 h average. */
export interface OtherRate { kind: string; slowest6h: number; average24h: number }
export interface BoardItem { id: string; text?: string; status?: string; target?: { target?: number; unit?: string } | null; children?: BoardItem[] }
export interface ThroughputData {
  now: number; errors: { source: string; message: string }[];
  /** Instagram profile slots and census-pg writer lag slots over WRITER_LAG_MS, and the deploy slots over the same span. */
  igSlots24h?: Slot[]; writerLag?: Slot[]; deploys24h?: number[];
  board?: BoardItem[]; igSlowest?: number | null; igLast30?: number; ttsSlowest?: number | null; ttsWeekly?: { read: number; live: number }; deployMinutes?: number; meta?: MetaWalks; refresh?: RefreshSample[];
  geoFrom: number; geoTo: number; geoHours?: GeoHour[]; adLibrary?: WireDay[]; queues?: Queue[]; panels?: PanelRead[]; others?: OtherRate[];
  /** Prod's deploy lock in seconds, its most in the 5 minutes up to this run, the slot the panel read falls in. */
  panelDeployLock?: number;
}

/** Where a goal number came from: the board item's target, the number in its title when it has no target, or this duty's own line. */
export type GoalSource = "target" | "title" | "duty";
/** One throughput goal read against prod. A null value or goal means its read failed, which leaves the headline unmeasured. */
export interface GoalRow {
  platform: string; item: string; value: number | null; goal: number | null; op: ">=" | "<="; source: GoalSource | null;
  /** Printed after the value, like "%"; and what the value counts, like "good a minute in the slowest hour of the last 6 h". */
  unit: string; reads: string; extra?: string | undefined;
  /** For a row that reads the worst slot of a trailing window, the start of the newest slot that keeps it missed (`PrecheckOutput.lastEventAt`). */
  lastEventAt?: number;
  /** The trailing window that `lastEventAt` waits to leave (`PrecheckOutput.windowMs`). */
  windowMs?: number;
}
export const missed = (row: GoalRow): boolean => row.value === null || row.goal === null || (row.op === ">=" ? row.value < row.goal : row.value > row.goal);

export function findItem(items: readonly BoardItem[] | undefined, id: string): BoardItem | null {
  for (const item of items ?? []) {
    if (item.id === id) return item;
    const inner = findItem(item.children, id);
    if (inner) return inner;
  }
  return null;
}

/** An item's goal number: its target, else the first number of three or more digits in its title, like p696's "to 2,000 now". */
export function boardGoal(items: readonly BoardItem[] | undefined, id: string): { goal: number; source: GoalSource } | null {
  const item = findItem(items, id);
  if (!item) return null;
  if (typeof item.target?.target === "number" && Number.isFinite(item.target.target)) return { goal: item.target.target, source: "target" };
  const titled = /\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b/.exec(item.text ?? "")?.[0];
  return titled ? { goal: Number(titled.replaceAll(",", "")), source: "title" } : null;
}

const ms = (t: number): string => `fromUnixTimestamp64Milli(toInt64(${Math.round(t)}), 'UTC')`;

/** The Ad Library's bytes in [from, to): each day row counts the share of its written span inside the window (geonode-proxy-use.mjs adLibraryBytes). */
export function adLibraryBytes(days: readonly WireDay[], from: number, to: number): number {
  let bytes = 0;
  for (const d of days) {
    const end = Math.min(d.day + 24 * 60 * MINUTE, Math.max(d.updated, d.day));
    if (end <= d.day) continue;
    bytes += (d.wire * Math.max(0, Math.min(end, to) - Math.max(d.day, from))) / (end - d.day);
  }
  return bytes;
}

/** GeoNode megabits a second over the window: census and other lanes' HTTP bytes, Ad Library bytes, and the handshake of each new connection. */
export function geonodeMbps(census: CensusWindow, proxy: readonly ProxyLane[], adLibrary: readonly WireDay[], from: number, to: number): number {
  const meter = proxy.reduce((sum, lane) => sum + lane.newSessions, 0);
  const censusConns = proxy.some(lane => lane.lane === CENSUS_METER_LANE) ? 0 : Math.max(census.jobs, census.jobs + census.att - census.okAtt - census.bad);
  const bytes = census.wire + proxy.reduce((sum, lane) => sum + lane.wire, 0) + adLibraryBytes(adLibrary, from, to) + (meter + censusConns) * NEW_CONNECTION_BYTES;
  return round1((bytes * 8) / ((to - from) / 1000) / 1e6);
}

const rose = (now: number, then: number): boolean => now - then > Math.max(GROW_MIN, GROW_SHARE * then);
const waits = (q: Queue): boolean => q.wait == null || q.wait > WAIT_LINE_S;
export const grew = (q: Queue): boolean =>
  q.ago6h !== null && q.slope6h !== null && q.slope6h > 0 && rose(q.now, q.ago6h) && (q.low == null || q.low6h == null || rose(q.low, q.low6h)) && waits(q);
export const standing = (q: Queue): boolean => (q.low ?? q.now) > QUEUE_LINE && waits(q);
export const backlogged = (q: Queue): boolean => standing(q) || grew(q);

const count = (n: number): string => n >= 1e6 ? `${round1(n / 1e6)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

const LONG = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
/** A rate or share for a line: whole numbers from 100 up, one decimal under it, and shares to three decimals. */
const fmt = (n: number, unit = ""): string => `${unit === "%" ? LONG.format(n) : LONG.format(n >= 100 ? Math.round(n) : round1(n))}${unit}`;

export function goalLine(row: GoalRow): string {
  const value = row.value === null ? "not read" : fmt(row.value, row.unit);
  const goal = row.goal === null ? "no goal number on the board item" : `${row.op === ">=" ? "at least" : "at most"} ${fmt(row.goal, row.unit)}`;
  const source = row.source === "title" ? ", from its title since it has no target" : "";
  const verdict = row.value === null || row.goal === null ? "Unmeasured" : missed(row) ? "Missed" : "Met";
  return `${row.platform} (${row.item}): ${value} ${row.reads}, against ${goal}${source}${row.extra ? ` ${row.extra}` : ""}. ${verdict}.`;
}

/** Every throughput goal the board holds, read against prod. A platform joins by a row here and a goal on the board, with no metric change. */
export function goalRows(d: ThroughputData): GoalRow[] {
  const goal = (id: string): { goal: number | null; source: GoalSource | null } => {
    const found = d.board ? boardGoal(d.board, id) : null;
    return found ?? { goal: null, source: null };
  };
  const shares = d.refresh ? refreshShares(d.refresh) : null;
  const metaDays = goal("p850");
  const days = metaDays.goal;
  const window = `in the slowest hour of the last ${HOLD_MS / HOUR} h${d.deployMinutes ? ` outside ${d.deployMinutes} min of prod deploys` : ""}`;
  return [
    { platform: "Instagram profiles", item: "p826", value: d.igSlowest ?? null, op: ">=", unit: "", reads: `read a minute ${window}`, ...goal("p826"),
      extra: d.igLast30 === undefined ? undefined : `(${fmt(d.igLast30)} a minute in the last 30 min)` },
    { platform: "TikTok Shop products", item: "p696", value: d.ttsWeekly && d.ttsWeekly.live > 0 ? (100 * d.ttsWeekly.read) / d.ttsWeekly.live : null,
      op: ">=", unit: "%", goal: TTS_WEEKLY_PCT, source: "duty", reads: "of live US products with an ok read in the last 7 days",
      extra: d.ttsWeekly ? `(${d.ttsWeekly.read.toLocaleString("en-US")} of ${d.ttsWeekly.live.toLocaleString("en-US")}, gone products left out; ${d.ttsSlowest == null ? "rate not read" : `${fmt(d.ttsSlowest)} good a minute ${window}`})` : undefined },
    { platform: "Meta Ads advertiser re-reads", item: "p850", op: ">=", unit: "", reads: "walks finished a minute over 24 h",
      value: d.meta ? d.meta.finished24h / (24 * 60) : null, goal: d.meta && days !== null ? d.meta.due / (days * 24 * 60) : null, source: metaDays.source,
      extra: d.meta && days !== null ? `(${d.meta.due.toLocaleString("en-US")} advertiser walks due now, read within ${days} days)` : undefined },
    { platform: "Instagram 10k+ weekly re-reads", item: "p683", value: shares?.big7Pct ?? null, op: "<=", unit: "%",
      reads: "of sampled read accounts with 10,000+ followers last read over 7 days ago", ...goal("p683"),
      extra: shares ? `(${shares.sum.past7Big.toLocaleString("en-US")} of ${shares.sum.readBig.toLocaleString("en-US")})` : undefined },
    { platform: "Instagram under-10k monthly re-reads", item: "p683", value: shares?.rest30Pct ?? null, op: "<=", unit: "%",
      reads: "of the other sampled read accounts last read over 30 days ago", ...goal("p683"),
      extra: shares ? `(${shares.sum.past30Rest.toLocaleString("en-US")} of ${(shares.sum.read - shares.sum.readBig).toLocaleString("en-US")})` : undefined },
    writerLagRow(d, goal("p826").goal),
  ];
}

/**
 * p895's row: the census Postgres writer's worst lag over 24 h in the slots at p826's rate outside deploys, against WRITER_LAG_LINE. A 24 h with no
 * such slot reads 0 and says so, since the writer had no load to judge and the p826 row is that miss; a failed read or no p826 number reads null.
 */
export function writerLagRow(d: ThroughputData, rate: number | null): GoalRow {
  const row = { platform: "Census Postgres writer", item: "p895", op: "<=" as const, unit: "", goal: WRITER_LAG_LINE, source: "duty" as const };
  if (!d.igSlots24h || !d.writerLag || !d.deploys24h || rate === null) return { ...row, value: null, reads: "records of lag at most over 24 h, not read" };
  const worst = writerLagAtRate(d.igSlots24h, d.writerLag, new Set(d.deploys24h), rate);
  if (!worst) return { ...row, value: 0, reads: `records of lag, not judged: no five-minute slot of the last 24 h read ${fmt(rate)} Instagram profiles a minute outside deploys` };
  const over = worst.newestOver === null ? "" : `; the newest over ${fmt(WRITER_LAG_LINE)} (${when(worst.newestOver)}) leaves the 24 h window at ${when(worst.newestOver + WRITER_LAG_MS)}`;
  return { ...row, value: worst.lag, reads: `records of lag at most over 24 h (${when(worst.slot)})`,
    extra: `(${worst.slots} of 288 five-minute slots at ${fmt(rate)} Instagram profiles a minute or more, outside deploys${over})`,
    ...(worst.newestOver === null ? {} : { lastEventAt: worst.newestOver, windowMs: WRITER_LAG_MS }) };
}

/** A time for a line, "10:55Z 10-26". */
const when = (t: number): string => `${utc(t).slice(6)} ${utc(t).slice(0, 5)}`;

/** GeoNode Mbps for each full hour of the window; an hour with no ledger rows reads its Ad Library bytes alone. */
export function geonodeHours(hours: readonly GeoHour[], adLibrary: readonly WireDay[], from: number, to: number): { hour: number; mbps: number }[] {
  const none: CensusWindow = { jobs: 0, bad: 0, att: 0, okAtt: 0, wire: 0 };
  const out: { hour: number; mbps: number }[] = [];
  for (let hour = from; hour < to; hour += HOUR) {
    const read = hours.find(h => h.hour === hour);
    out.push({ hour, mbps: geonodeMbps(read?.census ?? none, read?.proxy ?? [], adLibrary, hour, hour + HOUR) });
  }
  return out;
}

/** The metrics and flagged lines from what measure() read. A source that failed leaves its metric unmeasured, which misses. */
export function report(d: ThroughputData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const unmeasured = new Set<string>();
  const lastEventAt: Record<string, number> = {};
  const windowMs: Record<string, number> = {};
  const rows = goalRows(d);
  const missedRows = rows.filter(missed);
  metrics.throughput_goals_missed = missedRows.length;
  if (missedRows.length && missedRows.every(row => row.lastEventAt !== undefined && row.windowMs !== undefined)) {
    lastEventAt.throughput_goals_missed = Math.max(...missedRows.map(row => row.lastEventAt!));
    windowMs.throughput_goals_missed = Math.max(...missedRows.map(row => row.lastEventAt! + row.windowMs!)) - lastEventAt.throughput_goals_missed;
  }
  if (rows.some(row => row.value === null || row.goal === null)) unmeasured.add("throughput_goals_missed");
  for (const row of rows) flagged.push({ at: d.now, kind: "goal", item: row.item, excerpt: goalLine(row).slice(0, 300) });
  const items = Object.fromEntries(rows.flatMap(row => row.value === null || row.goal === null ? [] : [[row.item, { value: row.value, target: row.goal, op: row.op }] as const]));
  if (d.others) {
    const named = (kind: string): string => kind.replace(/^(\w+)/, word => ({ instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" })[word] ?? word);
    flagged.push({ at: d.now, kind: "no_goal", excerpt: `No throughput goal on the board, so left out of the count: ${d.others.length ? d.others.map(o =>
      `${named(o.kind)} ${fmt(o.average24h)} a minute over 24 h (slowest hour of 6 h ${fmt(o.slowest6h)})`).join("; ") : "none"}.`.slice(0, 300) });
  }
  const census = d.geoHours?.reduce<CensusWindow>((sum, h) => h.census ? { jobs: sum.jobs + h.census.jobs, bad: sum.bad + h.census.bad, att: sum.att + h.census.att,
    okAtt: sum.okAtt + h.census.okAtt, wire: sum.wire + h.census.wire } : sum, { jobs: 0, bad: 0, att: 0, okAtt: 0, wire: 0 });
  const span = `in the 24 h to ${utc(d.geoTo)}`;
  if (census && census.jobs) {
    flagged.push({ at: d.now, kind: "errors", excerpt: `Reported, not judged: ${round1((100 * census.bad) / census.jobs)}% of ${census.jobs.toLocaleString("en-US")} census jobs ended blocked or failed ${span}, and ${census.att ? round1(100 - (100 * census.okAtt) / census.att) : 0}% of tries failed. 40 to 70% of jobs failing is normal (owner 10-19, c65, c73); a rise past it goes to the alert rules.` });
  }
  if (d.geoHours && d.adLibrary) {
    const hours = geonodeHours(d.geoHours, d.adLibrary, d.geoFrom, d.geoTo);
    const slowest = hours.reduce((low, h) => h.mbps < low.mbps ? h : low, hours[0]!);
    metrics.geonode_mbps = slowest.mbps;
    const under = hours.filter(h => h.mbps < 100);
    const newestUnder = under.at(-1)?.hour;
    if (newestUnder !== undefined) { lastEventAt.geonode_mbps = newestUnder; windowMs.geonode_mbps = GEONODE_HOURS * HOUR; }
    const leaves = newestUnder === undefined ? "" : `, the newest leaving the window at ${when(newestUnder + GEONODE_HOURS * HOUR)}`;
    flagged.push({ at: d.now, kind: "geonode", excerpt: `GeoNode carried ${slowest.mbps} Mbps in its slowest hour ${span} (${utc(slowest.hour).slice(6)}), ${hours.at(-1)!.mbps} in the last, with ${under.length} of ${hours.length} hours under the owner's 100 Mbps${under.length ? `: ${under.map(h => `${utc(h.hour).slice(6, 11)} ${h.mbps}`).join(", ")}${leaves}` : ""}. Handshakes count ${NEW_CONNECTION_BYTES.toLocaleString("en-US")} bytes per new connection.`.slice(0, 300) });
  }
  if (d.queues) {
    const backlogs = d.queues.filter(backlogged);
    metrics.ig_queues_growing_6h = backlogs.length;
    const largest = [...d.queues].sort((a, b) => b.now - a.now).slice(0, 3);
    const trend = (q: Queue): string => `${q.family} ${q.name} ${count(q.now)}${q.ago6h === null ? " (no 6 h history)" : ` from ${count(q.ago6h)} 6 h ago`}${q.wait == null ? "" : `, oldest write ${Math.round(q.wait)} s`}`;
    flagged.push({ at: d.now, kind: "backlog", excerpt: `${backlogs.length} of ${d.queues.length} Instagram queues backlog, over ${count(QUEUE_LINE)} at their 30-minute low or grown over 6 h${backlogs.length ? `: ${backlogs.map(trend).join("; ")}` : ""}. Largest: ${largest.map(trend).join("; ")}.`.slice(0, 300) });
  }
  if (d.panels) {
    const { blank, leftOut } = blankPanels(d.panels, d.panelDeployLock);
    metrics.crawler_panels_blank = blank.length;
    const dashboards = new Set(d.panels.map(panel => panel.dashboard)).size;
    const locked = leftOut ? `, leaving out ${leftOut} No data panels because prod was under its deploy lock` : "";
    flagged.push({ at: d.now, kind: "dashboards", excerpt: `${blank.length} of ${d.panels.length} panels on ${dashboards} crawler dashboards show an error or No data${locked}${blank.length ? `: ${blank.map(panel => `${panel.dashboard} / ${panel.title} (${panel.state}${panel.detail ? `: ${panel.detail}` : ""})`).join("; ")}` : ""}.`.slice(0, 300) });
  }
  for (const error of d.errors) flagged.push({ at: d.now, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 300) });
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.unshift(unmeasuredFlag(replaced, d.now));
  if (metrics.ig_queues_growing_6h! > 0) lastEventAt.ig_queues_growing_6h = d.now;
  return { metrics, flagged, ...Object.keys(items).length ? { items } : {}, ...Object.keys(lastEventAt).length ? { lastEventAt } : {},
    ...Object.keys(windowMs).length ? { windowMs } : {} };
}

/** What each goal's crawl counts: every Instagram profile read on any path (p826's own reading), and TikTok Shop's good products as its rate controller lane counts them. */
export const GOOD_ROWS = {
  instagram: { table: "crawler.instagram_account_snapshots", where: "" },
  tiktokShop: { table: "crawler.tiktok_shop_reads", where: "kind = 'product' AND outcome = 'ok' AND " },
} as const;
export const SLOT_MS = 5 * MINUTE;
export interface Slot { slot: number; good: number }

/**
 * Prod's deploy lock, sampled every 5 minutes as the most it read in the 5 minutes before each point. deploy.sh holds it while it replaces the
 * crawler, and the crawl stops: on 10-22 prod held it from 00:55 to 01:52Z and ClickHouse took no Instagram, TikTok Shop or crawl_profile row from
 * 01:01 to 01:50Z. The repo's rate controller judges no fall then (apps/crawler-v3 src/control/rate_signals.py `deploying`), and the deploy's own
 * downtime is p146's number, so the goal rows leave those slots out. A value of 3,600 s or more is a lock left behind, as `deploying` reads it.
 * The prod Prometheus gets the gauge's env as exported_env (crawler-bus-retention.yaml).
 */
export const DEPLOY_EXPR = 'max(max_over_time(virev_deploy_running_seconds{exported_env="prod"}[5m]))';
export const DEPLOY_STALE_LOCK_S = 3_600;
/** The 5-minute slots under the deploy lock: a point at t covers the slot that ends at t. */
export const deploySlots = (points: readonly [number, number][]): Set<number> =>
  new Set(points.filter(([, seconds]) => seconds > 0 && seconds < DEPLOY_STALE_LOCK_S).map(([at]) => Math.floor((at - 1) / SLOT_MS) * SLOT_MS));

/**
 * The panels crawler_panels_blank counts. While prod holds its deploy lock (a reading as deploySlots takes it) the crawler restarts and its live
 * panels read No data: d9 read 7 blank at 10-24 22:47Z under metal-deploy 40139546438's lock (22:43 to 22:52Z), and 0 of 127 at 22:58Z. That
 * downtime is p146's number, so those No data panels are left out, and a panel whose query fails still counts.
 */
export function blankPanels(panels: readonly PanelRead[], deployLock: number | undefined): { blank: PanelRead[]; leftOut: number } {
  const locked = deployLock !== undefined && deployLock > 0 && deployLock < DEPLOY_STALE_LOCK_S;
  const blank = panels.filter(panel => panel.state === "error" || (panel.state === "no data" && !locked));
  return { blank, leftOut: locked ? panels.filter(panel => panel.state === "no data").length : 0 };
}

/**
 * Results a minute in the slowest rolling hour of the 5-minute slots inside [from, to) that no deploy holds; a slot with no row is a stop and
 * counts 0. With under an hour of such slots it reads their mean.
 */
export function slowestHour(slots: readonly Slot[], from: number, to: number, deploys: ReadonlySet<number> = new Set()): number {
  const good = new Map(slots.map(s => [s.slot, s.good]));
  const all = Array.from({ length: Math.floor((to - from) / SLOT_MS) }, (_, index) => from + index * SLOT_MS).filter(slot => !deploys.has(slot)).map(slot => good.get(slot) ?? 0);
  const perHour = HOUR / SLOT_MS;
  if (all.length < perHour) return all.length ? Math.round(all.reduce((sum, n) => sum + n, 0) / (all.length * SLOT_MS / MINUTE)) : 0;
  let low = Infinity;
  for (let start = 0; start + perHour <= all.length; start++) low = Math.min(low, all.slice(start, start + perHour).reduce((sum, n) => sum + n, 0));
  return Math.round(low / 60);
}

/**
 * The census writer's worst lag, and its slot, over the slots whose Instagram profiles read `rate` a minute or more and no deploy holds, with how
 * many slots counted and the newest counted slot over `line` (null when none is); null when no slot counted. A lag point at t covers the slot
 * that ends at t, as deploySlots reads it. The row misses until that newest slot leaves the window, not the worst one: on 10-27 at 01:10Z the
 * worst slot was 214,542 at 10:55Z on 10-26, while counted slots still read 8,034 at 22:05Z and up to 6,327 at 00:25 to 00:35Z on 10-27.
 */
export function writerLagAtRate(ig: readonly Slot[], lag: readonly Slot[], deploys: ReadonlySet<number>, rate: number, line = WRITER_LAG_LINE):
  { lag: number; slot: number; slots: number; newestOver: number | null } | null {
  const fast = new Set(ig.filter(s => s.good / (SLOT_MS / MINUTE) >= rate && !deploys.has(s.slot)).map(s => s.slot));
  const counted = lag.filter(s => fast.has(s.slot));
  if (!counted.length) return null;
  const worst = counted.reduce((top, s) => s.good > top.good ? s : top);
  const over = counted.filter(s => Math.round(s.good) > line).map(s => s.slot);
  return { lag: Math.round(worst.good), slot: worst.slot, slots: counted.length, newestOver: over.length ? Math.max(...over) : null };
}
export const lagSlots = (points: readonly [number, number][]): Slot[] =>
  points.filter(([, lag]) => Number.isFinite(lag)).map(([at, lag]) => ({ slot: Math.floor((at - 1) / SLOT_MS) * SLOT_MS, good: lag }));

/** Results a minute over the last 30 minutes before `to`, the window the census canary run reads. */
export const lastHalfHour = (slots: readonly Slot[], to: number): number =>
  Math.round(slots.filter(s => s.slot >= to - 30 * MINUTE && s.slot < to).reduce((sum, s) => sum + s.good, 0) / 30);

/** Prod Meta advertiser walks due now and finished in 24 h, in one scan of meta_ads_walks with the columns grafana_ro may read. */
export const META_SQL = `select count(*) filter (where kind = 'advertiser' and state = 'idle' and next_run_at <= now()) as due,
  count(*) filter (where kind = 'advertiser' and last_finished_at > now() - interval '1 day') as finished
from meta_ads_walks`;

/** Good results a minute per crawl with no board goal: crawl_profile jobs per platform and Instagram posts, by full hour over 24 h. */
export const OTHERS_SQL = `SELECT kind, if(countIf(hr >= cur - INTERVAL 6 HOUR) < 6, 0, minIf(v, hr >= cur - INTERVAL 6 HOUR)) AS slowest6h, sum(v) / 24 AS average24h
FROM (
  SELECT concat(platform, ' profiles') AS kind, toStartOfHour(ts) AS hr, count() / 60 AS v, toStartOfHour(now()) AS cur FROM crawler.job_run_events
  WHERE job_name = 'crawl_profile' AND status = 'completed' AND platform != '' AND ts >= toStartOfHour(now()) - INTERVAL 24 HOUR AND ts < toStartOfHour(now()) GROUP BY kind, hr
  UNION ALL
  SELECT 'instagram posts' AS kind, toStartOfHour(observed_at) AS hr, sum(posts_stored_ch) / 60 AS v, toStartOfHour(now()) AS cur FROM crawler.instagram_census_reads
  WHERE observed_at >= toStartOfHour(now()) - INTERVAL 24 HOUR AND observed_at < toStartOfHour(now()) GROUP BY hr
) GROUP BY kind ORDER BY average24h DESC`;
/** Crawls whose platform has a goal row: Instagram profiles are p826's, read on the census lanes the dashboard reads. */
export const GOAL_KINDS: ReadonlySet<string> = new Set(["instagram profiles"]);

export async function measure(query: DsQuery | null, api: GrafanaApi | null, authError: string | null, now: number, readBoard: () => Promise<BoardItem[]>): Promise<ThroughputData> {
  const geoTo = Math.floor((now - SETTLE_MS) / HOUR) * HOUR;
  const geoFrom = geoTo - GEONODE_HOURS * HOUR;
  const d: ThroughputData = { now, errors: [], geoFrom, geoTo };
  const step = async <T>(source: string, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { d.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const board = await step("board", readBoard);
  if (board) d.board = board;
  if (!query || !api) { d.errors.push({ source: "grafana auth", message: authError ?? "no client" }); return d; }
  const holdTo = Math.floor((now - SETTLE_MS) / SLOT_MS) * SLOT_MS;
  const holdFrom = holdTo - HOLD_MS;
  const lagFrom = holdTo - WRITER_LAG_MS;
  const slotsOf = async (rows: { table: string; where: string }, from = holdFrom): Promise<Slot[]> => (await sqlRows(query, CH,
    `SELECT toInt64(toUnixTimestamp(toStartOfFiveMinutes(observed_at))) * 1000 AS slot, count() AS good FROM ${rows.table} WHERE ${rows.where}observed_at >= ${ms(from)} AND observed_at < ${ms(holdTo)} GROUP BY slot`))
    .map(row => ({ slot: num(row.slot) ?? 0, good: num(row.good) ?? 0 }));
  const window = `observed_at >= ${ms(geoFrom)} AND observed_at < ${ms(geoTo)}`;
  const hourOf = "toInt64(toUnixTimestamp(toStartOfHour(observed_at))) * 1000";
  // The goal reads run before the panels. Each one answers in 0.2 to 2 s alone (10-23 08:40Z), but beside the burst of every panel's queries
  // ClickHouse missed Grafana's deadline on a different 2 to 5 of them on each of 3 runs at 08:30-08:45Z, so the headline went unmeasured.
  const [igSlots, ttsSlots, ttsWeekly, deployPoints, writerLag, meta, others, census, proxy, adLibrary, queues, refresh] = await Promise.all([
    step("instagram rate", () => slotsOf(GOOD_ROWS.instagram, lagFrom)),
    step("tiktok shop rate", () => slotsOf(GOOD_ROWS.tiktokShop)),
    step("tiktok shop weekly", async () => {
      const [read, live] = await Promise.all([sqlRows(query, CH, TTS_WEEKLY_CH), sqlRows(query, PG.prod, TTS_LIVE_PG)]);
      if (!read[0] || !live[0]) throw new Error("tiktok shop weekly coverage answered no row");
      return { read: num(read[0].n) ?? 0, live: num(live[0].n) ?? 0 };
    }),
    step("prod deploys", async () => (await promRange(query, PROM.prod, DEPLOY_EXPR, lagFrom, holdTo, SLOT_MS)).flatMap(series => series.points)),
    step("census writer lag", async () => lagSlots((await promRange(query, PROM.prod, WRITER_LAG_EXPR, lagFrom + SLOT_MS, holdTo, SLOT_MS)).flatMap(series => series.points))),
    step("meta ads walks", async () => {
      const row = (await sqlRows(query, PG.prod, META_SQL))[0];
      if (!row) throw new Error("meta_ads_walks answered no row");
      return { due: num(row.due) ?? 0, finished24h: num(row.finished) ?? 0 };
    }),
    step("other crawls", async () => (await sqlRows(query, CH, OTHERS_SQL)).map(row => ({ kind: String(row.kind), slowest6h: num(row.slowest6h) ?? 0, average24h: num(row.average24h) ?? 0 }))
      .filter(row => !GOAL_KINDS.has(row.kind))),
    step("census reads", async () => (await sqlRows(query, CH, `SELECT ${hourOf} AS hour, count() AS jobs, countIf(outcome IN ('blocked', 'failed')) AS bad, sum(attempts) AS att, sum(ok_attempts) AS okAtt, sum(wire_bytes) AS wire FROM crawler.instagram_census_reads WHERE ${window} GROUP BY hour`))
      .map(row => ({ hour: num(row.hour) ?? 0, census: { jobs: num(row.jobs) ?? 0, bad: num(row.bad) ?? 0, att: num(row.att) ?? 0, okAtt: num(row.okAtt) ?? 0, wire: num(row.wire) ?? 0 } }))),
    step("proxy wire reads", async () => (await sqlRows(query, CH, `SELECT ${hourOf} AS hour, lane, sum(wire_bytes) AS wire, sum(attempts_new_session) AS newSessions FROM crawler.proxy_wire_reads WHERE world = 'prod' AND provider = 'geonode' AND ${window} GROUP BY hour, lane`))
      .map(row => ({ hour: num(row.hour) ?? 0, lane: { lane: String(row.lane), wire: num(row.wire) ?? 0, newSessions: num(row.newSessions) ?? 0 } }))),
    step("ad library wire days", async () => {
      const day = (t: number): string => `date '${new Date(t).toISOString().slice(0, 10)}'`;
      return (await sqlRows(query, PG.prod, `SELECT (extract(epoch FROM day) * 1000)::bigint AS day, sum(wire_bytes)::bigint AS wire, (extract(epoch FROM max(updated_at)) * 1000)::bigint AS updated FROM meta_ads_wire_days WHERE day >= ${day(geoFrom)} AND day <= ${day(geoTo)} GROUP BY day ORDER BY day`))
        .map(row => ({ day: num(row.day) ?? 0, wire: num(row.wire) ?? 0, updated: num(row.updated) ?? 0 }));
    }),
    step("queues", async () => {
      const out: Queue[] = [];
      for (const q of QUEUES) {
        const [nowS, agoS, slopeS, lowS, low6hS, waitS] = await Promise.all([
          promInstant(query, PROM.prod, `avg_over_time((${q.expr})[15m:1m])`),
          promInstant(query, PROM.prod, `avg_over_time((${q.expr})[15m:1m] offset 6h)`),
          promInstant(query, PROM.prod, `deriv((${q.expr})[6h:5m])`),
          promInstant(query, PROM.prod, `min_over_time((${q.expr})[30m:1m])`),
          promInstant(query, PROM.prod, `min_over_time((${q.expr})[30m:1m] offset 6h)`),
          q.wait ? promInstant(query, PROM.prod, `avg_over_time((${q.wait})[15m:1m])`) : Promise.resolve(null),
        ]);
        const key = (labels: Record<string, string>): string => q.by.map(name => labels[name] ?? "").join("/");
        const byKey = (series: typeof nowS): Map<string, number> => new Map(series.map(s => [key(s.labels), s.value]));
        const [ago, slope, low, low6h] = [byKey(agoS), byKey(slopeS), byKey(lowS), byKey(low6hS)];
        for (const s of nowS) {
          const name = key(s.labels);
          out.push({ family: q.family, name, now: s.value, ago6h: ago.get(name) ?? null, slope6h: slope.get(name) ?? null, low: low.get(name) ?? null, low6h: low6h.get(name) ?? null,
            ...(waitS ? { wait: byKey(waitS).get(name) ?? null } : {}) });
        }
      }
      return out;
    }),
    step("refresh age", async () => {
      const read = async (seed: number): Promise<RefreshSample> => {
        const row = (await sqlRows(query, PG.prod, refreshSql(seed)))[0] ?? {};
        return { read: num(row.read) ?? 0, readBig: num(row.readBig) ?? 0, past7Big: num(row.past7Big) ?? 0, past30Rest: num(row.past30Rest) ?? 0 };
      };
      const settled = await Promise.allSettled(REFRESH_SEEDS.map(read));
      const out = settled.flatMap(s => s.status === "fulfilled" ? [s.value] : []);
      if (!out.length) throw settled.find((s): s is PromiseRejectedResult => s.status === "rejected")?.reason ?? new Error("no refresh sample answered");
      return out;
    }),
  ]);
  const [panels, panelDeployLock] = await Promise.all([step("dashboards", () => readPanels(api)),
    step("prod deploy lock now", async () => (await promInstant(query, PROM.prod, DEPLOY_EXPR))[0]?.value ?? 0)]);
  if (census && proxy) {
    const hours = new Map<number, GeoHour>();
    const at = (hour: number): GeoHour => hours.get(hour) ?? hours.set(hour, { hour, proxy: [] }).get(hour)!;
    for (const row of census) at(row.hour).census = row.census;
    for (const row of proxy) at(row.hour).proxy.push(row.lane);
    d.geoHours = [...hours.values()].sort((a, b) => a.hour - b.hour);
  }
  const deploys = deploySlots(deployPoints ?? []);
  d.deployMinutes = [...deploys].filter(slot => slot >= holdFrom && slot < holdTo).length * SLOT_MS / MINUTE;
  const holding = igSlots?.filter(s => s.slot >= holdFrom);
  Object.assign(d, igSlots && writerLag && deployPoints && { igSlots24h: igSlots, writerLag, deploys24h: [...deploys] },
    panels && { panels }, panelDeployLock !== undefined && { panelDeployLock }, holding && { igSlowest: slowestHour(holding, holdFrom, holdTo, deploys), igLast30: lastHalfHour(holding, holdTo) },
    ttsSlots && { ttsSlowest: slowestHour(ttsSlots, holdFrom, holdTo, deploys) }, ttsWeekly && { ttsWeekly }, meta && { meta }, others && { others },
    adLibrary && { adLibrary }, queues && { queues }, refresh && { refresh });
  return d;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("throughput-goal: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  let query: DsQuery | null = null;
  let api: GrafanaApi | null = null;
  let authError: string | null = null;
  try {
    const auth = await readGrafanaAuth();
    const signal = new AbortController().signal;
    query = grafanaClient(fetch, auth, now, signal);
    api = grafanaApi(fetch, auth, signal);
  } catch (error) { authError = error instanceof Error ? error.message : String(error); }
  const readBoard = async (): Promise<BoardItem[]> => (JSON.parse(await readFile(BOARD, "utf8")) as { plan?: BoardItem[] }).plan ?? [];
  const result = report(await measure(query, api, authError, now, readBoard), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`throughput-goal: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
