// Guards d1's /docs check (p110, c110). From 10-29 to 10-30 auto-sns-agent main stayed at 416fae9ac8, whose public docs route was still the
// hand-built page, while staging had the Scalar docs; probes_down_now read 1 for four runs with no outage, so a page main does not ship yet
// must not count, and one main does ship must.
import assert from "node:assert/strict";
import { test } from "node:test";
import { convexBackend } from "../scripts/duties/convex-admin.ts";
import { docsIsScalar, PROBE_PAGE, probeRows, proxyStopped, rowUptime, uptimeMetrics } from "../scripts/duties/portal-uptime.ts";

const UP = [{ labels: { target: "crawler_health" }, value: 1 }, { labels: { target: "crawler_schema" }, value: 1 }, { labels: { target: "portal_openapi" }, value: 1 }];
const ANSWERS = { up: UP, uptime: UP, age: UP.map(series => ({ ...series, value: 60 })), p90: [{ labels: { target: "portal_openapi" }, value: 400 }], lastDown: [] };
const DIRECT = { status: 200, ms: 150 };
// The markup staging-api.virev.ai/docs served on 2026-10-29, and prod's hand-built page.
const SCALAR_DOCS = '<link href="./_app/immutable/assets/ApiDocsExplorer.BAbxZU-i.css" rel="stylesheet"><div class="docs"><p class="text-sm font-semibold text-ink">Loading interactive reference</p></div>';
const HAND_BUILT_DOCS = '<meta name="description" content="Full reference for the virev.ai social data API"/><h2 id="authentication">Authentication</h2>';
const OLD_PAGE = { status: 200, ms: 300, scalar: docsIsScalar(HAND_BUILT_DOCS) };
const kinds = (output: ReturnType<typeof uptimeMetrics>) => output.flagged!.map(row => row.kind);

test("a /docs page is Scalar when it carries the ApiDocsExplorer stylesheet or its mount placeholder, and the hand-built page is not", () => {
  assert.equal(docsIsScalar(SCALAR_DOCS), true);
  assert.equal(docsIsScalar("<p>Loading interactive reference</p>"), true);
  assert.equal(docsIsScalar(HAND_BUILT_DOCS), false);
});

test("main without the Scalar docs and prod on the old page counts nothing and gives a public_docs_pending row", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { ...OLD_PAGE, main: false });
  assert.equal(output.metrics.probes_down_now, 0);
  assert.deepEqual(kinds(output).filter(kind => kind.startsWith("public_docs")), ["public_docs_pending"]);
  assert.match(output.flagged!.find(row => row.kind === "public_docs_pending")!.excerpt, /waits on the portal promote that carries p110 and is not counted/);
});

test("main with the Scalar docs and prod on the old page counts one probe down with a public_docs_scalar row", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { ...OLD_PAGE, main: true });
  assert.equal(output.metrics.probes_down_now, 1);
  assert.deepEqual(kinds(output).filter(kind => kind.startsWith("public_docs")), ["public_docs_scalar"]);
  assert.match(output.flagged!.find(row => row.kind === "public_docs_scalar")!.excerpt, /^public_docs_scalar: signed-out GET https:\/\/api\.virev\.ai\/docs gave HTTP 200 with no Scalar reference/);
});

test("main with the Scalar docs and prod on Scalar counts nothing and flags nothing", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { status: 200, ms: 300, scalar: docsIsScalar(SCALAR_DOCS), main: true });
  assert.equal(output.metrics.probes_down_now, 0);
  assert.equal(kinds(output).some(kind => kind.startsWith("public_docs")), false);
});

test("an unread main with prod on the old page is a source_error and leaves probes_down_now unmeasured, never 0", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { ...OLD_PAGE, main: { error: "HTTP 502" } });
  assert.equal(output.metrics.probes_down_now, 999999);
  assert.ok(output.flagged!.some(row => row.kind === "source_error" && row.excerpt.includes("HTTP 502") && row.excerpt.includes("+page.svelte")));
  assert.ok(output.metrics.source_errors! >= 1);
});

test("a failed GET of /docs counts as down with its error whatever main ships", () => {
  for (const main of [true, false] as const) {
    const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { status: 502, ms: 90, scalar: false, main });
    assert.equal(output.metrics.probes_down_now, 1);
    assert.match(output.flagged!.find(row => row.kind === "public_docs_scalar")!.excerpt, /gave HTTP 502 after 90 ms/);
  }
});

test("an offline Mac leaves probes_down_now unmeasured and does not blame /docs", () => {
  const down = { error: "fetch failed (ENETUNREACH)" };
  const answers = { up: down, uptime: down, age: down, p90: down, lastDown: down };
  const output = uptimeMetrics(answers, { status: 0, ms: 5, error: "fetch failed (ENETUNREACH)" }, 0, {}, undefined, { status: 0, ms: 5, scalar: false, error: "fetch failed (ENETUNREACH)", main: { error: "fetch failed" } });
  assert.equal(output.metrics.probes_down_now, 999999);
  assert.equal(kinds(output).some(kind => kind.startsWith("public_docs")), false);
});

// 11-03: Convex disabled the team at 18:11Z, the probe cron wrote no row after it, and d1 read 100% uptime with probes_down_now unmeasured at 23:24Z.
test("a Convex outage that stops the probe cron reads as skipped rounds, a stale probe and a failing key check", () => {
  const minute = 60_000;
  const stop = 19 * 60 * minute;
  const rows = ["crawler_health", "crawler_schema", "portal_openapi"].flatMap(target =>
    Array.from({ length: 19 * 60 }, (_, index) => ({ target, ok: true, createdAt: stop - index * minute })));
  const now = 24 * 60 * minute;
  const read = rowUptime(rows, now);
  assert.ok(read.uptime.every(series => series.value > 0.79 && series.value < 0.8));
  assert.ok(read.lastDown.every(series => series.value === now / 1000));
  const missing = { error: "no series" };
  const output = uptimeMetrics({ up: [], age: [], p90: missing, ...read } as never, DIRECT, now, {}, undefined, undefined,
    { status: 503, ms: 300, code: "auth_unavailable" });
  assert.ok(output.metrics.probe_uptime_24h_pct! < 80);
  assert.equal(output.metrics.probe_age_min, 300);
  assert.equal(output.metrics.probes_down_now, 1);
  assert.match(output.flagged!.find(row => row.kind === "portal_auth")!.excerpt, /gave HTTP 503 auth_unavailable/);
});

test("a key check refused with 401 counts nothing", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, undefined, { status: 401, ms: 120, code: "invalid_api_key" });
  assert.equal(output.metrics.probes_down_now, 0);
  assert.equal(kinds(output).includes("portal_auth"), false);
});

test("the probe rows come from the backend the prod VITE_CONVEX_URL row names, with that instance's admin key (prod cutover 11-04)", async () => {
  const fetcher = (async (url: string) => new Response(url === "https://convex.virev.ai/instance_name" ? "convex-prod" : "", { status: url.endsWith("/instance_name") ? 200 : 404 })) as typeof fetch;
  const rows: Record<string, string> = { "apps/api-portal/.env VITE_CONVEX_URL": "https://convex.virev.ai",
    "apps/ci/.env": JSON.stringify({ CONVEX_DEPLOY_KEY: "prod:befitting-sparrow-356|old", CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-prod|new" }) };
  const backend = await convexBackend("production", fetcher, async (file, name) => rows[name ? `${file} ${name}` : file]!);
  assert.deepEqual(backend, { url: "https://convex.virev.ai", instance: "convex-prod", adminKey: "convex-prod|new" });
});

// 11-23: the probe wrote 6 targets a round since 11-22, the read of 4320 rows reached back 12 h, and d1 read 50% uptime with no failed row.
test("the probe read pages back to the first row older than 24 h however many targets a round writes", async () => {
  const minute = 60_000;
  const now = 24 * 60 * minute;
  const targets = ["crawler_health", "crawler_schema", "portal_openapi", "portal_auth", "portal_instagram_profile", "portal_docs_inline"];
  const table = Array.from({ length: 48 * 60 }, (_, index) => targets.map(target => ({ target, ok: true, createdAt: now - index * minute }))).flat();
  const asked: number[] = [];
  const query = (async (_path: string, args: { paginationOpts: { cursor: string | null; numItems: number } }) => {
    const from = Number(args.paginationOpts.cursor ?? 0);
    asked.push(args.paginationOpts.numItems);
    const page = table.slice(from, from + args.paginationOpts.numItems);
    return { page, isDone: from + page.length >= table.length, continueCursor: String(from + page.length) };
  }) as never;
  const rows = await probeRows(query, now);
  assert.ok(asked.every(size => size === PROBE_PAGE));
  assert.ok(rows.some(row => row.createdAt <= 0) && rows.length < table.length);
  assert.ok(rowUptime(rows, now).uptime.every(series => series.value === 1));
});

// 11-23: portal_instagram_profile failed every round with 503 proxy_provider_down while the owner stopped crawling (c230), and probes_down_now read 1.
test("a target the owner stopped for the lapsed proxy is flagged proxy_stopped and not counted down", () => {
  const rows = [
    { target: "portal_instagram_profile", ok: false, errorClass: "proxy_provider_down", createdAt: 2 },
    { target: "portal_auth", ok: false, errorClass: "upstream_error", createdAt: 2 },
    { target: "crawler_health", ok: false, errorClass: "proxy_provider_down", createdAt: 1 },
    { target: "crawler_health", ok: true, createdAt: 2 },
  ];
  const stopped = proxyStopped(rows);
  assert.deepEqual(stopped, ["portal_instagram_profile"]);
  const up = [...UP, { labels: { target: "portal_instagram_profile" }, value: 0 }];
  const output = uptimeMetrics({ ...ANSWERS, up }, DIRECT, 0, {}, undefined, undefined, undefined, stopped);
  assert.equal(output.metrics.probes_down_now, 0);
  assert.deepEqual(kinds(output).filter(kind => kind === "down" || kind === "proxy_stopped"), ["proxy_stopped"]);
  assert.equal(uptimeMetrics({ ...ANSWERS, up }, DIRECT, 0).metrics.probes_down_now, 1);
});
