// Owner 10-10 (c41): "the cache read ratio of hour/day should stay high". On 10-19 no box sent Prime's counters and both shares read 100.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureCache, MIN_CALLS, WINDOWS, type CacheMetric } from "../scripts/duties/cache-ratio.ts";
import { measureHarness } from "../scripts/duties/harness-health.ts";
import { withHarness } from "../scripts/duties/skills-and-tools.ts";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import { createServer } from "node:http";
import { grafanaOtel, type Otel, type Row, type Sample } from "../src/usage/otel.ts";

const duty = JSON.parse(readFileSync(new URL("../scripts/duties/skills-and-tools.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };
const targets = Object.fromEntries(Object.keys(WINDOWS).map(key => [key, duty.metrics.find(metric => metric.key === key)!.target])) as Record<CacheMetric, number>;
const keys = Object.keys(WINDOWS) as CacheMetric[];
const tools = { metrics: { checks_failed: 0, owner_fixes: 0 }, flagged: [] };

/** The span a minute query of cache-ratio.ts asks: its first minute's end (`start`) and its last (`end`). */
const spanOf = (sql: string): { start: number; end: number } =>
  ({ start: Number(/toUnixTimestamp\(TimeUnix\) \* 1000 - (\d+)\)/.exec(sql)![1]), end: Number(/TimeUnix <= fromUnixTimestamp64Milli\(toInt64\((\d+)\)\)/.exec(sql)![1]) });
/** Each minute index of `sql`'s span whose end `keep` takes, with its value. */
const minutes = (sql: string, value: (at: number) => number | null): Row[] => {
  const { start, end } = spanOf(sql);
  return Array.from({ length: Math.round((end - start) / 60_000) + 1 }, (_, minute) => ({ minute, value: value(start + minute * 60_000) })).filter(row => row.value !== null);
};
/**
 * An otel that answers token queries with `tokens` and call queries with `calls` finished calls (and `errors` failed ones). The minute queries
 * answer that otel heard a box in every minute `heard` keeps, and that pi-pool had `usable(at)` Claude accounts.
 */
type Feed = { heard?: (at: number) => boolean; usable?: (at: number) => number; errors?: number };
const otel = (tokens: Sample[], calls: number, { heard = () => true, usable = () => 30, errors = 0 }: Feed = {}): Otel => ({
  rows: async sql => sql.includes("provider_usable_accounts") ? minutes(sql, at => heard(at) ? usable(at) : null)
    : sql.includes("AS minute FROM") ? minutes(sql, at => heard(at) ? 1 : null)
    : sql.includes("stop_reason") ? [...calls ? [{ provider: "anthropic", stop_reason: "stop", value: calls }] : [], ...errors ? [{ provider: "anthropic", stop_reason: "error", value: errors }] : []]
    : tokens.map(sample => ({ ...sample.labels, value: sample.value })),
});
const warm: Sample[] = [
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "input" }, value: 1_000 },
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "cache_read" }, value: 98_000 },
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "cache_write" }, value: 1_000 },
];

test("a window with no Prime series while the box still reports is a miss with the reason no data", async () => {
  const cache = await measureCache(otel([], 0), targets);
  for (const key of keys) {
    assert.ok(cache.metrics[key]! < targets[key], `${key} reads ${cache.metrics[key]}, which meets its target on no data`);
    assert.match(cache.flagged.find(slice => slice.kind === key)!.excerpt, /^no data: /);
  }
  const verdict = judge(duty.metrics, withHarness(tools, { metrics: { skills_to_prune: 0, ...cache.metrics }, flagged: cache.flagged }));
  assert.equal(verdict.verdict, "missed");
  for (const key of keys) assert.equal(verdict.metrics[key]!.met, false);
});

test("a window with fewer than MIN_CALLS calls is a miss even when its share is high", async () => {
  const cache = await measureCache(otel(warm, MIN_CALLS - 1), targets);
  for (const key of keys) {
    assert.ok(cache.metrics[key]! < targets[key]);
    assert.match(cache.flagged.find(slice => slice.kind === key)!.excerpt, /^no data: 19 calls/);
  }
});

test("a window with enough calls reads its share", async () => {
  const cache = await measureCache(otel(warm, MIN_CALLS), targets);
  for (const key of keys) assert.equal(cache.metrics[key], 98);
  assert.deepEqual(cache.flagged, []);
});

// On 10-28 at 18:50Z a staging deploy recreated the staging Prometheus that held these counters, Grafana answered HTTP 502, and both shares read 0.
test("an otel 502 leaves both shares unmeasured, with the reason, and never 0", async () => {
  const server = createServer((_req, res) => { res.statusCode = 502; res.end(""); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const config = join(mkdtempSync(join(tmpdir(), "cache-no-data-")), "grafana-alerts.json");
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "viewer" }));
  const cache = await measureCache(grafanaOtel(config), targets).finally(() => server.close());
  assert.deepEqual(cache.metrics, {});
  for (const key of keys) assert.match(cache.flagged.find(slice => slice.excerpt.startsWith(key))!.excerpt, /not measured: otel did not answer: otel query failed: grafana 502/);
  const verdict = judge(duty.metrics, withHarness(tools, { metrics: { skills_to_prune: 0, ...cache.metrics }, flagged: cache.flagged }));
  assert.equal(verdict.verdict, "error", "an unmeasured metric never counts as met");
  for (const key of keys) assert.equal(verdict.metrics[key], undefined);
  assert.match(verdict.summary, /not measured: the precheck gave no value for cache_read_ratio_1h, cache_read_ratio_24h \(cache_read_ratio_1h not measured: otel did not answer/);
});

// On 10-29 at 03:25Z the staging Prometheus timed out on connect, and asking each window again took the d10 precheck to 559 s.
test("an unreachable otel is asked once, and every window gets its error", async () => {
  let asked = 0;
  const unreachable: Otel = { rows: async () => { asked += 1; throw new Error("otel query failed: fetch failed (ETIMEDOUT)"); } };
  const cache = await measureCache(unreachable, targets);
  assert.equal(asked, 2, "only the first window's two queries go out");
  assert.deepEqual(cache.metrics, {});
  for (const key of keys) assert.match(cache.flagged.find(slice => slice.excerpt.startsWith(key))!.excerpt, /not measured: otel did not answer: otel query failed: fetch failed \(ETIMEDOUT\)/);
});

test("a cache check that throws leaves both shares out of the harness output", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cache-no-data-"));
  const output = await measureHarness({ roots: [], views: async () => [], dataDir, now: Date.parse("2026-10-19T15:30:00Z"),
    cache: () => Promise.reject(new Error("otel unreachable")), history: async () => ({ owner: [], refines: [] }), commitTime: async () => undefined, harnessFixes: new Map(), transcripts: async () => [], added: async () => undefined, smoke: { python: "python3" } });
  for (const key of keys) assert.equal(key in output.metrics, false);
  assert.match(output.flagged!.find(slice => slice.kind === "source_error")!.excerpt, /^cache_read_ratio_1h and cache_read_ratio_24h not measured: otel did not answer: otel unreachable$/);
  const verdict = judge(duty.metrics, withHarness(tools, output));
  for (const key of keys) assert.equal(verdict.metrics[key], undefined);
  assert.match(verdict.summary, /not measured: .*otel unreachable/);
});

// On 10-29 from 17:50Z to 19:30Z pi-pool had 0 of 40 Claude accounts usable, and at 19:30Z the 1h share read 0 on 8 calls (49 more ended in an error).
const at1930 = Date.parse("2026-10-29T19:30:00Z");
test("a window with no usable Claude account is not measured, with the gap named, and never 0", async () => {
  const blocked = (at: number) => at >= Date.parse("2026-10-29T17:50:00Z") && at <= at1930 ? 0 : 30;
  const cache = await measureCache(otel(warm, 8, { usable: blocked, errors: 49 }), targets, at1930);
  assert.equal("cache_read_ratio_1h" in cache.metrics, false);
  assert.equal(cache.flagged.find(slice => slice.kind === "cache_read_ratio_1h"), undefined);
  assert.equal(cache.flagged.find(slice => slice.kind === "source_error")!.excerpt,
    "cache_read_ratio_1h not measured: 8 calls in the window (49 more ended in an error), because pi-pool had no usable Claude account from 10-29 18:30Z to 19:30Z");
  // The day holds 23 usable hours, so 8 calls is a quiet day and stays a miss.
  assert.equal(cache.metrics.cache_read_ratio_24h, 0);
  const verdict = judge(duty.metrics, withHarness(tools, { metrics: { skills_to_prune: 0, ...cache.metrics }, flagged: cache.flagged }));
  assert.equal(verdict.metrics.cache_read_ratio_1h, undefined);
  assert.match(verdict.summary, /not measured: .*pi-pool had no usable Claude account/);
});

// The staging Prometheus took no sample from 10-29 03:10Z to 05:00Z, and the 1h window after it held no call.
test("a window otel heard no box in is not measured, with the gap named", async () => {
  const at = Date.parse("2026-10-29T05:00:00Z");
  const cache = await measureCache(otel([], 0, { heard: t => t > at || t < Date.parse("2026-10-29T03:10:00Z") }), targets, at);
  assert.equal("cache_read_ratio_1h" in cache.metrics, false);
  assert.equal(cache.flagged.find(slice => slice.kind === "source_error")!.excerpt,
    "cache_read_ratio_1h not measured: 0 calls in the window, because otel heard from no box from 10-29 04:00Z to 05:00Z");
});

test("a quiet window with a short gap stays a miss", async () => {
  const short = (at: number) => at >= at1930 - 10 * 60_000 ? 0 : 30;
  const cache = await measureCache(otel(warm, 8, { usable: short }), targets, at1930);
  for (const key of keys) {
    assert.equal(cache.metrics[key], 0);
    assert.match(cache.flagged.find(slice => slice.kind === key)!.excerpt, /^no data: 8 calls/);
  }
});

test("a cache drop over a gap still reads its share", async () => {
  const cold: Sample[] = warm.map(sample => ({ ...sample, value: sample.labels.kind === "cache_read" ? 1_000 : 50_000 }));
  const cache = await measureCache(otel(cold, MIN_CALLS, { usable: () => 0 }), targets, at1930);
  for (const key of keys) assert.ok(cache.metrics[key]! < targets[key]);
  assert.ok(cache.flagged.some(slice => slice.kind === "cache_read_ratio_1h" && slice.excerpt.includes("top cache writer")));
});
