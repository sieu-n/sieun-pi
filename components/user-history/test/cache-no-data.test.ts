// Owner 10-10 (c41): "the cache read ratio of hour/day should stay high". On 10-19 LGTM held no prime_agent series and both shares read 100.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureCache, MIN_CALLS, WINDOWS, type CacheMetric } from "../scripts/duties/cache-ratio.ts";
import { measureHarness } from "../scripts/duties/harness-health.ts";
import { withHarness } from "../scripts/duties/skills-and-tools.ts";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import type { Prometheus, Sample } from "../src/usage/lgtm.ts";

const duty = JSON.parse(readFileSync(new URL("../scripts/duties/skills-and-tools.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };
const targets = Object.fromEntries(Object.keys(WINDOWS).map(key => [key, duty.metrics.find(metric => metric.key === key)!.target])) as Record<CacheMetric, number>;
const keys = Object.keys(WINDOWS) as CacheMetric[];
const tools = { metrics: { checks_failed: 0, owner_fixes: 0 }, flagged: [] };

/** A Prometheus that answers token queries with `tokens` and call queries with `calls` finished calls. */
const prometheus = (tokens: Sample[], calls: number): Prometheus => ({
  query: async promql => promql.includes("prime_agent_calls_total") ? (calls ? [{ labels: { provider: "anthropic", stop_reason: "stop" }, value: calls }] : []) : tokens,
  range: async () => [],
});
const warm: Sample[] = [
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "input" }, value: 1_000 },
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "cache_read" }, value: 98_000 },
  { labels: { box: "mbp", provider: "anthropic", model: "claude-opus-5-5", kind: "cache_write" }, value: 1_000 },
];

test("a window with no series is a miss with the reason no data", async () => {
  const cache = await measureCache(prometheus([], 0), targets);
  for (const key of keys) {
    assert.ok(cache.metrics[key] < targets[key], `${key} reads ${cache.metrics[key]}, which meets its target on no data`);
    assert.match(cache.flagged.find(slice => slice.kind === key)!.excerpt, /^no data: /);
  }
  const verdict = judge(duty.metrics, withHarness(tools, { metrics: { skills_to_prune: 0, ...cache.metrics }, flagged: cache.flagged }));
  assert.equal(verdict.verdict, "missed");
  for (const key of keys) assert.equal(verdict.metrics[key]!.met, false);
});

test("a window with fewer than MIN_CALLS calls is a miss even when its share is high", async () => {
  const cache = await measureCache(prometheus(warm, MIN_CALLS - 1), targets);
  for (const key of keys) {
    assert.ok(cache.metrics[key] < targets[key]);
    assert.match(cache.flagged.find(slice => slice.kind === key)!.excerpt, /^no data: 19 calls/);
  }
});

test("a window with enough calls reads its share", async () => {
  const cache = await measureCache(prometheus(warm, MIN_CALLS), targets);
  for (const key of keys) assert.equal(cache.metrics[key], 98);
  assert.deepEqual(cache.flagged, []);
});

test("an LGTM failure is a miss with the reason no data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cache-no-data-"));
  const output = await measureHarness({ roots: [], views: async () => [], dataDir, now: Date.parse("2026-10-19T15:30:00Z"),
    cache: () => Promise.reject(new Error("LGTM unreachable")), history: async () => ({ owner: [], refines: [] }), transcripts: async () => [], smoke: { python: "python3" } });
  for (const key of keys) assert.ok(output.metrics[key]! < targets[key]);
  assert.match(output.flagged!.find(slice => slice.kind === "cache_error")!.excerpt, /^no data: /);
  assert.equal(judge(duty.metrics, withHarness(tools, output)).verdict, "missed");
});
