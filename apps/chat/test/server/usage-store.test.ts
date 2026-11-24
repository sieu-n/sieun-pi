/**
 * api/usage from the usage store (server/usage-store.ts) against a real ClickHouse: each test makes its own database from
 * components/usage-collector/schema.sql on the ClickHouse at USAGE_STORE_TEST_URL (default the shared rig, ~/work/usage-one-source/rig.md),
 * and drops it after. With no ClickHouse there, the tests skip.
 * Run from the repo root: node apps/chat/scripts/spec-clean.mjs --files <changed files> -- node --test --test-force-exit test/server/usage-store.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { join } from "node:path";
import type { Threads } from "../../server/threads.ts";
import { clickhouseReader, grafanaReader, StoreUsage, type Columns } from "../../server/usage-store.ts";
import { usageLive, usageReport } from "../../server/usage.ts";
import { fromColumns, toColumns, type UsageReportWire } from "../../web/src/lib/api/shared/usage-columns.ts";
import type { UsageReport } from "../../web/src/lib/api/types.ts";

const URL_ = process.env.USAGE_STORE_TEST_URL ?? "http://127.0.0.1:18123/";
const DB = `usage_read_test_${process.pid}`;
const TABLE = `${DB}.model_calls`;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;

async function ch(sql: string, body?: string): Promise<string> {
  const response = await fetch(`${URL_}?query=${encodeURIComponent(sql)}`, { method: "POST", ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text;
}
const reachable = await fetch(`${URL_}ping`).then(r => r.ok, () => false);
const skip = reachable ? false : `no ClickHouse at ${URL_}`;

before(async () => {
  if (!reachable) return;
  // A spec-clean run loads this file from a release folder, which holds apps/chat only, so the schema comes from the checkout then.
  const schemaPath = [join(import.meta.dirname, "../../../../components/usage-collector/schema.sql"), join(homedir(), "src/sieun-pi/components/usage-collector/schema.sql")].find(existsSync)!;
  const text = readFileSync(schemaPath, "utf8");
  const database = /CREATE DATABASE IF NOT EXISTS (\w+)/.exec(text)![1]!;
  const schema = text.replaceAll(`${database}.`, `${DB}.`).replace(/^CREATE DATABASE.*$/m, "");
  await ch(`CREATE DATABASE ${DB}`);
  for (const statement of schema.replace(/--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) await ch(statement);
});
after(async () => {
  if (reachable) await ch(`DROP DATABASE IF EXISTS ${DB}`);
});

type Call = { source_key: string; call_at: number; host: string; client: string; agent: string; thread: string; thread_name: string; session: string; model: string;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_input_usd: string; cost_output_usd: string;
  cost_cache_read_usd: string; cost_cache_write_usd: string; cost_source: string };

const NOW = Date.UTC(2026, 10, 23, 22, 37, 41, 512);
const HOSTS = ["us-metal02", "mbp"], CLIENTS = ["pi-host", "prime", "claude-code", "codex", "hermes"], MODELS = ["anthropic/claude-opus-5-5", "openai/gpt-5.5"];

/** Calls spread over 95 days before NOW, denser in the last day and the last 15 min; a claude-code or codex call names only a session. */
function calls(count: number, seed: number): Call[] {
  let x = seed;
  const rand = () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  return Array.from({ length: count }, (_, i) => {
    const span = i % 3 === 0 ? 95 * DAY : i % 3 === 1 ? DAY : 15 * MIN;
    const client = CLIENTS[i % CLIENTS.length]!;
    const threadless = client === "claude-code" || client === "codex";
    const unpriced = client === "codex" && i % 9 === 0;
    const cost = (n: number) => (unpriced ? "0" : (Math.round(rand() * 1e9 * n) / 1e9).toFixed(9));
    return {
      source_key: `${client}:${seed}:${i}`, call_at: Math.floor(NOW - rand() * span), host: HOSTS[i % 2]!, client, agent: i % 5 === 0 ? "agent factory" : "",
      thread: threadless ? "" : `t${i % 7}`, thread_name: threadless ? "" : `thread ${i % 7}`, session: `s${i % 211}`, model: MODELS[i % 2]!,
      input_tokens: 1 + Math.floor(rand() * 5000), output_tokens: Math.floor(rand() * 900), cache_read_tokens: Math.floor(rand() * 90_000),
      cache_write_tokens: Math.floor(rand() * 9000), cost_input_usd: cost(0.02), cost_output_usd: cost(0.05), cost_cache_read_usd: cost(0.03), cost_cache_write_usd: unpriced ? "0" : cost(0.04), cost_source: unpriced ? "unpriced:test" : "reported",
    };
  });
}

const insert = (rows: Call[]) =>
  ch(`INSERT INTO ${TABLE} (source_key, call_at, host, client, agent, thread, thread_name, session, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd, cost_source) FORMAT JSONEachRow`,
    rows.map(row => JSON.stringify({ ...row, call_at: new Date(row.call_at).toISOString().replace("T", " ").replace("Z", ""), provider: row.model.split("/")[0] })).join("\n"));

const SUMS = `toFloat64(count()) AS turns, toFloat64(sum(input_tokens)) AS input, toFloat64(sum(output_tokens)) AS output, toFloat64(sum(cache_read_tokens)) AS cache_read,
  toFloat64(sum(cache_write_tokens)) AS cache_write, toFloat64(sum(cost_input_usd)) AS cost_input, toFloat64(sum(cost_output_usd)) AS cost_output,
  toFloat64(sum(cost_cache_read_usd)) AS cost_cache_read, toFloat64(sum(cost_cache_write_usd)) AS cost_cache_write, toFloat64(sum(cost_usd)) AS cost,
  toFloat64(countIf(startsWith(cost_source, 'unpriced'))) AS unpriced`;
const ms = (at: number) => `fromUnixTimestamp64Milli(toInt64(${at}))`;
async function query(sql: string): Promise<Record<string, number>[]> {
  const text = await ch(`${sql} FORMAT JSONEachRow`);
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, number>);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const totalsOf = (report: UsageReport) => {
  const t = { turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost_input: 0, cost_output: 0, cost_cache_read: 0, cost_cache_write: 0, cost: 0, unpriced: 0 };
  for (const row of report.rows) {
    t.unpriced += row.unpriced;
    t.turns += row.turns; t.input += row.tokens.input; t.output += row.tokens.output; t.cache_read += row.tokens.cacheRead; t.cache_write += row.tokens.cacheWrite;
    t.cost_input += row.cost.input; t.cost_output += row.cost.output; t.cost_cache_read += row.cost.cacheRead; t.cost_cache_write += row.cost.cacheWrite; t.cost += row.cost.total;
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v)]));
};
async function storeTotals(since: number, until: number) {
  const [row] = await query(`SELECT ${SUMS} FROM ${TABLE} FINAL WHERE call_at >= ${ms(since)} AND call_at < ${ms(until)}`);
  return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, round(v)]));
}
/** The store's own buckets in Seoul time, as its read queries bucket them (store.md section 6). */
async function storeBuckets(bucket: "minute" | "hour" | "day", since: number, until: number) {
  const start = bucket === "day" ? "toStartOfDay(call_at, 'Asia/Seoul')" : bucket === "hour" ? "toStartOfHour(call_at, 'Asia/Seoul')" : "toStartOfMinute(call_at, 'Asia/Seoul')";
  const rows = await query(`SELECT toFloat64(toUnixTimestamp(${start})) * 1000 AS start, ${SUMS} FROM ${TABLE} FINAL WHERE call_at >= ${ms(since)} AND call_at < ${ms(until)} GROUP BY start ORDER BY start`);
  return rows.map(r => [r.start!, r.turns!, r.input! + r.output! + r.cache_read! + r.cache_write!, round(r.cost!)]);
}
const reportBuckets = (report: UsageReport) =>
  report.buckets.filter(b => b.turns).map(b => [b.start, b.turns, b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite, round(b.cost.total)]);

const CASES = [["1h", "minute"], ["24h", "hour"], ["24h", "minute"], ["7d", "hour"], ["7d", "day"], ["30d", "day"], ["30d", "hour"], ["90d", "day"]] as const;

test("the kept sums equal the store's own sums for every range, and each minute, hour and day bucket equals ClickHouse's Asia/Seoul bucket", { skip }, async () => {
  await insert(calls(6000, 7));
  const store = new StoreUsage(clickhouseReader({ transport: "clickhouse", url: URL_, table: TABLE }), TABLE, () => {}, () => NOW);
  for (const [range, bucket] of CASES) {
    const report = await usageReport(store, threads, { range, bucket }, NOW);
    assert.deepEqual(totalsOf(report), await storeTotals(report.since, report.until), `${range} by ${bucket} totals`);
    assert.deepEqual(reportBuckets(report), await storeBuckets(bucket, report.since, report.until), `${range} by ${bucket} buckets`);
  }
  const day = await usageReport(store, threads, { range: "24h" }, NOW);
  assert.deepEqual([...new Set(day.rows.map(r => r.client))].sort(), [...CLIENTS].sort(), "every client is its own row");
  assert.ok(day.rows.some(r => r.agent === "agent factory"));
  const codex = day.rows.filter(r => r.client === "codex" && r.thread);
  assert.ok(codex.length && codex.every(r => /^s\d+$/.test(r.thread) && r.threadName === r.thread), "a client with no threads names its session as the thread");
  const chats = new Set(day.rows.filter(r => r.thread).map(r => `${r.host} ${r.client} ${r.agent} ${r.thread}`));
  assert.equal(chats.size, 50, "the 50 costliest chats keep their own rows");
  assert.ok(day.otherChats > 0 && day.rows.some(r => !r.thread), "every other chat folds into a row with no thread, and the totals above stay exact");
  assert.ok(day.rows.some(r => r.unpriced > 0) && day.buckets.some(b => b.unpriced > 0), "unpriced calls are counted apart, not as free");
  const byClient = await usageReport(store, threads, { range: "24h", client: "codex" }, NOW);
  assert.ok(byClient.rows.length && byClient.rows.every(r => r.client === "codex"), "the client filter keeps one client's rows");
  const split = await usageReport(store, threads, { range: "24h", split: "client" }, NOW);
  const clientCost = new Map<string, number>();
  for (const r of day.rows) clientCost.set(r.client, (clientCost.get(r.client) ?? 0) + r.cost.total);
  const costliest = [...clientCost].sort((a, b) => b[1] - a[1]);
  const columnSum = (values: number[]) => round(values.reduce((sum, n) => sum + n, 0));
  assert.deepEqual(split.series.map(line => [line.key, columnSum(line.cost)]),
    [...costliest.slice(0, 3).map(([client, usd]) => [client, round(usd)]), ["Other", round(costliest.slice(3).reduce((sum, [, usd]) => sum + usd, 0))]],
    "the client split sends the 3 costliest clients' columns and one Other for the rest");
  assert.equal(split.series.at(-1)!.others, CLIENTS.length - 3);
  assert.deepEqual(split.buckets.map((b, i) => round(split.series.reduce((sum, line) => sum + line.tokens[i]!, 0))), split.buckets.map(b => round(b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite)),
    "each bucket's columns sum to its tokens");
  const wire = JSON.parse(JSON.stringify(toColumns(split))) as UsageReportWire;
  assert.deepEqual(fromColumns(wire), split, "the answer's columns give back every bucket");
  assert.ok(day.rows.filter(r => r.client === "prime" && r.thread).every(r => r.threadName === `thread ${r.thread.slice(1)}`), "a thread this chat does not list keeps the store's name");
  const mbp = await usageReport(store, threads, { range: "24h", host: "mbp" }, NOW);
  assert.ok(mbp.rows.length && mbp.rows.every(r => r.host === "mbp"));
  const one = await usageReport(store, threads, { range: "7d", thread: "s3" }, NOW);
  assert.deepEqual(totalsOf(one), await query(`SELECT ${SUMS} FROM ${TABLE} FINAL WHERE call_at >= ${ms(one.since)} AND call_at < ${ms(one.until)} AND thread = '' AND session = 's3'`)
    .then(([row]) => Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, round(v)]))), "a session-only thread filters like a thread");
  const live = await usageLive(store, {}, NOW);
  const at = Math.floor(NOW / 10_000) * 10_000;
  const [lastMinute] = await query(`SELECT toFloat64(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)) AS total FROM ${TABLE} FINAL WHERE call_at >= ${ms(at - MIN)} AND call_at < ${ms(at)}`);
  assert.equal(round(live.perSecond.total), round(lastMinute!.total! / 60), "the live rate is the last minute's tokens over 60 s");
});

test("a resent or repriced row never counts twice: a tail read replaces the last minutes, a full read every bucket", { skip }, async () => {
  await ch(`TRUNCATE TABLE ${TABLE}`);
  const rows = calls(3000, 11);
  await insert(rows);
  let now = NOW;
  let full = 0;
  const store = new StoreUsage(clickhouseReader({ transport: "clickhouse", url: URL_, table: TABLE }), TABLE, line => { if (line.includes("full read")) full++; }, () => now, 10 * MIN);
  await store.pull();
  const before90 = await usageReport(store, threads, { range: "90d" }, now);
  assert.deepEqual(totalsOf(before90), await storeTotals(before90.since, before90.until));

  // Every row again in another block, so ClickHouse's block dedup drops none; one recent row and one old row repriced.
  const recent = rows.find(row => row.call_at > NOW - 5 * MIN)!;
  const old = rows.find(row => row.call_at < NOW - 30 * DAY)!;
  await insert([...rows].reverse().map(row => (row === recent || row === old ? { ...row, cost_output_usd: "7.000000000" } : row)));
  now += 2_000;
  await store.pull();
  assert.equal(full, 1, "the second pull is a tail read");
  const tail = await usageReport(store, threads, { range: "1h", bucket: "minute" }, now);
  assert.deepEqual(totalsOf(tail), await storeTotals(tail.since, tail.until), "the last hour, resent and repriced, counts each call once at its new cost");
  const stale = await usageReport(store, threads, { range: "90d" }, now);
  assert.equal(totalsOf(stale).turns, totalsOf(before90).turns, "a resent row adds no turn");
  assert.ok(Math.abs(totalsOf(stale).cost! - totalsOf(before90).cost! - (7 - Number(recent.cost_output_usd))) < 1e-5, "an old repricing waits for the full read");

  now += 10 * MIN;
  await store.pull();
  assert.equal(full, 2);
  const after90 = await usageReport(store, threads, { range: "90d" }, now);
  assert.deepEqual(totalsOf(after90), await storeTotals(after90.since, after90.until), "the full read takes the old repricing");
  assert.equal(totalsOf(after90).turns, totalsOf(before90).turns);
});

test("the Grafana transport reads the same sums as ClickHouse HTTP, from Grafana's column frames", { skip }, async () => {
  await ch(`TRUNCATE TABLE ${TABLE}`);
  await insert(calls(500, 13));
  const asked: string[] = [];
  const grafana: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      asked.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      const { queries } = JSON.parse(body) as { queries: { rawSql: string; datasource: { uid: string } }[] };
      const columns = JSON.parse(await ch(`${queries[0]!.rawSql}\nFORMAT JSONColumns`)) as Columns;
      const fields = Object.keys(columns).map(name => ({ name, type: "number" }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: { A: { status: 200, frames: [{ schema: { refId: "A", fields }, data: { values: Object.values(columns) } }] } } }));
    });
  });
  await new Promise<void>(resolve => grafana.listen(0, "127.0.0.1", resolve));
  const port = (grafana.address() as { port: number }).port;
  const tokenFile = join(process.env.TMPDIR ?? "/tmp", `grafana-token-${process.pid}.json`);
  const { writeFileSync, rmSync } = await import("node:fs");
  writeFileSync(tokenFile, JSON.stringify({ token: "viewer-token" }));
  try {
    const viaGrafana = new StoreUsage(grafanaReader({ transport: "grafana", url: `http://127.0.0.1:${port}/`, table: TABLE, datasource: "usage_ch", tokenFile, tokenKey: "token" }), TABLE, () => {}, () => NOW);
    const direct = new StoreUsage(clickhouseReader({ transport: "clickhouse", url: URL_, table: TABLE }), TABLE, () => {}, () => NOW);
    for (const [range, bucket] of CASES) {
      assert.deepEqual(await usageReport(viaGrafana, threads, { range, bucket }, NOW), await usageReport(direct, threads, { range, bucket }, NOW));
    }
    assert.equal(asked[0], "POST /api/ds/query Bearer viewer-token");
  } finally {
    grafana.close();
    rmSync(tokenFile, { force: true });
  }
});

test("before the store first answers a call waits for that read, and a store that never answered fails the call with its error", async () => {
  let answer: (columns: Columns) => void = () => {};
  let reads = 0;
  const store = new StoreUsage({ query: () => (reads++, new Promise<Columns>(resolve => (answer = resolve))) }, "t", () => {}, () => NOW);
  const range = { since: NOW - (NOW % HOUR) - HOUR, until: NOW - (NOW % HOUR) + HOUR, bucketMs: HOUR };
  const first = store.usage(range);
  const second = store.usage(range);
  assert.equal(reads, 1, "two calls before the first read share it");
  answer({ grain: [] });
  assert.deepEqual([await first, await second], [[], []]);
  const down = new StoreUsage({ query: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:18123"); } }, "t", () => {}, () => NOW);
  await assert.rejects(down.usage(range), /ECONNREFUSED/);
  await assert.rejects(store.usage({ since: range.since + 1, until: range.until, bucketMs: HOUR }), RangeError);
});

test("a failed read keeps the last sums and marks them stale, logged once, and the next good read clears it", async () => {
  const hour = NOW - (NOW % HOUR);
  const columns: Columns = {
    grain: ["hour"], bucket: [hour], host: ["us-metal02"], client: ["prime"], agent: [""], thread_or_session: ["t1"], thread_name: [""], model: ["m"],
    turns: [3], input: [10], output: [20], cache_read: [0], cache_write: [0], cost_input: [1], cost_output: [2], cost_cache_read: [0], cost_cache_write: [0], unpriced: [0],
  };
  let fail = false;
  let now = NOW;
  const lines: string[] = [];
  const reader = { query: async () => { if (fail) throw new Error("Code: 497. DB::Exception: grafana_ro: Not enough privileges. (ACCESS_DENIED)"); return columns; } };
  const store = new StoreUsage(reader, "t", line => lines.push(line), () => now);
  await store.pull();
  const good = await usageReport(store, threads, { range: "24h" }, now);
  assert.equal(good.rows[0]!.cost.total, 3);
  assert.equal(good.staleSince, undefined);

  fail = true;
  now += 2_000;
  await store.pull();
  now += 2_000;
  await store.pull();
  const stale = await usageReport(store, threads, { range: "24h" }, now);
  assert.equal(stale.rows[0]!.cost.total, 3, "the last good sums stay");
  assert.equal(stale.staleSince, NOW, "the report says when the sums were read");
  assert.equal((await usageLive(store, {}, now)).staleSince, NOW, "the live rate says it is unknown, not 0");
  assert.equal(lines.filter(line => line.includes("stopped answering")).length, 1, "the failure is logged once, not at each pull");
  assert.match(lines.at(-1)!, /Code: 497/);

  fail = false;
  now += 2_000;
  await store.pull();
  assert.equal((await usageReport(store, threads, { range: "24h" }, now)).staleSince, undefined);
  assert.equal(lines.at(-1), "usage: the store answers again");

  fail = true;
  const fresh = new StoreUsage(reader, "t", line => lines.push(line), () => now);
  await assert.rejects(fresh.usage({ since: hour, until: hour + HOUR, bucketMs: HOUR }), /the store is not reachable: Code: 497/);
  fail = false;
  await fresh.pull();
  assert.equal((await fresh.usage({ since: hour, until: hour + HOUR, bucketMs: HOUR }))[0]!.cost, 3, "a failed first read keeps retrying");
});

test("a server starts from the snapshot the last one wrote, and its first read is a tail read, so no call waits for a full read", async () => {
  const hour = NOW - (NOW % HOUR);
  const columns: Columns = {
    grain: ["hour"], bucket: [hour], host: ["us-metal02"], client: ["prime"], agent: [""], thread_or_session: ["t1"], thread_name: [""], model: ["m"],
    turns: [3], input: [10], output: [20], cache_read: [0], cache_write: [0], cost_input: [1], cost_output: [2], cost_cache_read: [0], cost_cache_write: [0], unpriced: [0],
  };
  const snapshot = join(mkdtempSync(join(tmpdir(), "usage-snapshot-")), "usage-sums.json");
  let now = NOW;
  const asked: string[] = [];
  const reader = { query: async (sql: string) => (asked.push(sql), columns) };
  const first = new StoreUsage(reader, "t", () => {}, () => now, 600_000, snapshot);
  await first.pull();
  assert.match(asked[0]!, /FINAL/, "the first server's first read is a full read");
  first.stop();
  now += 60_000;
  const lines: string[] = [];
  const next = new StoreUsage(reader, "t", line => lines.push(line), () => now, 600_000, snapshot);
  const report = await usageReport(next, threads, { range: "24h" }, now);
  assert.doesNotMatch(asked[1]!, /FINAL/, "the next server's first read is a tail read");
  assert.equal(report.rows[0]!.cost.total, 3);
  assert.match(lines[0]!, /read the kept sums of/);

  next.stop();
  now += 3_000;
  let reads = 0;
  const slow = { query: (sql: string) => (reads++, asked.push(sql), new Promise<Columns>(() => {})) };
  const handOver = new StoreUsage(slow, "t", () => {}, () => now, 600_000, snapshot);
  void handOver.pull();
  assert.equal((await handOver.usage({ since: hour, until: hour + HOUR, bucketMs: HOUR }))[0]!.cost, 3, "a snapshot written seconds ago answers before the tail read lands");
  assert.equal(reads, 1, "the tail read went out and has not answered");

  now += 11 * 60_000;
  const late = new StoreUsage(reader, "t", () => {}, () => now, 600_000, snapshot);
  await late.pull();
  assert.match(asked.at(-1)!, /FINAL/, "a snapshot older than the tail read's span is left, and the first read is a full read");
});
