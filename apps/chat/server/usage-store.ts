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
type Sum = Required<Pick<UsageTotal, "bucket" | "host" | "client" | "agent" | "series">> & Omit<UsageTotal, "bucket" | "host" | "client" | "agent" | "series">;
type Grain = { sums: Map<number, Sum[]>; covered: number };

/** Adds one sum's counts into another, field by field, which keeps the fold's property reads monomorphic. */
export function addSums(into: UsageTotal, from: UsageTotal): void {
  into.turns += from.turns;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cost += from.cost;
  into.costInput += from.costInput;
  into.costOutput += from.costOutput;
  into.costCacheRead += from.costCacheRead;
  into.costCacheWrite += from.costCacheWrite;
}

const CALL_COLUMNS = `call_at, host, client, agent, thread, thread_name, session, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd`;

/**
 * The store's calls from `from` on, each call once. A full read takes FINAL. A tail read keeps each row_id's latest copy instead, since the
 * table's sort key (host, client, row_id) leaves call_at out, so FINAL widens a tail read to most of the table: on the rig with 5.0 M rows a
 * tail read took 2.6 s with FINAL and 0.24 s this way (~/work/usage-one-source/usage-read-path/report.md). A key's call_at never changes
 * (store.md section 5, point 2), so every copy of a call falls on the same side of `from`.
 */
function callsFrom(table: string, from: number, full: boolean): string {
  const since = `call_at >= fromUnixTimestamp64Milli(toInt64(${from}))`;
  return full
    ? `(SELECT ${CALL_COLUMNS} FROM ${table} FINAL WHERE ${since})`
    : `(SELECT ${CALL_COLUMNS} FROM ${table} WHERE ${since} ORDER BY collected_at DESC LIMIT 1 BY row_id)`;
}

/**
 * The store's sums of every grain from that grain's `from` on, in buckets of the grain's length, from one scan of the calls: three scans, one
 * per grain, took 3.0 to 7.3 s for a full read on the rig, and one took 1.8 to 2.8 s. A client with no threads names its session as the thread.
 */
export function pullSql(table: string, from: Readonly<Record<GrainName, number>>, full: boolean): string {
  const grains = GRAIN_NAMES.map(grain => `('${grain}', ${GRAIN_MS[grain]}, ${from[grain]})`).join(", ");
  return `SELECT g.1 AS grain, toFloat64(intDiv(toUnixTimestamp64Milli(call_at), g.2) * g.2) AS bucket, host, client, agent,
  if(thread = '', session, thread) AS thread_or_session, argMax(thread_name, call_at) AS thread_name, model, toFloat64(count()) AS turns,
  toFloat64(sum(input_tokens)) AS input, toFloat64(sum(output_tokens)) AS output, toFloat64(sum(cache_read_tokens)) AS cache_read,
  toFloat64(sum(cache_write_tokens)) AS cache_write, toFloat64(sum(cost_input_usd)) AS cost_input, toFloat64(sum(cost_output_usd)) AS cost_output,
  toFloat64(sum(cost_cache_read_usd)) AS cost_cache_read, toFloat64(sum(cost_cache_write_usd)) AS cost_cache_write
FROM ${callsFrom(table, Math.min(...Object.values(from)), full)} ARRAY JOIN [${grains}] AS g
WHERE toUnixTimestamp64Milli(call_at) >= g.3
GROUP BY grain, bucket, host, client, agent, thread_or_session, model`;
}

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
      costCacheRead: n(costCacheRead), costCacheWrite: n(costCacheWrite), cost: 0, series: "",
    };
    sum.cost = sum.costInput + sum.costOutput + sum.costCacheRead + sum.costCacheWrite;
    sum.series = `${sum.host}\u0000${sum.client}\u0000${sum.agent}\u0000${sum.thread}\u0000${sum.model}`;
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
      rows = rowsOf(await this.reader.query(pullSql(this.table, from, full)));
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
    const out: UsageTotal[] = [];
    // A bucket of the grain's own length is the kept sums as they are: no copy, which on 61k hour sums was most of a 30-day read.
    if (bucketMs === GRAIN_MS[name]) {
      for (let start = since; start < until; start += bucketMs) for (const sum of grain.sums.get(start) ?? []) if (!only || only.has(sum.thread)) out.push(sum);
      return out;
    }
    let bucket = since;
    let open = new Map<string, UsageTotal>();
    const close = () => { for (const row of open.values()) out.push(row); };
    for (let start = since; start < until; start += GRAIN_MS[name]) {
      const at = since + Math.floor((start - since) / bucketMs) * bucketMs;
      if (at !== bucket) {
        close();
        open = new Map();
        bucket = at;
      }
      for (const sum of grain.sums.get(start) ?? []) {
        if (only && !only.has(sum.thread)) continue;
        const row = open.get(sum.series);
        if (!row) open.set(sum.series, { ...sum, bucket });
        else addSums(row, sum);
      }
    }
    close();
    return out;
  }
}
