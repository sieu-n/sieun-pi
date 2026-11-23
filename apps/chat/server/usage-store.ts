/**
 * Usage from the one store of model calls, the ClickHouse table `usage.model_calls` that a collector on each host fills from every chat client
 * (components/usage-collector). The chat keeps its sums by hour, minute and 10 s in memory, so api/usage answers with no call to the store.
 */
import { readFileSync } from "node:fs";
import type { UsageRange, UsageTotal } from "./host/types.ts";
import { BUCKET_MS, RANGE_BUCKETS, RANGE_MS, USAGE_RANGES } from "../web/src/lib/api/shared/usage-range.ts";

/**
 * Where the store is and how to read it, from the JSON file `APPS_CHAT_USAGE_STORE` names. `clickhouse` posts SQL to a ClickHouse HTTP port;
 * `grafana` sends it through Grafana's `/api/ds/query` to the ClickHouse datasource `datasource`, which is how prod reads it, since prod
 * ClickHouse binds only 127.0.0.1 on us-metal01. A secret is read from a file: the whole file, or the JSON key `tokenKey` or `passwordKey`.
 */
export type UsageStoreConfig =
  | { transport: "clickhouse"; url: string; table: string; user?: string; passwordFile?: string; passwordKey?: string }
  | { transport: "grafana"; url: string; table: string; datasource: string; tokenFile: string; tokenKey?: string };

/** One answer column by column, as ClickHouse's JSONColumns and Grafana's data frames both give it. */
export type Columns = Record<string, readonly unknown[]>;

export interface StoreReader {
  query(sql: string): Promise<Columns>;
}

const str = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`usage store config: ${what} must be a non-empty string`);
  return value;
};

/** Parses the config file's JSON at the edge, so the rest trusts its shape. */
export function parseUsageStoreConfig(raw: unknown): UsageStoreConfig {
  if (!raw || typeof raw !== "object") throw new Error("usage store config: not an object");
  const o = raw as Record<string, unknown>;
  const opt = (key: string) => (o[key] === undefined ? {} : { [key]: str(o[key], key) });
  if (o.transport === "clickhouse") return { transport: "clickhouse", url: str(o.url, "url"), table: str(o.table, "table"), ...opt("user"), ...opt("passwordFile"), ...opt("passwordKey") };
  if (o.transport === "grafana") {
    return { transport: "grafana", url: str(o.url, "url"), table: str(o.table, "table"), datasource: str(o.datasource, "datasource"), tokenFile: str(o.tokenFile, "tokenFile"), ...opt("tokenKey") };
  }
  throw new Error(`usage store config: transport must be "clickhouse" or "grafana", got ${JSON.stringify(o.transport)}`);
}

function secret(file: string, key?: string): string {
  const text = readFileSync(file, "utf8");
  return key ? str((JSON.parse(text) as Record<string, unknown>)[key], `${key} in ${file}`) : text.trim();
}

export function clickhouseReader(config: Extract<UsageStoreConfig, { transport: "clickhouse" }>): StoreReader {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (config.user) headers["x-clickhouse-user"] = config.user;
  if (config.passwordFile) headers["x-clickhouse-key"] = secret(config.passwordFile, config.passwordKey);
  return {
    async query(sql) {
      const response = await fetch(config.url, { method: "POST", headers, body: `${sql}\nFORMAT JSONColumns` });
      if (!response.ok) throw new Error(`clickhouse ${response.status}: ${(await response.text()).slice(0, 400)}`);
      return (await response.json()) as Columns;
    },
  };
}

type Frame = { schema?: { fields?: { name: string }[] }; data?: { values?: unknown[][] } };
type DsAnswer = { results?: Record<string, { error?: string; frames?: Frame[] }> };

export function grafanaReader(config: Extract<UsageStoreConfig, { transport: "grafana" }>): StoreReader {
  const token = secret(config.tokenFile, config.tokenKey);
  const url = `${config.url.replace(/\/+$/, "")}/api/ds/query`;
  return {
    async query(sql) {
      const response = await fetch(url, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        // The SQL names its own time bounds, so from and to only satisfy the API.
        body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: config.datasource }, rawSql: sql, format: 1 }], from: "now-1h", to: "now" }),
      });
      const answer = (await response.json().catch(() => ({}))) as DsAnswer;
      const result = answer.results?.A;
      if (!response.ok || result?.error) throw new Error(`grafana ${response.status}: ${(result?.error ?? JSON.stringify(answer)).slice(0, 400)}`);
      const frame = result?.frames?.[0];
      const fields = frame?.schema?.fields ?? [];
      return Object.fromEntries(fields.map((field, i) => [field.name, frame?.data?.values?.[i] ?? []]));
    },
  };
}

export const storeReader = (config: UsageStoreConfig): StoreReader => (config.transport === "clickhouse" ? clickhouseReader(config) : grafanaReader(config));

/** How far back the kept sums go: the longest range and one more bucket, since a range ends with the bucket that holds now. */
export const HOURS_KEPT_MS = Math.max(...USAGE_RANGES.map(range => RANGE_MS[range] + Math.max(...RANGE_BUCKETS[range].map(bucket => BUCKET_MS[bucket]))));
export const MINUTES_KEPT_MS = Math.max(...USAGE_RANGES.filter(range => RANGE_BUCKETS[range].includes("minute")).map(range => RANGE_MS[range])) + BUCKET_MS.minute;
/** The live rate's grain: Prime's per-second card reads LGTM's 10 s export interval (user-history lgtm.ts SPARK_S). */
export const LIVE_TICK_MS = 10_000;
/** The live spark's span, 10 min as Prime's card draws it; its first point looks back one more minute. */
export const LIVE_SPAN_MS = 600_000;
export const TICKS_KEPT_MS = LIVE_SPAN_MS + BUCKET_MS.minute + LIVE_TICK_MS;
/** The last minutes are read again this often, as often as `Threads` reads the thread list, so the page is never further behind than the sidebar. */
export const USAGE_PULL_MS = 2_000;

type GrainName = "hour" | "minute" | "tick";
const GRAIN_MS: Readonly<Record<GrainName, number>> = { hour: 3_600_000, minute: 60_000, tick: LIVE_TICK_MS };
const KEPT_MS: Readonly<Record<GrainName, number>> = { hour: HOURS_KEPT_MS, minute: MINUTES_KEPT_MS, tick: TICKS_KEPT_MS };
/** Coarsest first: a range reads the coarsest grain its bounds and buckets fall on. */
const GRAIN_NAMES: readonly GrainName[] = ["hour", "minute", "tick"];

/** One bucket's sums for one host, client, agent, thread and model; `bucket` is the bucket's first epoch ms. */
type Sum = Required<Pick<UsageTotal, "bucket" | "host" | "client" | "agent">> & Omit<UsageTotal, "bucket" | "host" | "client" | "agent">;
type Grain = { sums: Map<number, Sum[]>; covered: number };
const SUM_FIELDS = ["turns", "input", "output", "cacheRead", "cacheWrite", "cost", "costInput", "costOutput", "costCacheRead", "costCacheWrite"] as const;

/** The store's sums of one grain from `from` on, in buckets of the grain's length; a client with no threads names its session as the thread. */
export function sumsSql(table: string, grain: GrainName, from: number): string {
  const ms = GRAIN_MS[grain];
  return `SELECT '${grain}' AS grain, toFloat64(intDiv(toUnixTimestamp64Milli(call_at), ${ms}) * ${ms}) AS bucket, host, client, agent,
  if(thread = '', session, thread) AS thread_or_session, argMax(thread_name, call_at) AS thread_name, model, toFloat64(count()) AS turns,
  toFloat64(sum(input_tokens)) AS input, toFloat64(sum(output_tokens)) AS output, toFloat64(sum(cache_read_tokens)) AS cache_read,
  toFloat64(sum(cache_write_tokens)) AS cache_write, toFloat64(sum(cost_input_usd)) AS cost_input, toFloat64(sum(cost_output_usd)) AS cost_output,
  toFloat64(sum(cost_cache_read_usd)) AS cost_cache_read, toFloat64(sum(cost_cache_write_usd)) AS cost_cache_write
FROM ${table} FINAL
WHERE call_at >= fromUnixTimestamp64Milli(toInt64(${from}))
GROUP BY bucket, host, client, agent, thread_or_session, model`;
}

/** One query for every grain, so the grains it replaces come from one read. */
const pullSql = (table: string, from: Readonly<Record<GrainName, number>>): string =>
  GRAIN_NAMES.map(grain => sumsSql(table, grain, from[grain])).join("\nUNION ALL\n");

function rowsOf(columns: Columns): { grain: GrainName; sum: Sum }[] {
  const grains = columns.grain ?? [];
  if (!grains.length) return [];
  const col = (name: string): readonly unknown[] => {
    const values = columns[name];
    if (!values || values.length !== grains.length) throw new Error(`usage store: the answer has no column ${name} of ${grains.length} values`);
    return values;
  };
  const [bucket, host, client, agent, thread, threadName, model, turns, input, output, cacheRead, cacheWrite, costInput, costOutput, costCacheRead, costCacheWrite] =
    ["bucket", "host", "client", "agent", "thread_or_session", "thread_name", "model", "turns", "input", "output", "cache_read", "cache_write", "cost_input", "cost_output",
      "cost_cache_read", "cost_cache_write"].map(col);
  return grains.map((grain, i) => {
    if (grain !== "hour" && grain !== "minute" && grain !== "tick") throw new Error(`usage store: unknown grain ${String(grain)}`);
    const n = (values: readonly unknown[] | undefined) => Number(values![i]);
    const sum: Sum = {
      bucket: n(bucket), host: String(host![i]), client: String(client![i]), agent: String(agent![i]), thread: String(thread![i]), threadName: String(threadName![i]), model: String(model![i]),
      turns: n(turns), input: n(input), output: n(output), cacheRead: n(cacheRead), cacheWrite: n(cacheWrite), costInput: n(costInput), costOutput: n(costOutput),
      costCacheRead: n(costCacheRead), costCacheWrite: n(costCacheWrite), cost: 0,
    };
    sum.cost = sum.costInput + sum.costOutput + sum.costCacheRead + sum.costCacheWrite;
    return { grain, sum };
  });
}

/**
 * How often all 90 days of hours and 24 h of minutes are read again. A call a collector sends more than the tail's 11 min after it ran (a Mac
 * that slept, a backfill, a repricing) shows up within this long.
 */
export const STORE_FULL_PULL_MS = 600_000;

/**
 * Every host's and client's model calls, summed by hour (90 days), minute (24 h) and 10 s (11 min) in memory from the store. A read of the
 * store replaces every bucket it covers, so a row a collector resends or reprices never counts twice: the store keeps one row per call
 * (ReplacingMergeTree read with FINAL), and each bucket here is that bucket's sum in the last read. The first pull, and one every
 * `STORE_FULL_PULL_MS`, reads every grain over its whole kept span; every other pull reads only the buckets since the hour, minute and 10 s
 * tick that held now minus 11 min.
 */
export class StoreUsage {
  private readonly grains: Record<GrainName, Grain> = { hour: { sums: new Map(), covered: Infinity }, minute: { sums: new Map(), covered: Infinity }, tick: { sums: new Map(), covered: Infinity } };
  private pulling?: Promise<void>;
  private fullAt = -Infinity;
  private read = false;
  private lastError?: string;
  private timer?: NodeJS.Timeout;

  private readonly reader: StoreReader;
  private readonly table: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly fullEvery: number;

  // Plain fields, not parameter properties: pi-host-relay loads this file through config.ts with node's type stripping, which refuses them.
  constructor(reader: StoreReader, table: string, log: (line: string) => void = () => {}, now: () => number = Date.now, fullEvery: number = STORE_FULL_PULL_MS) {
    this.reader = reader;
    this.table = table;
    this.log = log;
    this.now = now;
    this.fullEvery = fullEvery;
  }

  start(ms = USAGE_PULL_MS): void {
    void this.pull();
    this.timer = setInterval(() => void this.pull(), ms);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Reads the store; a pull while one runs waits for that one. */
  pull(): Promise<void> {
    this.pulling ??= this.pullOnce().finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    const now = this.now();
    const full = now - this.fullAt >= this.fullEvery;
    const from = Object.fromEntries(GRAIN_NAMES.map(grain => {
      const ms = GRAIN_MS[grain];
      return [grain, Math.floor((now - (full ? KEPT_MS[grain] : TICKS_KEPT_MS)) / ms) * ms];
    })) as Record<GrainName, number>;
    const started = performance.now();
    let rows: { grain: GrainName; sum: Sum }[];
    try {
      rows = rowsOf(await this.reader.query(pullSql(this.table, from)));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`usage: reading the store failed: ${this.lastError}`);
      return;
    }
    if (full) this.log(`usage: the full read of the store took ${Math.round(performance.now() - started)} ms for ${rows.length} sums`);
    const fresh = Object.fromEntries(GRAIN_NAMES.map(grain => [grain, new Map<number, Sum[]>()])) as Record<GrainName, Map<number, Sum[]>>;
    for (const { grain, sum } of rows) {
      const list = fresh[grain].get(sum.bucket);
      if (list) list.push(sum);
      else fresh[grain].set(sum.bucket, [sum]);
    }
    for (const name of GRAIN_NAMES) {
      const grain = this.grains[name];
      const oldest = now - KEPT_MS[name];
      for (const start of grain.sums.keys()) if (start >= from[name] || start < oldest) grain.sums.delete(start);
      for (const [start, sums] of fresh[name]) grain.sums.set(start, sums);
      if (full) grain.covered = from[name];
      else grain.covered = Math.max(grain.covered, Math.floor(oldest / GRAIN_MS[name]) * GRAIN_MS[name]);
    }
    if (full) this.fullAt = now;
    this.read = true;
    this.lastError = undefined;
  }

  /**
   * The range's sums per bucket, host, client, agent, thread and model, from the coarsest kept grain whose steps the range's bounds and
   * buckets fall on. Before the first read lands a call waits for it, and a store that never answered fails the call with its error.
   */
  async usage(range: UsageRange): Promise<UsageTotal[]> {
    const { since, until, bucketMs } = range;
    if (since === undefined || until === undefined || !bucketMs) throw new RangeError("usage: a range needs since, until and bucketMs");
    if (!this.read) await this.pull();
    if (!this.read) throw new Error(`usage: the store has not answered: ${this.lastError ?? "no read yet"}`);
    const name = GRAIN_NAMES.find(g => since % GRAIN_MS[g] === 0 && until % GRAIN_MS[g] === 0 && bucketMs % GRAIN_MS[g] === 0);
    if (!name) throw new RangeError(`usage: ${since} to ${until} by ${bucketMs} ms falls on no kept grain`);
    const grain = this.grains[name];
    if (since < grain.covered) throw new RangeError(`usage: ${since} is older than the kept ${name} sums, which start at ${grain.covered}`);
    const only = range.threads?.length ? new Set(range.threads) : undefined;
    const rows = new Map<string, UsageTotal>();
    for (let start = since; start < until; start += GRAIN_MS[name]) {
      for (const sum of grain.sums.get(start) ?? []) {
        if (only && !only.has(sum.thread)) continue;
        const bucket = since + Math.floor((start - since) / bucketMs) * bucketMs;
        const key = `${bucket}\u0000${sum.host}\u0000${sum.client}\u0000${sum.agent}\u0000${sum.thread}\u0000${sum.model}`;
        const row = rows.get(key);
        if (!row) rows.set(key, { ...sum, bucket });
        else for (const field of SUM_FIELDS) row[field] += sum[field];
      }
    }
    return [...rows.values()];
  }
}
