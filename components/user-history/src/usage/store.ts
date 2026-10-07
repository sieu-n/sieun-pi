import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { UsageBucket, UsageCall, UsageGroup, UsageMetric, UsageModelRow, UsageSeries, UsageSource, UsageTokens, UsageWindow } from "../shared/usage.ts";
import type { Price } from "./prices.ts";

/**
 * usage.duckdb: a cache derived from the transcripts. Three kinds of change, from cheapest:
 * - a new column: add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` line to `schema`; existing rows keep their data;
 * - a parser fix: bump that parser's `version` (parsers.ts) and only that source is read again (resetSources);
 * - anything else: bump `schemaVersion`, which deletes the file, and the next start builds it again from the raw data.
 */
export const schemaVersion = "1";

/** `parser`: the version of the parser (or database reader) that read the file, so a parser fix finds its rows. */
export type FileRow = { path: string; source: string; dev: number; ino: number; size: number; offset: number; mtime: number; tail: string; state: string; parser: string };
export type StoredCall = UsageCall & { id: bigint };

const windowMs: Record<Exclude<UsageWindow, "all">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
const bucketMs: Record<UsageBucket, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
export const maxPoints = 5000;
export class QueryError extends Error {}

/** One 64-bit key per (source, callId), so the unique index stays small: millions of rows cost tens of MB, not hundreds. */
export function callKey(source: string, callId: string): bigint {
  return createHash("sha1").update(source).update("\0").update(callId).digest().readBigUInt64BE(0);
}

/** Cost in SQL: the source's own cost, else tokens times the joined LiteLLM rates. Reasoning is priced as output. */
const costSql = "coalesce(c.cost_usd, c.input * p.input + (c.output + c.reasoning) * p.output + c.cache_read * p.cache_read + c.cache_write * p.cache_write)";
const totalSql = "(c.input + c.output + c.cache_read + c.cache_write + c.reasoning)";
/** Every token kind of a call for the in-memory throughput window; `output` includes reasoning. */
export type CallTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** The stack order of group "kind": the generated tokens first, the cache mass on top. */
export const KIND_KEYS: readonly Exclude<UsageMetric, "total">[] = ["output", "input", "cacheWrite", "cacheRead"];

const schema = [
  "CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)",
  `CREATE TABLE IF NOT EXISTS calls (id UBIGINT PRIMARY KEY, source VARCHAR NOT NULL, call_id VARCHAR NOT NULL, session_id VARCHAR,
    ended_at BIGINT NOT NULL, started_at BIGINT, provider VARCHAR, model VARCHAR, input BIGINT NOT NULL, output BIGINT NOT NULL,
    cache_read BIGINT NOT NULL, cache_write BIGINT NOT NULL, reasoning BIGINT NOT NULL, cost_usd DOUBLE, cwd VARCHAR)`,
  "CREATE TABLE IF NOT EXISTS calls_stage AS SELECT * FROM calls LIMIT 0",
  `CREATE TABLE IF NOT EXISTS files (path VARCHAR PRIMARY KEY, source VARCHAR, dev DOUBLE, ino DOUBLE, size BIGINT, "offset" BIGINT,
    mtime DOUBLE, tail VARCHAR, state VARCHAR)`,
  "CREATE TABLE IF NOT EXISTS files_stage AS SELECT * FROM files LIMIT 0",
  // Added after schema 1 shipped; rows written before carry the first parser version.
  "ALTER TABLE files ADD COLUMN IF NOT EXISTS parser VARCHAR DEFAULT '1'",
  "ALTER TABLE files_stage ADD COLUMN IF NOT EXISTS parser VARCHAR DEFAULT '1'",
  "CREATE TABLE IF NOT EXISTS prices (model VARCHAR PRIMARY KEY, matched VARCHAR, input DOUBLE, output DOUBLE, cache_read DOUBLE, cache_write DOUBLE)",
];

const upsertCalls = `INSERT INTO calls SELECT * FROM calls_stage ON CONFLICT (id) DO UPDATE SET
  input = greatest(calls.input, excluded.input), output = greatest(calls.output, excluded.output),
  cache_read = greatest(calls.cache_read, excluded.cache_read), cache_write = greatest(calls.cache_write, excluded.cache_write),
  reasoning = greatest(calls.reasoning, excluded.reasoning), cost_usd = greatest(calls.cost_usd, excluded.cost_usd),
  started_at = least(calls.started_at, excluded.started_at),
  ended_at = CASE WHEN calls.source = 'claude-code' THEN greatest(calls.ended_at, excluded.ended_at) ELSE calls.ended_at END,
  model = coalesce(calls.model, excluded.model), cwd = coalesce(calls.cwd, excluded.cwd), session_id = coalesce(calls.session_id, excluded.session_id)`;

const num = (value: unknown): number => typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
const numOrNull = (value: unknown): number | null => value === null || value === undefined ? null : num(value);

export class UsageStore {
  private constructor(private readonly instance: DuckDBInstance, private readonly db: DuckDBConnection, readonly fresh: boolean) {}

  /** Opens the file, or makes a new one when it is missing or carries another schema version. */
  static async open(path: string): Promise<UsageStore> {
    const options = { threads: "2", memory_limit: "512MB", preserve_insertion_order: "false" };
    let instance = await DuckDBInstance.create(path, options);
    let db = await instance.connect();
    const version = await db.runAndReadAll("SELECT value FROM meta WHERE key = 'schema'").then(r => r.getRowsJS()[0]?.[0] ?? null, () => null);
    let fresh = version === null;
    if (version !== null && version !== schemaVersion) {
      db.closeSync(); instance.closeSync();
      await rm(path, { force: true }); await rm(path + ".wal", { force: true });
      instance = await DuckDBInstance.create(path, options);
      db = await instance.connect();
      fresh = true;
    }
    for (const statement of schema) await db.run(statement);
    await db.run("INSERT OR REPLACE INTO meta VALUES ('schema', $v)", { v: schemaVersion });
    const files = await db.runAndReadAll("SELECT count(*) FROM files").then(r => num(r.getRowsJS()[0]?.[0]));
    return new UsageStore(instance, db, fresh || files === 0);
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** One statement or transaction at a time: the ingest, the price refresh and the queries share one connection. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Waits for the statement in flight, then closes the connection and the database file. */
  async close(): Promise<void> {
    await this.queue;
    this.db.closeSync(); this.instance.closeSync();
  }

  files(): Promise<FileRow[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll(`SELECT path, source, dev, ino, size, "offset", mtime, tail, state, parser FROM files`);
    return reader.getRowObjectsJS().map(row => ({ path: String(row.path), source: String(row.source), dev: num(row.dev), ino: num(row.ino), size: num(row.size),
      offset: num(row.offset), mtime: num(row.mtime), tail: String(row.tail ?? ""), state: String(row.state ?? "{}"), parser: String(row.parser ?? "1") }));
  }); }

  /** One transaction: the calls of a batch and the file offsets they were read up to, so a crash never skips or loses rows. */
  write(calls: StoredCall[], files: FileRow[]): Promise<void> { return this.exclusive(async () => {
    await this.db.run("BEGIN TRANSACTION");
    try {
      if (calls.length) {
        const appender = await this.db.createAppender("calls_stage");
        for (const c of calls) {
          appender.appendUBigInt(c.id); appender.appendVarchar(c.source); appender.appendVarchar(c.callId);
          if (c.sessionId === null) appender.appendNull(); else appender.appendVarchar(c.sessionId);
          appender.appendBigInt(BigInt(Math.round(c.endedAt)));
          if (c.startedAt === null) appender.appendNull(); else appender.appendBigInt(BigInt(Math.round(c.startedAt)));
          if (c.provider === null) appender.appendNull(); else appender.appendVarchar(c.provider);
          if (c.model === null) appender.appendNull(); else appender.appendVarchar(c.model);
          for (const n of [c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning]) appender.appendBigInt(BigInt(n));
          if (c.costUsd === null) appender.appendNull(); else appender.appendDouble(c.costUsd);
          if (c.cwd === null) appender.appendNull(); else appender.appendVarchar(c.cwd);
          appender.endRow();
        }
        appender.closeSync();
        await this.db.run(upsertCalls);
        await this.db.run("DELETE FROM calls_stage");
      }
      if (files.length) {
        const appender = await this.db.createAppender("files_stage");
        for (const f of files) {
          appender.appendVarchar(f.path); appender.appendVarchar(f.source); appender.appendDouble(f.dev); appender.appendDouble(f.ino);
          appender.appendBigInt(BigInt(f.size)); appender.appendBigInt(BigInt(f.offset)); appender.appendDouble(f.mtime);
          appender.appendVarchar(f.tail); appender.appendVarchar(f.state); appender.appendVarchar(f.parser); appender.endRow();
        }
        appender.closeSync();
        await this.db.run("INSERT OR REPLACE INTO files SELECT * FROM files_stage");
        await this.db.run("DELETE FROM files_stage");
      }
      await this.db.run("COMMIT");
    } catch (error) {
      await this.db.run("ROLLBACK").catch(() => {});
      throw error;
    }
  }); }

  /**
   * Drops the calls and file checkpoints of every source whose files were read by another parser version than
   * `versions` names, so the next sweep reads only those sources again. Returns the sources it dropped.
   */
  resetSources(versions: Map<string, string>): Promise<string[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll("SELECT DISTINCT source, parser FROM files");
    const stale = [...new Set(reader.getRowsJS().filter(row => versions.has(String(row[0])) && versions.get(String(row[0])) !== String(row[1])).map(row => String(row[0])))];
    if (!stale.length) return stale;
    await this.db.run("BEGIN TRANSACTION");
    try {
      for (const source of stale) {
        await this.db.run("DELETE FROM calls WHERE source = $s", { s: source });
        await this.db.run("DELETE FROM files WHERE source = $s", { s: source });
      }
      await this.db.run("COMMIT");
    } catch (error) { await this.db.run("ROLLBACK").catch(() => {}); throw error; }
    return stale;
  }); }

  models(): Promise<{ model: string; provider: string | null }[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll("SELECT model, any_value(provider) AS provider FROM calls WHERE model IS NOT NULL GROUP BY model");
    return reader.getRowObjectsJS().map(row => ({ model: String(row.model), provider: row.provider === null ? null : String(row.provider) }));
  }); }

  setPrices(rows: { model: string; matched: string; price: Price }[]): Promise<void> { return this.exclusive(async () => {
    await this.db.run("BEGIN TRANSACTION");
    try {
      await this.db.run("DELETE FROM prices");
      if (rows.length) {
        const appender = await this.db.createAppender("prices");
        for (const row of rows) {
          appender.appendVarchar(row.model); appender.appendVarchar(row.matched);
          for (const n of [row.price.input, row.price.output, row.price.cacheRead, row.price.cacheWrite]) appender.appendDouble(n);
          appender.endRow();
        }
        appender.closeSync();
      }
      await this.db.run("COMMIT");
    } catch (error) { await this.db.run("ROLLBACK").catch(() => {}); throw error; }
  }); }

  /** Calls that ended at or after `since`: tokens per kind per call for the in-memory throughput window. */
  recent(since: number): Promise<({ id: bigint; endedAt: number } & CallTokens)[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll("SELECT id, ended_at, c.input, c.output + c.reasoning, c.cache_read, c.cache_write FROM calls c WHERE ended_at >= $since", { since: BigInt(since) });
    return reader.getRowsJS().map(row => ({ id: row[0] as bigint, endedAt: num(row[1]), input: num(row[2]), output: num(row[3]), cacheRead: num(row[4]), cacheWrite: num(row[5]) }));
  }); }

  /** Tokens per kind since `since` (the 24 h window) and cost since `costSince` (local midnight). */
  totals(since: number, costSince: number): Promise<{ tokens: CallTokens; costToday: number | null }> { return this.exclusive(async () => {
    const kindsSql = "coalesce(sum(c.input), 0), coalesce(sum(c.output + c.reasoning), 0), coalesce(sum(c.cache_read), 0), coalesce(sum(c.cache_write), 0)";
    const kinds = (row: unknown[]): CallTokens => ({ input: num(row[0]), output: num(row[1]), cacheRead: num(row[2]), cacheWrite: num(row[3]) });
    const reader = await this.db.runAndReadAll(`SELECT ${kindsSql}, sum(CASE WHEN c.ended_at >= $costSince THEN ${costSql} END)
      FROM calls c LEFT JOIN prices p ON p.model = c.model WHERE c.ended_at >= $since`, { since: BigInt(Math.min(since, costSince)), costSince: BigInt(costSince) });
    const row = reader.getRowsJS()[0] ?? [];
    // The token sums above include calls since the earlier of the two starts; recount when midnight came first.
    if (costSince < since) {
      const tokens = await this.db.runAndReadAll(`SELECT ${kindsSql} FROM calls c WHERE c.ended_at >= $since`, { since: BigInt(since) });
      return { tokens: kinds(tokens.getRowsJS()[0] ?? []), costToday: numOrNull(row[4]) };
    }
    return { tokens: kinds(row), costToday: numOrNull(row[4]) };
  }); }

  sources(): Promise<{ source: UsageSource; calls: number; firstCallAt: number | null; lastCallAt: number | null }[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll("SELECT source, count(*), min(ended_at), max(ended_at) FROM calls GROUP BY source ORDER BY count(*) DESC");
    return reader.getRowsJS().map(row => ({ source: String(row[0]), calls: num(row[1]), firstCallAt: numOrNull(row[2]), lastCallAt: numOrNull(row[3]) }));
  }); }

  private async windowStart(window: UsageWindow, now: number): Promise<number> {
    if (window !== "all") return now - windowMs[window];
    const reader = await this.db.runAndReadAll("SELECT min(ended_at) FROM calls");
    return numOrNull(reader.getRowsJS()[0]?.[0]) ?? now;
  }

  /**
   * Buckets in local time: `offsetMs` is the local UTC offset, so day buckets start at local midnight. `byKey` carries `metric` per
   * source or model, ranked by it; group "kind" ignores the metric and keys the four token kinds in stack order (KIND_KEYS).
   */
  series(window: UsageWindow, bucket: UsageBucket, group: UsageGroup, metric: UsageMetric, now: number, offsetMs: number): Promise<UsageSeries> { return this.exclusive(async () => {
    const size = bucketMs[bucket];
    const from = await this.windowStart(window, now);
    const first = Math.floor((from + offsetMs) / size), last = Math.floor((now + offsetMs) / size);
    if (last - first + 1 > maxPoints) throw new QueryError(`A ${bucket} bucket over ${window} makes ${last - first + 1} points; the limit is ${maxPoints}. Choose a larger bucket.`);
    const keySql = group === "source" ? "c.source" : group === "model" ? "coalesce(c.model, 'unknown')" : "''";
    const reader = await this.db.runAndReadAll(`SELECT (c.ended_at + $off) // $size AS b, ${keySql} AS k, count(*) AS calls,
      sum(c.input), sum(c.output), sum(c.cache_read), sum(c.cache_write), sum(c.reasoning), sum(${costSql}) AS cost
      FROM calls c LEFT JOIN prices p ON p.model = c.model
      WHERE c.ended_at >= $from AND c.ended_at <= $now GROUP BY ALL`,
      { off: BigInt(offsetMs), size: BigInt(size), from: BigInt(first * size - offsetMs), now: BigInt(now) });
    const rows = reader.getRowsJS().map(row => ({ b: num(row[0]), key: String(row[1]), calls: num(row[2]), input: num(row[3]), output: num(row[4]),
      cacheRead: num(row[5]), cacheWrite: num(row[6]), reasoning: num(row[7]), cost: numOrNull(row[8]) }));
    const measure = (r: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }): number =>
      metric === "total" ? r.input + r.output + r.cacheRead + r.cacheWrite + r.reasoning : metric === "output" ? r.output + r.reasoning : r[metric];
    const keyTotals = new Map<string, number>();
    for (const r of rows) keyTotals.set(r.key, (keyTotals.get(r.key) ?? 0) + measure(r));
    const ranked = [...keyTotals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const keys = group === "none" ? [] : group === "kind" ? [...KIND_KEYS] : ranked.length > 8 ? [...ranked.slice(0, 7), "other"] : ranked;
    const shown = new Set(keys);
    const points = new Map<number, UsageSeries["points"][number]>();
    for (let b = first; b <= last; b++) {
      points.set(b, { t: b * size - offsetMs, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }, costUsd: null, calls: 0, ...(group === "none" ? {} : { byKey: {} }) });
    }
    for (const r of rows) {
      const point = points.get(r.b);
      if (!point) continue;
      const t = point.tokens;
      t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.reasoning += r.reasoning;
      const total = r.input + r.output + r.cacheRead + r.cacheWrite + r.reasoning;
      t.total += total;
      point.calls += r.calls;
      if (r.cost !== null) point.costUsd = (point.costUsd ?? 0) + r.cost;
      if (group === "kind" && point.byKey) {
        point.byKey.output = (point.byKey.output ?? 0) + r.output + r.reasoning;
        point.byKey.input = (point.byKey.input ?? 0) + r.input;
        point.byKey.cacheWrite = (point.byKey.cacheWrite ?? 0) + r.cacheWrite;
        point.byKey.cacheRead = (point.byKey.cacheRead ?? 0) + r.cacheRead;
      } else if (point.byKey) {
        const key = shown.has(r.key) ? r.key : "other";
        point.byKey[key] = (point.byKey[key] ?? 0) + measure(r);
      }
    }
    return { window, bucket, group, metric, keys, points: [...points.values()] };
  }); }

  modelRows(window: UsageWindow, now: number): Promise<UsageModelRow[]> { return this.exclusive(async () => {
    const from = await this.windowStart(window, now);
    const reader = await this.db.runAndReadAll(`SELECT c.source, coalesce(c.model, 'unknown') AS model, count(*), sum(c.input), sum(c.output), sum(c.cache_read),
      sum(c.cache_write), sum(c.reasoning), sum(${costSql}),
      median(CASE WHEN c.started_at IS NOT NULL AND c.output + c.reasoning > 200 AND c.ended_at > c.started_at
        THEN (c.output + c.reasoning) * 1000.0 / (c.ended_at - c.started_at) END)
      FROM calls c LEFT JOIN prices p ON p.model = c.model WHERE c.ended_at >= $from GROUP BY ALL
      ORDER BY sum(${totalSql}) DESC`, { from: BigInt(from) });
    return reader.getRowsJS().map(row => {
      const tokens: UsageTokens = { input: num(row[3]), output: num(row[4]), cacheRead: num(row[5]), cacheWrite: num(row[6]), reasoning: num(row[7]), total: 0 };
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
      return { source: String(row[0]), model: String(row[1]), calls: num(row[2]), tokens, costUsd: numOrNull(row[8]), medianOutputTps: numOrNull(row[9]) };
    });
  }); }

  /** Per source and local day, for cross-checks against tokscale. */
  daily(offsetMs: number): Promise<{ source: string; day: string; calls: number; tokens: UsageTokens }[]> { return this.exclusive(async () => {
    const reader = await this.db.runAndReadAll(`SELECT source, strftime(epoch_ms((ended_at + $off)::BIGINT), '%Y-%m-%d') AS day, count(*),
      sum(input), sum(output), sum(cache_read), sum(cache_write), sum(reasoning) FROM calls GROUP BY ALL ORDER BY day, source`, { off: BigInt(offsetMs) });
    return reader.getRowsJS().map(row => {
      const tokens: UsageTokens = { input: num(row[3]), output: num(row[4]), cacheRead: num(row[5]), cacheWrite: num(row[6]), reasoning: num(row[7]), total: 0 };
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
      return { source: String(row[0]), day: String(row[1]), calls: num(row[2]), tokens };
    });
  }); }
}
