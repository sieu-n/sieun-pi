// Guards d1's env_keys_staging_only. On 2026-10-18 auto-sns-agent main's apps/api-portal/.env.staging had BATCH_WORKER_SECRET and its .env did
// not, so prod's batch routes ran without the secret staging used (board p9), and no duty metric counted it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blobFingerprint, docsIsScalar, ENV_REFS, rowUptime, uptimeMetrics } from "../scripts/duties/portal-uptime.ts";

const UP = [{ labels: { target: "crawler_health" }, value: 1 }, { labels: { target: "crawler_schema" }, value: 1 }, { labels: { target: "portal_openapi" }, value: 1 }];
const ANSWERS = { up: UP, uptime: UP, age: UP.map(series => ({ ...series, value: 60 })), p90: [{ labels: { target: "portal_openapi" }, value: 400 }], lastDown: [] };
const DIRECT = { status: 200, ms: 150 };
const PROD = "DOTENV_PUBLIC_KEY=\"x\"\nCRAWLER_API_KEY=encrypted:a\nCRAWLER_API_URL=encrypted:b\n";
const STAGING = "DOTENV_PUBLIC_KEY_STAGING=\"y\"\nCRAWLER_API_KEY=encrypted:c\nCRAWLER_API_URL=encrypted:d\nBATCH_WORKER_SECRET=encrypted:e\n";

test("a key staging has and prod lacks on main counts once and names the key, and dotenvx's own keys never count", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: STAGING }, "dev/sieun": { prod: `${PROD}BATCH_WORKER_SECRET=encrypted:f\n`, staging: STAGING } });
  assert.equal(output.metrics.env_keys_staging_only, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "env_staging_only")!.excerpt, /at main has BATCH_WORKER_SECRET/);
});

test("an env file GitHub did not give reads as unmeasured, never as 0", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { error: "HTTP 404" } });
  assert.equal(output.metrics.env_keys_staging_only, 999999);
});

test("main's gap does not count when the live prod blob was pushed from a .env that has the key, as p9's push from 176874bc12 did on 10-18", () => {
  const dev = `${PROD}BATCH_WORKER_SECRET=encrypted:f\n`;
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: STAGING }, "dev/sieun": { prod: dev, staging: STAGING } }, { ref: "176874bc12", text: dev, staging: STAGING });
  assert.equal(output.metrics.env_keys_staging_only, 0);
  assert.equal(output.flagged!.filter(flag => flag.kind === "env_staging_only").length, 0);
});

test("a live prod blob that lacks the key still counts and names the blob's commit", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: STAGING }, "dev/sieun": { prod: PROD, staging: PROD } }, { ref: "abc1234567", text: PROD, staging: STAGING });
  assert.equal(output.metrics.env_keys_staging_only, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "env_staging_only")!.excerpt, /the live prod blob \(apps\/api-portal\/\.env at abc1234567\) lacks/);
});

test("keys the live blob's commit dropped from both tiers do not count against main's older .env.staging, as 2bb4d95732's Vent move did on 10-19", () => {
  const dropped = "CLERK_SECRET_KEY=encrypted:g\nSTRIPE_SECRET_KEY=encrypted:h\nSTRIPE_WEBHOOK_SECRET=encrypted:i\n";
  const devProd = `${PROD}BATCH_WORKER_SECRET=encrypted:f\nCLERK_JWT_KEY=encrypted:j\n`;
  const devStaging = `${STAGING}CLERK_JWT_KEY=encrypted:k\n`;
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: `${PROD}${dropped}`, staging: `${STAGING}${dropped}` }, "dev/sieun": { prod: devProd, staging: devStaging } }, { ref: "2bb4d95732", text: devProd, staging: devStaging });
  assert.equal(output.metrics.env_keys_staging_only, 0);
  assert.equal(output.flagged!.filter(flag => flag.kind === "env_staging_only").length, 0);
});

test("a key the live blob's own .env.staging has and its .env lacks counts and names that commit's .env.staging", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: PROD }, "dev/sieun": { prod: PROD, staging: PROD } }, { ref: "abc1234567", text: PROD, staging: STAGING });
  assert.equal(output.metrics.env_keys_staging_only, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "env_staging_only")!.excerpt, /\.env\.staging at abc1234567 has BATCH_WORKER_SECRET/);
});

test("an unread live blob falls back to main's .env and says so", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: STAGING }, "dev/sieun": { prod: PROD, staging: PROD } }, { error: "Vercel GET answered 403" });
  assert.equal(output.metrics.env_keys_staging_only, 1);
  assert.ok(output.flagged!.some(flag => flag.kind === "env_live_unread"));
});

test("the fingerprint is vercel-blobs.mjs's: trailing whitespace dropped, one final newline", () => {
  assert.equal(blobFingerprint("A=1\n\n  "), blobFingerprint("A=1"));
  assert.match(blobFingerprint("A=1"), /^[0-9a-f]{16}$/);
});

test("the 24 h uptime gives the time of its newest failed probe minute, and a full 100% gives none (10-23 d9: d1 stayed red 44 runs after the 10-22 pg_wal cutovers)", () => {
  const uptime = [{ labels: { target: "crawler_health" }, value: 0.98 }, { labels: { target: "crawler_schema" }, value: 0.99 }, { labels: { target: "portal_openapi" }, value: 1 }];
  const lastDown = [{ labels: { target: "crawler_health" }, value: 1_761_100_000 }, { labels: { target: "crawler_schema" }, value: 1_761_103_600 }];
  const red = uptimeMetrics({ ...ANSWERS, uptime, lastDown }, DIRECT, 0);
  assert.ok(red.metrics.probe_uptime_24h_pct! < 100);
  assert.deepEqual(red.lastEventAt, { probe_uptime_24h_pct: 1_761_103_600_000 });
  assert.equal(uptimeMetrics(ANSWERS, DIRECT, 0).lastEventAt, undefined);
  const unread = uptimeMetrics({ ...ANSWERS, uptime, lastDown: { error: "HTTP 500" } }, DIRECT, 0);
  assert.equal(unread.lastEventAt, undefined);
  assert.ok(unread.flagged!.some(flag => flag.kind === "source_error" && flag.excerpt.includes("HTTP 500")));
});

// Owner rule c119: us-metal02 moved from sieun/dev to dev/sieun on 2026-10-27 08:17Z, so the next promote's env files are read at dev/sieun.
test("the env files are compared at main and at dev/sieun", () => {
  assert.deepEqual(ENV_REFS, ["main", "dev/sieun"]);
});

// On 10-29 the docker move on us-metal01 stopped the crawler and the estate Prometheus together from 02:55 to 05:01Z. The prod Convex
// probe rows held 127 failed rounds per crawler target, and avg_over_time(api_probe_up[24h]) read 99.92% because it skips a gap.
test("the 24 h uptime counts every Convex probe row, so an outage with no Prometheus scrape still lowers it (10-29 docker move)", () => {
  const now = 1_793_251_200_000;
  const rows = [];
  for (let minute = 1; minute <= 1440; minute++) {
    const createdAt = now - minute * 60_000 + 1;
    const down = minute > 60 && minute <= 187;
    rows.push({ target: "crawler_health", ok: !down, createdAt }, { target: "crawler_schema", ok: !down, createdAt }, { target: "portal_openapi", ok: true, createdAt });
  }
  rows.push({ target: "crawler_health", ok: false, createdAt: now - 86_400_000 - 1 });
  const { uptime, lastDown } = rowUptime(rows, now);
  assert.deepEqual(uptime.map(series => [series.labels.target, Math.round(series.value * 10_000)]), [["crawler_health", 9118], ["crawler_schema", 9118], ["portal_openapi", 10_000]]);
  assert.deepEqual(lastDown.map(series => series.labels.target), ["crawler_health", "crawler_schema"]);
  assert.equal(lastDown[0]!.value, (now - 61 * 60_000 + 1) / 1000);
  const output = uptimeMetrics({ ...ANSWERS, uptime, lastDown }, DIRECT, 0);
  assert.equal(output.metrics.probe_uptime_24h_pct, 94.12);
  assert.equal(output.lastEventAt?.probe_uptime_24h_pct, now - 61 * 60_000 + 1);
});

test("a target with no probe row in 24 h has no uptime series, so the duty flags it missing", () => {
  const { uptime } = rowUptime([{ target: "portal_openapi", ok: true, createdAt: 5 }], 10);
  assert.deepEqual(uptime.map(series => series.labels.target), ["portal_openapi"]);
  const output = uptimeMetrics({ ...ANSWERS, uptime }, DIRECT, 0);
  assert.equal(output.metrics.probe_uptime_24h_pct, -1);
  assert.ok(output.flagged!.some(flag => flag.kind === "series_missing" && flag.excerpt.includes("crawler_health")));
});

// p110: d1 keeps api.virev.ai/docs on the Scalar reference. The markup below is what staging-api.virev.ai/docs served on 2026-10-29.
const SCALAR_DOCS = '<link href="./_app/immutable/assets/ApiDocsExplorer.BAbxZU-i.css" rel="stylesheet"><div class="docs"><p class="text-sm font-semibold text-ink">Loading interactive reference</p></div>';
const HAND_BUILT_DOCS = '<meta name="description" content="Full reference for the virev.ai social data API"/><h2 id="authentication">Authentication</h2>';

test("a /docs page is Scalar when it carries the ApiDocsExplorer stylesheet or its mount placeholder, and the hand-built page is not", () => {
  assert.equal(docsIsScalar(SCALAR_DOCS), true);
  assert.equal(docsIsScalar('<p>Loading interactive reference</p>'), true);
  assert.equal(docsIsScalar(HAND_BUILT_DOCS), false);
});

test("a prod /docs that is not Scalar counts one probe down and names public_docs_scalar with what it saw", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { status: 200, ms: 300, scalar: docsIsScalar(HAND_BUILT_DOCS) });
  assert.equal(output.metrics.probes_down_now, 1);
  const flag = output.flagged!.find(row => row.kind === "public_docs_scalar")!;
  assert.match(flag.excerpt, /^public_docs_scalar: signed-out GET https:\/\/api\.virev\.ai\/docs gave HTTP 200 with no Scalar reference/);
  assert.match(flag.excerpt, /prod \/docs is not Scalar yet; it ships with the next portal promote/);
});

test("a Scalar /docs adds nothing, and a failed GET of it counts as down with its error", () => {
  const ok = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { status: 200, ms: 300, scalar: true });
  assert.equal(ok.metrics.probes_down_now, 0);
  assert.equal(ok.flagged!.some(row => row.kind === "public_docs_scalar"), false);
  const failed = uptimeMetrics(ANSWERS, DIRECT, 0, {}, undefined, { status: 502, ms: 90, scalar: false });
  assert.equal(failed.metrics.probes_down_now, 1);
  assert.match(failed.flagged!.find(row => row.kind === "public_docs_scalar")!.excerpt, /gave HTTP 502 after 90 ms/);
});

test("an offline Mac leaves probes_down_now unmeasured and does not blame /docs", () => {
  const down = { error: "fetch failed (ENETUNREACH)" };
  const answers = { up: down, uptime: down, age: down, p90: down, lastDown: down };
  const output = uptimeMetrics(answers, { status: 0, ms: 5, error: "fetch failed (ENETUNREACH)" }, 0, {}, undefined, { status: 0, ms: 5, scalar: false, error: "fetch failed (ENETUNREACH)" });
  assert.equal(output.metrics.probes_down_now, 999999);
  assert.equal(output.flagged!.some(row => row.kind === "public_docs_scalar"), false);
});
