import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { USAGE_METRICS, type UsageMetric, type UsageModelRow, type UsageRate, type UsageSeries, type UsageSummary } from "../src/shared/usage.ts";
import { dailyPayload, groupSeries, livePayload, publicModel, readPublishConfig, rotateKey, sha256Hex, UsagePublisher, type UsageSource } from "../src/usage/publish.ts";

const rate = (n: number): UsageRate => ({ output: n, input: n * 2, cacheRead: n * 10, cacheWrite: n * 3, total: n * 16 });
const spark = (n: number): Record<UsageMetric, number[]> => Object.fromEntries(USAGE_METRICS.map(m => [m, new Array<number>(60).fill(n)])) as Record<UsageMetric, number[]>;
const summary = (n: number, at = 1_000_000, extra: Partial<UsageSummary> = {}): UsageSummary => ({
  at, perSecond: rate(n), perMinute: rate(n * 60), perDay: rate(n * 86_400), sparkSeconds: spark(n), sparkMinutes: spark(n * 60), costToday: 12.345678,
  ingest: { state: "idle", filesDone: 3, filesTotal: 3, lastSyncAt: at, error: "/Users/someone/secret/path.jsonl failed", sources: [{ source: "codex", calls: 9, firstCallAt: 1, lastCallAt: 2 }] },
  ...extra,
});
const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0, total: 10 };
const series = (keys: string[]): UsageSeries => ({ window: "all", bucket: "day", group: "model", metric: "output", keys,
  points: [{ t: 100, tokens, costUsd: 1.5, calls: 3, byKey: Object.fromEntries(keys.map((k, i) => [k, i + 1])) }, { t: 300, tokens, costUsd: null, calls: 1, byKey: {} }] });
const row: UsageModelRow = { source: "claude-code", model: "claude-opus-4-8", calls: 4, tokens, costUsd: 0.5, medianOutputTps: 80 };
const fakeUsage = (current: () => UsageSummary): UsageSource => ({
  summary: async () => current(),
  series: async (_w, _b, group) => group === "none" ? series([]) : series(group === "model" ? ["claude-opus-4-8", "/Users/x/bad model"] : ["codex", "Weird Source"]),
  models: async () => ({ models: [row, { ...row, model: "/tmp/../etc" }] }),
});

test("the live payload carries only numbers per kind, never the ingest error, cwd or source details", () => {
  const payload = livePayload("sieun", summary(5));
  assert.deepEqual(Object.keys(payload).sort(), ["at", "costToday", "perDay", "perMinute", "perSecond", "seconds", "slug"]);
  assert.deepEqual(Object.keys(payload.seconds).sort(), [...USAGE_METRICS].sort());
  assert.equal(payload.seconds.output.length, 60);
  assert.equal(payload.perSecond.output, 5);
  assert.equal(payload.costToday, 12.3457);
  assert.ok(!JSON.stringify(payload).includes("/Users"));
});

test("model and source names pass an allowlist; anything else becomes other", () => {
  assert.equal(publicModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(publicModel("openai/gpt-5.6-sol"), "openai/gpt-5.6-sol");
  assert.equal(publicModel("/Users/x/model"), "other");
  assert.equal(publicModel("a/../b"), "other");
  assert.equal(publicModel("has space"), "other");
  const grouped = groupSeries(series(["claude-opus-4-8", "/a b", "~bad"]), [100, 200, 300], publicModel);
  assert.deepEqual(grouped.keys, ["claude-opus-4-8", "other"]);
  assert.deepEqual(grouped.values, [[1, 5], [0, 0], [0, 0]]);
});

test("the daily payload aligns every group to the day list and filters model rows", async () => {
  const payload = await dailyPayload("sieun", fakeUsage(() => summary(1)), 42);
  assert.deepEqual(payload.days.map(d => d.t), [100, 300]);
  assert.deepEqual(payload.groups.model.output.keys, ["claude-opus-4-8", "other"]);
  assert.deepEqual(payload.groups.source.total.keys, ["codex", "other"]);
  assert.equal(payload.groups.model.cacheRead.values.length, 2);
  assert.deepEqual(payload.models.d1.map(r => r.model), ["claude-opus-4-8", "other"]);
  assert.deepEqual(Object.keys(payload.models), ["d1", "d7", "d30", "all"]);
  assert.ok(!JSON.stringify(payload).includes("/Users") && !JSON.stringify(payload).includes("/tmp"));
});

test("the publisher pushes live every tick while busy, skips quiet ticks until the heartbeat, and backs off a failing target", async () => {
  let now = 0;
  let current = summary(5, 0);
  const calls: { url: string; auth: string | null }[] = [];
  let failing = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response("{}", { status: failing && String(url).startsWith("https://bad") ? 500 : 200 });
  }) as typeof fetch;
  const publisher = new UsagePublisher(fakeUsage(() => current), { slug: "sieun", targets: [
    { name: "staging", siteUrl: "https://good.example/", key: "k".repeat(32), enabled: true },
    { name: "bad", siteUrl: "https://bad.example", key: "b".repeat(32), enabled: true },
    { name: "production", siteUrl: "https://prod.example", key: "p".repeat(32), enabled: false },
  ] }, { fetch: fetchImpl, now: () => now, dailyMs: 1e12, heartbeatMs: 60_000 });

  await publisher.tick();
  // First tick: live and daily to both enabled targets, never to the disabled one.
  assert.deepEqual(calls.map(c => c.url).sort(), ["https://bad.example/api/sieun-usage/daily", "https://bad.example/api/sieun-usage/live", "https://good.example/api/sieun-usage/daily", "https://good.example/api/sieun-usage/live"]);
  assert.equal(calls[0]!.auth, `Bearer ${"k".repeat(32)}`);
  calls.length = 0;

  current = summary(0, 5000); now = 5000;
  await publisher.tick(); // first quiet tick still pushes, so the page sees zero
  assert.equal(calls.length, 2);
  calls.length = 0;
  now = 10_000; await publisher.tick();
  now = 30_000; await publisher.tick();
  assert.equal(calls.length, 0, "quiet ticks inside the heartbeat send nothing");
  now = 66_000; await publisher.tick();
  assert.equal(calls.length, 2, "heartbeat after 60 s");
  calls.length = 0;

  failing = true;
  current = summary(3, 70_000); now = 70_000;
  await publisher.tick();
  now = 75_000; await publisher.tick();
  const bad = calls.filter(c => c.url.startsWith("https://bad"));
  const good = calls.filter(c => c.url.startsWith("https://good"));
  assert.equal(good.length, 2);
  assert.equal(bad.length, 1, "the failing target waits out its 10 s backoff");
});

test("a building or failing usage worker publishes nothing", async () => {
  const calls: string[] = [];
  const publisher = new UsagePublisher(fakeUsage(() => summary(0, 0, { ingest: { state: "building", filesDone: 0, filesTotal: 9, lastSyncAt: null, error: null, sources: [] } })),
    { slug: "sieun", targets: [{ name: "s", siteUrl: "https://s.example", key: "k".repeat(32), enabled: true }] },
    { fetch: (async (url: string) => { calls.push(url); return new Response("{}"); }) as unknown as typeof fetch });
  await publisher.tick();
  assert.deepEqual(calls, []);
});

test("rotateKey writes a 0600 config and returns the key's hash, and a missing config turns the publisher off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-push-"));
  try {
    const path = join(dir, "sub", "config.json");
    assert.equal(await readPublishConfig(path), null);
    const { sha256 } = await rotateKey({ name: "staging", siteUrl: "https://s.example", enabled: true }, "sieun", path);
    await rotateKey({ name: "production", siteUrl: "https://p.example", enabled: false }, "sieun", path);
    const config = await readPublishConfig(path);
    assert.equal(config?.targets.length, 2);
    const staging = config!.targets.find(t => t.name === "staging")!;
    assert.equal(sha256Hex(staging.key), sha256);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(path, "utf8")).includes(sha256));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
