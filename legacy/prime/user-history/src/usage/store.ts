import { readFileSync } from "node:fs";
import { grafanaReader, LIVE_SPAN_MS, LIVE_TICK_MS, StoreUsage, type StoreReader, type UsageTotal } from "./store-sums.ts";
import { BUCKET_MS, bucketFor, RANGE_MS } from "../../../../../apps/chat/web/src/lib/api/shared/usage-range.ts";
import { type UsageBucket, type UsageFeed, type UsageGroup, type UsageMetric, type UsageModelRow, type UsageRate, type UsageSeries, type UsageSummary, type UsageTokens, type UsageWindow, USAGE_BUCKETS, USAGE_GROUPS, USAGE_METRICS, USAGE_WINDOWS } from "../shared/usage.ts";
import { waitedOnHost } from "../chat-latency.ts";
import { UsageError } from "./lgtm.ts";

/**
 * Settings > Usage and the sidebar Throughput line, read from the one store of model calls, ClickHouse `ai_usage.model_calls`, which a
 * collector on each host fills from every chat client (components/usage-collector). The SQL and the sums by hour, minute and 10 s are sw
 * factory's own (a copy of apps/chat/server/usage-store.ts `StoreUsage` in store-sums.ts), and a range is whole buckets that end with the one holding now, a day starting
 * at Seoul midnight, as sw factory's `usageReport` cuts it, so both Usage pages show the same totals and bars for the same range. The store is
 * read through Grafana's /api/ds/query on the ClickHouse datasource with the Viewer token in `<data dir>/grafana-alerts.json`. Nothing is read
 * until a page asks, and the sums follow the store every 2 s while the feed has a listener.
 */

export const DATASOURCE = "estate_ch_prod";
export const TABLE = "ai_usage.model_calls";

const pick = <T extends string>(list: readonly T[], name: string) => (value: string | null): T => {
  if (value !== null && (list as readonly string[]).includes(value)) return value as T;
  throw new UsageError(400, `Use ${name} ${list.join(", ")}.`);
};
export const parseWindow = pick(USAGE_WINDOWS, "window");
export const parseBucket = pick(USAGE_BUCKETS, "bucket");
export const parseGroup = (value: string | null): UsageGroup => value === null ? "none" : pick(USAGE_GROUPS, "group")(value);
export const parseMetric = (value: string | null): UsageMetric => value === null ? "output" : pick(USAGE_METRICS, "metric")(value);

const DAY_MS = 86_400_000;
/** The owner's day, Asia/Seoul, which has no daylight saving: a day starts at 15:00 UTC, whatever zone the box runs in (us-metal02 runs UTC). */
const SEOUL_MS = 9 * 3_600_000;
export const seoulMidnight = (at: number): number => Math.floor((at + SEOUL_MS) / DAY_MS) * DAY_MS - SEOUL_MS;

/**
 * A window as whole buckets that end with the one holding now, as sw factory's `usageReport` (apps/chat/server/usage.ts) cuts it: 24 hours for
 * 24h by hour, 1,440 minutes for 24h by minute, 90 Seoul days for 90d. A bucket the window does not offer, or none, reads as its default bucket.
 */
export function windowRange(window: UsageWindow, asked: UsageBucket | null, now: number): { bucket: UsageBucket; since: number; until: number; step: number } {
  const bucket = bucketFor(window, asked);
  const step = BUCKET_MS[bucket];
  const until = (bucket === "day" ? seoulMidnight(now) : Math.floor(now / step) * step) + step;
  return { bucket, since: until - RANGE_MS[window], until, step };
}

const zeroTokens = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
function addTokens(into: UsageTokens, row: UsageTotal): void {
  into.input += row.input;
  into.output += row.output;
  into.cacheRead += row.cacheRead;
  into.cacheWrite += row.cacheWrite;
  into.total += row.input + row.output + row.cacheRead + row.cacheWrite;
}
const tokensOf = (rows: readonly UsageTotal[]): UsageTokens => { const sum = zeroTokens(); for (const row of rows) addTokens(sum, row); return sum; };
const scale = (tokens: UsageTokens, by: number): UsageRate => ({ input: tokens.input / by, output: tokens.output / by, cacheRead: tokens.cacheRead / by, cacheWrite: tokens.cacheWrite / by, total: tokens.total / by });

/** The most keys a stacked chart lists; the rest fold into "other". */
const MAX_KEYS = 8;
/** The feed asks again every 5 s; the store's sums are read again every 2 s while it has a listener, so each reading is at most 2 s old. */
const FEED_MS = 5000;
/** The group key of one store row. */
const KEY_OF: Record<Exclude<UsageGroup, "none" | "kind">, (row: UsageTotal) => string> = {
  box: row => row.host || "unknown", client: row => row.client || "unknown", model: row => row.model || "unknown",
};

export class Usage {
  private readonly listeners = new Set<(feed: UsageFeed) => void>();
  private feed: ReturnType<typeof setInterval> | null = null;
  private store: StoreUsage | null = null;
  private following = false;

  constructor(private readonly reader: () => StoreReader, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = () => {}) {}

  /** The store's sums, built at the first read, so a missing token file is a 503 on the page rather than a failed chat start. */
  private sums(): StoreUsage {
    if (this.store) return this.store;
    let reader: StoreReader;
    try { reader = this.reader(); }
    catch (error) { throw new UsageError(503, `No Grafana token for the usage store: ${error instanceof Error ? error.message : String(error)}`); }
    return this.store = new StoreUsage(reader, TABLE, this.log, this.now);
  }

  /** The range's rows in buckets of `bucketMs`; with no listener the store is read once first, so a lone api/usage read is never stale. */
  private async rows(since: number, until: number, bucketMs: number): Promise<UsageTotal[]> {
    const store = this.sums();
    if (!this.following) {
      // The read runs on the store's box, so a slow answer is its time, not this box's (chat-latency.ts waitedOnHost).
      waitedOnHost();
      await store.pull();
    }
    try { return await store.usage({ since, until, bucketMs }); }
    catch (error) { throw new UsageError(502, error instanceof Error ? error.message : String(error)); }
  }

  /**
   * The headline numbers of every host and client together. The per-second rate is sw factory's live card (apps/chat/server/usage.ts
   * `usageLive`): the tokens of the minute that ends on the 10 s tick before now, over 60, and that rate every 10 s over the last 10 min.
   */
  async summary(): Promise<UsageSummary> {
    const now = this.now();
    const tick = LIVE_TICK_MS, at = Math.floor(now / tick) * tick;
    const window = BUCKET_MS.minute / tick, points = LIVE_SPAN_MS / tick + 1, ticks = points - 1 + window;
    const minute = BUCKET_MS.minute, minuteEnd = Math.floor(now / minute) * minute + minute;
    const day = windowRange("24h", "hour", now);
    const [tickRows, minuteRows, dayRows, todayRows] = await Promise.all([
      this.rows(at - ticks * tick, at, tick),
      this.rows(minuteEnd - 61 * minute, minuteEnd, minute),
      this.rows(day.since, day.until, day.until - day.since),
      this.rows(seoulMidnight(now), minuteEnd, minuteEnd - seoulMidnight(now)),
    ]);
    const perBucket = (rows: readonly UsageTotal[], since: number, step: number, count: number): UsageTokens[] => {
      const out = Array.from({ length: count }, zeroTokens);
      for (const row of rows) { const sum = out[Math.round((row.bucket! - since) / step)]; if (sum) addTokens(sum, row); }
      return out;
    };
    const tickSums = perBucket(tickRows, at - ticks * tick, tick, ticks);
    const minuteSums = perBucket(minuteRows, minuteEnd - 61 * minute, minute, 61);
    const rateAt = (i: number): UsageRate => {
      const sum = zeroTokens();
      for (const each of tickSums.slice(i, i + window)) for (const metric of USAGE_METRICS) sum[metric] += each[metric];
      return scale(sum, BUCKET_MS.minute / 1000);
    };
    const spark = Object.fromEntries(USAGE_METRICS.map(metric => [metric, Array.from({ length: points }, (_, i) => rateAt(i)[metric])])) as Record<UsageMetric, number[]>;
    const sparkMinutes = Object.fromEntries(USAGE_METRICS.map(metric => [metric, minuteSums.map(sum => sum[metric])])) as Record<UsageMetric, number[]>;
    const lastHour = zeroTokens();
    for (const each of minuteSums.slice(1)) for (const metric of USAGE_METRICS) lastHour[metric] += each[metric];
    const staleSince = this.store?.staleSince();
    return {
      state: "live", at: now, perSecond: rateAt(points - 1), perMinute: scale(lastHour, 60), perDay: tokensOf(dayRows),
      costToday: todayRows.reduce((sum, row) => sum + row.cost, 0), spark, sparkMinutes, ...(staleSince === undefined ? {} : { staleSince }),
    };
  }

  /** Tokens over time for the chart, one point per bucket that saw tokens or calls; `t` is the bucket start. */
  async series(window: UsageWindow, asked: UsageBucket, group: UsageGroup, metric: UsageMetric = "output"): Promise<UsageSeries> {
    const { bucket, since, until, step } = windowRange(window, asked, this.now());
    const rows = await this.rows(since, until, step);
    const at = new Map<number, UsageSeries["points"][number]>();
    const totals = new Map<string, number>();
    for (const row of rows) {
      let point = at.get(row.bucket!);
      if (!point) at.set(row.bucket!, point = { t: row.bucket!, tokens: zeroTokens(), costUsd: 0, calls: 0, ...group === "none" ? {} : { byKey: {} } });
      addTokens(point.tokens, row);
      point.calls += row.turns;
      point.costUsd = (point.costUsd ?? 0) + row.cost;
      if (group === "none") continue;
      if (group === "kind") {
        for (const kind of ["output", "input", "cacheWrite", "cacheRead"] as const) point.byKey![kind] = (point.byKey![kind] ?? 0) + row[kind];
        continue;
      }
      const key = KEY_OF[group](row);
      const value = metric === "total" ? row.input + row.output + row.cacheRead + row.cacheWrite : row[metric];
      point.byKey![key] = (point.byKey![key] ?? 0) + value;
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
    let keys = group === "kind" ? ["output", "input", "cacheWrite", "cacheRead"] : [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    if (keys.length > MAX_KEYS && group !== "kind") {
      const kept = new Set(keys.slice(0, MAX_KEYS - 1));
      for (const p of at.values()) for (const [key, value] of Object.entries(p.byKey ?? {})) {
        if (kept.has(key)) continue;
        delete p.byKey![key];
        p.byKey!.other = (p.byKey!.other ?? 0) + value;
      }
      keys = [...kept, "other"];
    }
    const points = [...at.values()].filter(p => p.tokens.total > 0 || p.calls > 0).sort((a, b) => a.t - b.t);
    const staleSince = this.store?.staleSince();
    return { window, bucket, group, metric, since, until, keys, points, ...(staleSince === undefined ? {} : { staleSince }) };
  }

  /** One row per host, client and model that used tokens in the chart's range, with calls and cost. */
  async models(window: UsageWindow, asked: UsageBucket | null = null): Promise<{ models: UsageModelRow[] }> {
    const { since, until } = windowRange(window, asked, this.now());
    const rows = new Map<string, UsageModelRow>();
    for (const row of await this.rows(since, until, until - since)) {
      const box = row.host || "unknown", client = row.client || "unknown", model = row.model || "unknown", key = `${box}\n${client}\n${model}`;
      let found = rows.get(key);
      if (!found) rows.set(key, found = { box, client, model, calls: 0, tokens: zeroTokens(), costUsd: 0 });
      found.calls += row.turns;
      addTokens(found.tokens, row);
      found.costUsd += row.cost;
    }
    return { models: [...rows.values()].filter(found => found.tokens.total > 0 || found.calls > 0) };
  }

  /** The feed payload now: the summary, or the error that kept it from the store. */
  async reading(): Promise<UsageFeed> {
    try { return await this.summary(); }
    catch (error) { return { state: "error", at: this.now(), error: error instanceof Error ? error.message : String(error) }; }
  }

  /** The `usage` feed: one reading now, then one every FEED_MS while anyone listens; the store's sums follow it every 2 s meanwhile. */
  subscribe(listener: (feed: UsageFeed) => void): () => void {
    this.listeners.add(listener);
    if (!this.feed) {
      try { this.sums().start(); this.following = true; }
      catch { /* reading() below reports the missing token */ }
      let busy = false;
      this.feed = setInterval(() => {
        if (busy) return;
        busy = true;
        void this.reading().then(feed => { for (const each of this.listeners) each(feed); }).finally(() => { busy = false; });
      }, FEED_MS);
      this.feed.unref();
    }
    void this.reading().then(feed => { if (this.listeners.has(listener)) listener(feed); });
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  close(): void {
    if (this.feed) clearInterval(this.feed);
    this.feed = null;
    this.store?.stop();
    this.following = false;
    this.listeners.clear();
  }
}

/** The store as prod reads it: SQL through Grafana's /api/ds/query to the ClickHouse datasource, with the Viewer token of `config`. */
export const grafanaStore = (config: string) => (): StoreReader => {
  const { url } = JSON.parse(readFileSync(config, "utf8")) as { url?: unknown };
  if (typeof url !== "string") throw new Error(`${config} needs url and token`);
  return grafanaReader({ url, datasource: DATASOURCE, tokenFile: config, tokenKey: "token" });
};
