// Guards d1's /docs check (p110, c110). From 10-29 to 10-30 auto-sns-agent main stayed at 416fae9ac8, whose public docs route was still the
// hand-built page, while staging had the Scalar docs; probes_down_now read 1 for four runs with no outage, so a page main does not ship yet
// must not count, and one main does ship must.
import assert from "node:assert/strict";
import { test } from "node:test";
import { docsIsScalar, uptimeMetrics } from "../scripts/duties/portal-uptime.ts";

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
