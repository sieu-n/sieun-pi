// Owner 11-24 (msg mwtu2ny5, mwtu3137): Settings > Usage loads every host's and client's calls from the ClickHouse store, and its chart matches sw factory's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Columns, StoreReader } from "../src/usage/store-sums.ts";
import { seoulMidnight, TABLE, Usage, windowRange } from "../src/usage/store.ts";

type Call = { at: number; host: string; client: string; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };

/**
 * A ClickHouse that answers sw factory's pull SQL (apps/chat/server/usage-store.ts pullSql) from `calls`: each grain's buckets from that
 * grain's own `from` on, summed by bucket, host, client and model, the way the SQL groups them.
 */
function store(calls: Call[]): StoreReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async query(sql) {
      asked.push(sql);
      const grains = [...sql.matchAll(/\('(hour|minute|tick)', (\d+), (-?\d+)\)/g)].map(m => ({ grain: m[1]!, ms: Number(m[2]), from: Number(m[3]) }));
      const sums = new Map<string, Record<string, string | number>>();
      for (const call of calls) for (const g of grains) {
        if (call.at < g.from) continue;
        const bucket = Math.floor(call.at / g.ms) * g.ms;
        const key = [g.grain, bucket, call.host, call.client, call.model].join("|");
        let row = sums.get(key);
        if (!row) sums.set(key, row = { grain: g.grain, bucket, host: call.host, client: call.client, agent: "", thread_or_session: "s", thread_name: "", model: call.model, turns: 0,
          input: 0, output: 0, cache_read: 0, cache_write: 0, cost_input: 0, cost_output: 0, cost_cache_read: 0, cost_cache_write: 0, unpriced: 0 });
        const add = (name: string, value: number) => { row![name] = Number(row![name]) + value; };
        add("turns", 1); add("input", call.input); add("output", call.output); add("cache_read", call.cacheRead ?? 0); add("cache_write", call.cacheWrite ?? 0);
        add("cost_output", call.cost ?? 0);
      }
      const rows = [...sums.values()];
      const names = ["grain", "bucket", "host", "client", "agent", "thread_or_session", "thread_name", "model", "turns", "input", "output", "cache_read", "cache_write",
        "cost_input", "cost_output", "cost_cache_read", "cost_cache_write", "unpriced"];
      return Object.fromEntries(names.map(name => [name, rows.map(row => row[name])])) as Columns;
    },
  };
}

const H = 3_600_000;
// 11-24 05:30 KST is 11-23 20:30 UTC, so Seoul's day began at 11-23 15:00 UTC.
const now = Date.parse("2026-11-23T20:30:10Z");

test("the store is read with sw factory's SQL on ai_usage.model_calls with FINAL", async () => {
  const reader = store([]);
  await new Usage(() => reader, () => now).models("24h");
  assert.match(reader.asked[0]!, new RegExp(`FROM ${TABLE.replace(".", "\\.")} FINAL`));
});

test("a range is whole buckets ending with the one that holds now, and a day starts at Seoul midnight on a box in UTC", () => {
  assert.deepEqual(windowRange("24h", "hour", now), { bucket: "hour", since: Date.parse("2026-11-22T21:00:00Z"), until: Date.parse("2026-11-23T21:00:00Z"), step: H });
  const days = windowRange("90d", "day", now);
  assert.equal(days.until, Date.parse("2026-11-24T15:00:00Z"));
  assert.equal(days.until - days.since, 90 * 24 * H);
  assert.equal(seoulMidnight(now), Date.parse("2026-11-23T15:00:00Z"));
  assert.equal(windowRange("30d", "minute", now).bucket, "day", "a bucket the window does not offer reads as its default");
});

test("the chart, the table and the headline sum every host and client of the store", async () => {
  const calls: Call[] = [
    { at: now - 20_000, host: "us-metal02", client: "prime", model: "claude-opus-5-5", input: 10, output: 600, cacheRead: 1000, cost: 0.5 },
    { at: now - 25_000, host: "mbp", client: "codex", model: "gpt-6", input: 5, output: 1200, cost: 0.25 },
    { at: now - 2 * H, host: "us-metal02", client: "pi-host", model: "claude-opus-5-5", input: 1, output: 100, cost: 1 },
    // Before Seoul midnight: in the 24h chart and the day's tokens, not in Cost today.
    { at: Date.parse("2026-11-23T14:59:00Z"), host: "us-metal02", client: "claude-code", model: "claude-opus-5-5", input: 0, output: 50, cost: 2 },
  ];
  const usage = new Usage(() => store(calls), () => now);
  try {
    const series = await usage.series("24h", "hour", "client", "output");
    assert.equal(series.since, Date.parse("2026-11-22T21:00:00Z"));
    assert.equal(series.points.reduce((sum, p) => sum + p.tokens.output, 0), 1950);
    assert.equal(series.points.reduce((sum, p) => sum + p.calls, 0), 4);
    assert.deepEqual(series.keys, ["codex", "prime", "pi-host", "claude-code"]);
    const last = series.points.at(-1)!;
    assert.equal(last.t, Date.parse("2026-11-23T20:00:00Z"));
    assert.deepEqual(last.byKey, { prime: 600, codex: 1200 });

    const { models } = await usage.models("24h", "hour");
    assert.equal(models.length, 4);
    assert.deepEqual(models.find(row => row.client === "codex"), { box: "mbp", client: "codex", model: "gpt-6", calls: 1, tokens: { input: 5, output: 1200, cacheRead: 0, cacheWrite: 0, total: 1205 }, costUsd: 0.25 });

    const summary = await usage.summary();
    assert.equal(summary.costToday, 1.75);
    assert.equal(summary.perDay.output, 1950);
    // Both calls of the last minute sit in the minute that ends on the 10 s tick before now: 1,800 output tokens over 60 s.
    assert.equal(summary.perSecond.output, 30);
    assert.equal(summary.spark.output.length, 61);
    assert.equal(summary.sparkMinutes.output.length, 61);
    assert.equal(summary.sparkMinutes.output.at(-2), 1800, "the calls of 20:29:45 and 20:29:50 UTC sit in the minute before the one holding now");
  } finally { usage.close(); }
});

test("a store that never answered reaches the feed as its error, never as zeros", async () => {
  const usage = new Usage(() => ({ query: async () => { throw new Error("grafana 502: bad gateway"); } }), () => now);
  const reading = await usage.reading();
  assert.equal(reading.state, "error");
  assert.match(reading.state === "error" ? reading.error : "", /grafana 502/);
  usage.close();
});

test("a failed read keeps the last sums and marks them stale, logged once, and the next good read clears it", async () => {
  const calls: Call[] = [{ at: now - 30 * 60_000, host: "us-metal02", client: "prime", model: "m", input: 10, output: 20, cost: 3 }];
  const good = store(calls);
  let fail = false;
  const lines: string[] = [];
  let clock = now;
  const usage = new Usage(() => ({ query: async sql => { if (fail) throw new Error("Code: 497. DB::Exception: grafana_ro: Not enough privileges. (ACCESS_DENIED)"); return good.query(sql); } }), () => clock, line => lines.push(line));
  try {
    const first = await usage.series("24h", "hour", "none");
    assert.equal(first.staleSince, undefined);
    fail = true;
    clock += 2_000;
    const stale = await usage.series("24h", "hour", "none");
    assert.deepEqual(stale.points.map(p => p.tokens.output), first.points.map(p => p.tokens.output), "the last good sums stay");
    assert.equal(stale.staleSince, now, "the reading says when the sums were read");
    const summary = await usage.reading();
    assert.equal(summary.state === "live" ? summary.staleSince : null, now, "the headline says it too, so the rate reads as unknown");
    assert.equal(lines.filter(line => line.includes("stopped answering")).length, 1, "the failure is logged once, not at each read");
    assert.match(lines.find(line => line.includes("stopped answering"))!, /Code: 497/);
    fail = false;
    clock += 2_000;
    assert.equal((await usage.series("24h", "hour", "none")).staleSince, undefined);
    assert.equal(lines.at(-1), "usage: the store answers again");
  } finally { usage.close(); }
});

test("a missing Grafana token is a 503 on the page, not a failed chat start", async () => {
  const usage = new Usage(() => { throw new Error("ENOENT: grafana-alerts.json"); }, () => now);
  await assert.rejects(usage.models("24h"), (error: Error & { status?: number }) => error.status === 503);
});

test("the copied reader runs sw factory's SQL word for word", () => {
  const ours = readFileSync(new URL("../src/usage/store-sums.ts", import.meta.url), "utf8");
  const theirs = readFileSync(new URL("../../../../apps/chat/server/usage-store.ts", import.meta.url), "utf8");
  const sql = (text: string) => ["const CALL_COLUMNS = `[^`]*`;", "function callsFrom\\([\\s\\S]*?\\n}\\n", "export function pullSql\\([\\s\\S]*?\\n}\\n"]
    .map(pattern => new RegExp(pattern).exec(text)?.[0].replace(/^\s*\/\/.*\n/gm, "") ?? `no match for ${pattern}`);
  assert.deepEqual(sql(ours), sql(theirs), "apps/chat/server/usage-store.ts changed its SQL: copy the change into src/usage/store-sums.ts");
});
