import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, MINUTE, PG, PROM, grafanaClient, num, promInstant, readGrafanaAuth, round1, settle, sqlRows, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The Crawler running duty's precheck for the Crawler VP chat (`node --import tsx scripts/duties/crawler-running.ts`). Code only, reads only.
 * The owner, 10-19 (msg mvfe8foz): "Keep crawler running actively - Check the Observability and Metrics - Geonode mbps >=100mbps always -
 * instagram profiles at 10k+/min, nothing is backlogging: pg -> os/ch, media worker". It reads the same numbers the crawler dashboards show:
 * - prod ClickHouse (estate_ch_prod): crawler.instagram_account_snapshots, one row per Instagram profile read on any path, for profiles a
 *   minute; crawler.instagram_census_reads for the census job failure share and census wire bytes; crawler.proxy_wire_reads for the other
 *   lanes' GeoNode bytes and new connections;
 * - prod Postgres (estate_pg_prod): meta_ads_wire_days, the Ad Library's GeoNode bytes;
 * - Prometheus (estate_prometheus): the prod Kafka consumer lag, dead letter, search sync outbox and Redis stream lag series of the
 *   Instagram pipeline, for queues that grew over 6 h.
 * GeoNode bytes follow auto-sns-agent scripts/duties/crawler/geonode-proxy-use.mjs geonodeBytes: HTTP bytes of each ledger plus 8,678 bytes of
 * CONNECT and TLS per new proxied connection, the size that file measured.
 */

const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "crawler-running.duty.json");
const CH = "estate_ch_prod";
/** The judged window: the 30 minutes that end 5 minutes ago, so rows still in the ClickHouse writer's queue (about 1,000 records, 10-19 15:17Z) do not count short. */
export const WINDOW_MS = 30 * MINUTE;
export const SETTLE_MS = 5 * MINUTE;
/** CONNECT and TLS bytes per new proxied connection, measured in geonode-proxy-use.mjs NEW_CONNECTION_BYTES. */
export const NEW_CONNECTION_BYTES = 8_678;
/** The meter's lane for census attempts; once the meter carries it, census connections come from the meter (geonode-proxy-use.mjs). */
const CENSUS_METER_LANE = "instagram_census";
/**
 * A queue grew when its 15-minute mean now is over 6 h ago's by more than 10% and by more than about one minute of census intake, and its 6 h
 * slope is up. On 10-19 at 15:17Z the m-backlogs read of 38 prod series found every rise under 10% inside the queue's normal 24 h bursts, and
 * census ran 450k to 490k reads an hour, about 8,000 a minute, so a smaller rise (crawl.videos at 280 records, 15:33Z) is no backlog.
 */
export const GROW_SHARE = 0.1;
export const GROW_MIN = 8_000;

/** The Instagram pipeline queues: Kafka consumer lag, dead letters, search sync outbox and Redis stream lag. */
export const QUEUES: { family: string; expr: string; by: string[] }[] = [
  { family: "kafka lag", by: ["topic", "group"], expr: 'max by (topic, group) (crawler_v3_bus_group_lag_records{world="prod",topic=~"instagram.*|media.fetch|crawl_profile.instagram|crawl[.](profiles|posts|related_profiles|videos)"})' },
  { family: "dead letters", by: ["topic"], expr: 'max by (topic) (crawler_v3_bus_topic_retained_records{world="prod",topic=~"(instagram.*|media.fetch|crawl_profile.instagram|crawl[.].*)[.]dlq"})' },
  { family: "search sync outbox", by: ["kind"], expr: 'max by (kind) (crawler_v3_search_sync_outbox_rows{world="prod",kind=~"profile|content"})' },
  { family: "redis stream lag", by: ["stream", "group"], expr: "max by (stream, group) (crawler_v3_stream_group_lag)" },
];

export interface Queue { family: string; name: string; now: number; ago6h: number | null; slope6h: number | null }
export interface CensusWindow { jobs: number; bad: number; att: number; okAtt: number; wire: number }
export interface ProxyLane { lane: string; wire: number; newSessions: number }
export interface WireDay { day: number; wire: number; updated: number }
export interface RunningData {
  now: number; from: number; to: number; errors: { source: string; message: string }[];
  profiles?: number; census?: CensusWindow; proxy?: ProxyLane[]; adLibrary?: WireDay[]; queues?: Queue[];
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

export const grew = (q: Queue): boolean =>
  q.ago6h !== null && q.slope6h !== null && q.now - q.ago6h > Math.max(GROW_MIN, GROW_SHARE * q.ago6h) && q.slope6h > 0;

const count = (n: number): string => n >= 1e6 ? `${round1(n / 1e6)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

/** The metrics and flagged lines from what measure() read. A source that failed leaves its metric unmeasured, which misses. */
export function report(d: RunningData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const minutes = (d.to - d.from) / MINUTE;
  const span = `${utc(d.from)} to ${utc(d.to).slice(6)}`;
  if (d.profiles !== undefined) {
    metrics.ig_profiles_per_min = Math.round(d.profiles / minutes);
    flagged.push({ at: d.now, kind: "profiles", excerpt: `Prod read ${metrics.ig_profiles_per_min.toLocaleString("en-US")} Instagram profiles a minute ${span} (${d.profiles.toLocaleString("en-US")} account rows on every read path). Goal p1 is 10,000 a minute held 6 h.` });
  }
  if (d.census) {
    metrics.ig_job_fail_pct = d.census.jobs ? round1((100 * d.census.bad) / d.census.jobs) : 0;
    flagged.push({ at: d.now, kind: "errors", excerpt: `Census: ${metrics.ig_job_fail_pct}% of ${d.census.jobs.toLocaleString("en-US")} jobs ended blocked or failed ${span}, and ${d.census.att ? round1(100 - (100 * d.census.okAtt) / d.census.att) : 0}% of tries failed. 40 to 70% of jobs failing is normal (owner 10-19, c65, c73).` });
  }
  if (d.census && d.proxy && d.adLibrary) {
    metrics.geonode_mbps = geonodeMbps(d.census, d.proxy, d.adLibrary, d.from, d.to);
    flagged.push({ at: d.now, kind: "geonode", excerpt: `GeoNode carried ${metrics.geonode_mbps} Mbps ${span}, counting ${NEW_CONNECTION_BYTES.toLocaleString("en-US")} bytes of handshake per new connection; the owner's floor is 100 Mbps.` });
  }
  if (d.queues) {
    const growing = d.queues.filter(grew);
    metrics.ig_queues_growing_6h = growing.length;
    const largest = [...d.queues].sort((a, b) => b.now - a.now).slice(0, 3);
    const trend = (q: Queue): string => `${q.family} ${q.name} ${count(q.now)}${q.ago6h === null ? " (no 6 h history)" : ` from ${count(q.ago6h)} 6 h ago`}`;
    flagged.push({ at: d.now, kind: "backlog", excerpt: `${growing.length} of ${d.queues.length} Instagram queues grew over 6 h${growing.length ? `: ${growing.map(trend).join("; ")}` : ""}. Largest: ${largest.map(trend).join("; ")}.`.slice(0, 300) });
  }
  for (const error of d.errors) flagged.push({ at: d.now, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 300) });
  const unmeasured = new Set<string>();
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.unshift(unmeasuredFlag(replaced, d.now));
  return { metrics, flagged };
}

export async function measure(query: DsQuery | null, authError: string | null, now: number): Promise<RunningData> {
  const to = now - SETTLE_MS;
  const from = to - WINDOW_MS;
  const d: RunningData = { now, from, to, errors: [] };
  if (!query) { d.errors.push({ source: "grafana auth", message: authError ?? "no client" }); return d; }
  const step = async <T>(source: string, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); } catch (error) { d.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const window = `observed_at >= ${ms(from)} AND observed_at < ${ms(to)}`;
  const [profiles, census, proxy, adLibrary, queues] = await Promise.all([
    step("profiles", async () => num((await sqlRows(query, CH, `SELECT count() AS n FROM crawler.instagram_account_snapshots WHERE ${window}`))[0]?.n) ?? 0),
    step("census reads", async () => {
      const row = (await sqlRows(query, CH, `SELECT count() AS jobs, countIf(outcome IN ('blocked', 'failed')) AS bad, sum(attempts) AS att, sum(ok_attempts) AS okAtt, sum(wire_bytes) AS wire FROM crawler.instagram_census_reads WHERE ${window}`))[0] ?? {};
      return { jobs: num(row.jobs) ?? 0, bad: num(row.bad) ?? 0, att: num(row.att) ?? 0, okAtt: num(row.okAtt) ?? 0, wire: num(row.wire) ?? 0 };
    }),
    step("proxy wire reads", async () => (await sqlRows(query, CH, `SELECT lane, sum(wire_bytes) AS wire, sum(attempts_new_session) AS newSessions FROM crawler.proxy_wire_reads WHERE world = 'prod' AND provider = 'geonode' AND ${window} GROUP BY lane`))
      .map(row => ({ lane: String(row.lane), wire: num(row.wire) ?? 0, newSessions: num(row.newSessions) ?? 0 }))),
    step("ad library wire days", async () => {
      const day = (t: number): string => `date '${new Date(t).toISOString().slice(0, 10)}'`;
      return (await sqlRows(query, PG.prod, `SELECT (extract(epoch FROM day) * 1000)::bigint AS day, sum(wire_bytes)::bigint AS wire, (extract(epoch FROM max(updated_at)) * 1000)::bigint AS updated FROM meta_ads_wire_days WHERE day >= ${day(from)} AND day <= ${day(to)} GROUP BY day ORDER BY day`))
        .map(row => ({ day: num(row.day) ?? 0, wire: num(row.wire) ?? 0, updated: num(row.updated) ?? 0 }));
    }),
    step("queues", async () => {
      const out: Queue[] = [];
      for (const q of QUEUES) {
        const [nowS, agoS, slopeS] = await Promise.all([
          promInstant(query, PROM.prod, `avg_over_time((${q.expr})[15m:1m])`),
          promInstant(query, PROM.prod, `avg_over_time((${q.expr})[15m:1m] offset 6h)`),
          promInstant(query, PROM.prod, `deriv((${q.expr})[6h:5m])`),
        ]);
        const key = (labels: Record<string, string>): string => q.by.map(name => labels[name] ?? "").join("/");
        const ago = new Map(agoS.map(s => [key(s.labels), s.value]));
        const slope = new Map(slopeS.map(s => [key(s.labels), s.value]));
        for (const s of nowS) out.push({ family: q.family, name: key(s.labels), now: s.value, ago6h: ago.get(key(s.labels)) ?? null, slope6h: slope.get(key(s.labels)) ?? null });
      }
      return out;
    }),
  ]);
  Object.assign(d, profiles !== undefined && { profiles }, census && { census }, proxy && { proxy }, adLibrary && { adLibrary }, queues && { queues });
  return d;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("crawler-running: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  let query: DsQuery | null = null;
  let authError: string | null = null;
  try { query = grafanaClient(fetch, await readGrafanaAuth(), now, new AbortController().signal); } catch (error) { authError = error instanceof Error ? error.message : String(error); }
  const result = report(await measure(query, authError, now), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`crawler-running: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
