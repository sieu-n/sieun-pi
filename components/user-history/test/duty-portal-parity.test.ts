import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { baseOp, buildRequest, jobRequest, chainIds, classify, isDm, nextPage, type OpenApi, type Operation, operations, parityMetrics, parseState, type ProbeResult, type Route, UNMEASURED_PCT } from "../scripts/duties/portal-parity.ts";

const AT = Date.parse("2026-10-13T00:00:00Z");
const op = (parameters: NonNullable<Operation["parameters"]>, extra: Omit<Operation, "parameters"> = {}): Operation => ({ parameters, ...extra });

test("portal parity: the request comes from the docs example query, then required examples, then one optional example", () => {
  assert.deepEqual(buildRequest("GET /v1/youtube/live/channel/videos", op([{ name: "handle", in: "query", example: "@mkbhd" }, { name: "channel_id", in: "query", example: "UC1" }], { "x-example-query": { handle: "@mkbhd", max_pages: 1 } })),
    { method: "GET", path: "/v1/youtube/live/channel/videos", query: { handle: "@mkbhd", max_pages: "1" } });
  assert.deepEqual(buildRequest("GET /v1/youtube/live/channel", op([{ name: "q", in: "query", required: true, example: "mkbhd" }, { name: "hl", in: "query", example: "en" }])),
    { method: "GET", path: "/v1/youtube/live/channel", query: { q: "mkbhd" } });
  assert.deepEqual(buildRequest("GET /v1/facebook/live/event", op([{ name: "id", in: "query", example: "2984" }, { name: "url", in: "query", example: "https://www.facebook.com/nasa" }])),
    { method: "GET", path: "/v1/facebook/live/event", query: { id: "2984" } });
  assert.deepEqual(buildRequest("POST /v1/meta_ads/search", op([], { requestBody: { content: { "application/json": { example: { q: "nike" } } } } })),
    { method: "POST", path: "/v1/meta_ads/search", query: {}, body: { q: "nike" } });
  assert.deepEqual(buildRequest("GET /v1/x", op([{ name: "q", in: "query", required: true }])), { missing: "required query q has no docs example" });
});

test("portal parity: job and snapshot ids come only from this run's answers", () => {
  const jobs = op([{ name: "job_id", in: "path", required: true, example: "job_example" }]);
  assert.deepEqual(buildRequest("GET /v1/jobs/{job_id}", jobs), { missing: "no job_id from an earlier answer in this run" });
  const ids = chainIds([{ data: { batch_id: "job_abc", status: "queued" } }, { error: { code: "x" } }, { data: { snapshot_id: "snap_1" } }]);
  assert.deepEqual(ids, { job_id: { value: "job_abc", from: 0 }, snapshot_id: { value: "snap_1", from: 2 } });
  assert.deepEqual(buildRequest("GET /v1/jobs/{job_id}/results", jobs, { job_id: ids.job_id!.value }), { method: "GET", path: "/v1/jobs/job_abc/results", query: {} });
});

test("portal parity: 2xx works, upstream_* blames the crawler, our own limits are unprobed, the rest is the portal", () => {
  assert.equal(classify(202, { data: {} }).verdict, "ok");
  assert.deepEqual(classify(502, { error: { code: "upstream_error" } }), { verdict: "crawler", code: "upstream_error" });
  assert.equal(classify(504, { error: { code: "upstream_timeout" } }).verdict, "crawler");
  assert.equal(classify(503, { error: { code: "capacity_exhausted" } }).verdict, "crawler");
  assert.equal(classify(429, { error: { code: "rate_limited" } }).verdict, "unprobed");
  assert.equal(classify(409, { error: { code: "job_finished" } }).verdict, "ok");
  assert.equal(classify(409, { error: { code: "conflict" } }).verdict, "portal");
  assert.equal(classify(0, null).verdict, "unprobed");
  assert.deepEqual(classify(503, { error: { code: "batch_unavailable" } }), { verdict: "portal", code: "batch_unavailable" });
  assert.equal(classify(400, { error: { code: "invalid_request" } }).verdict, "portal");
  assert.equal(classify(404, "<html>").verdict, "portal");
});

test("portal parity: a page-1 cursor goes back in the parameter the operation takes", () => {
  const paged = op([{ name: "q", in: "query" }, { name: "cursor", in: "query" }]);
  assert.deepEqual(nextPage(paged, { data: { items: [], continuationToken: "tok" } }), { param: "cursor", value: "tok" });
  assert.deepEqual(nextPage(paged, { data: {}, meta: { next_cursor: "c2" } }), { param: "cursor", value: "c2" });
  assert.equal(nextPage(paged, { data: { next_cursor: null } }), null);
  assert.equal(nextPage(op([{ name: "q", in: "query" }]), { data: { next_cursor: "c2" } }), null);
});

test("portal parity: a job-mode route entry probes the operation with max_pages 2", () => {
  assert.equal(baseOp("GET /v1/instagram/user_feed job"), "GET /v1/instagram/user_feed");
  assert.deepEqual(jobRequest({ method: "GET", path: "/v1/instagram/user_feed", query: { handle: "instagram", max_pages: "1" } }).query, { handle: "instagram", max_pages: "2" });
  const jobDoc = doc(["GET /v1/instagram/user_feed"]);
  const { output } = parityMetrics({ routes: [{ crawler: "POST /api/jobs/instagram", group: "jobs", portal: ["GET /v1/instagram/user_feed job"] }],
    crawler: doc(["POST /api/jobs/instagram"]), docs: { prod: jobDoc, staging: null }, sourceErrors: [], at: AT,
    probes: { prod: [{ op: "GET /v1/instagram/user_feed job", verdict: "ok", status: 202, ms: 900, note: "docs example in job mode" }], staging: [] } });
  assert.equal(output.metrics.prod_routes_missing, 0);
  assert.equal(output.metrics.prod_working_pct, 100);
  assert.equal(output.metrics.staging_working_pct, UNMEASURED_PCT);
});

test("portal parity: DM operations are never called", () => {
  assert.equal(isDm("POST /v1/instagram/dm/sessions/{session_id}/messages"), true);
  assert.equal(isDm("GET /v1/instagram/profile"), false);
});

const doc = (ops: string[]): OpenApi => ({ paths: Object.fromEntries(ops.map(o => { const [m, p] = o.split(" ") as [string, string]; return [p, { [m.toLowerCase()]: {} }]; })) });
const ROUTES: Route[] = [
  { crawler: "GET /api/a", group: "g", portal: ["GET /v1/a"] },
  { crawler: "GET /api/b", group: "g", portal: ["GET /v1/b"] },
  { crawler: "GET /api/c", group: "h", portal: [] },
  { crawler: "GET /api/d", group: "h", portal: [], byDesign: "board s5" },
];
const crawler = doc(["GET /api/a", "GET /api/b", "GET /api/c", "GET /api/d"]);
const prod = doc(["GET /v1/a", "GET /v1/b", "GET /v1/batch/trigger"]);
const probe = (o: string, verdict: ProbeResult["verdict"], status = 200, code?: string): ProbeResult => ({ op: o, verdict, status, ms: 10, code, note: "docs example" });

const DUTY_JSON = await readFile("scripts/duties/portal-parity.duty.json", "utf8");

test("portal parity: per env shares, portal and crawler causes on either env; by-design routes are left out", () => {
  const staging = doc(["GET /v1/a", "GET /v1/b", "GET /v1/c", "GET /v1/batch/trigger"]);
  const routes: Route[] = [...ROUTES.slice(0, 2), { crawler: "GET /api/c", group: "h", portal: ["GET /v1/c"] }, ROUTES[3]!];
  const { output, state } = parityMetrics({ routes, crawler, docs: { prod, staging }, sourceErrors: [], at: AT,
    probes: { prod: [probe("GET /v1/a", "ok"), probe("GET /v1/b", "crawler", 502, "upstream_error")],
      staging: [probe("GET /v1/a", "ok"), probe("GET /v1/b", "ok"), probe("GET /v1/c", "ok"), probe("GET /v1/batch/trigger", "portal", 503, "batch_unavailable")] } });
  assert.equal(output.metrics.prod_working_pct, 33.3);
  assert.equal(output.metrics.staging_working_pct, 100);
  assert.equal(output.metrics.prod_routes_missing, 1);
  assert.equal(output.metrics.routes_failing_portal, 1);
  assert.equal(output.metrics.routes_failing_crawler, 1);
  assert.deepEqual([...new Set(output.flagged?.map(item => item.kind))].sort(), ["broken_crawler_prod", "broken_portal_staging", "by_design", "missing_prod"]);
  assert.equal(state.verdicts["prod GET /v1/b"], "crawler");
  const duty = parseDutyInput(JSON.parse(DUTY_JSON), "d1", AT);
  assert.equal(judge(duty.metrics, output).verdict, "missed");
});

test("portal parity: a route SPEC-93 skips on prod leaves the prod share", () => {
  const { output } = parityMetrics({ routes: ROUTES.slice(0, 2), crawler, docs: { prod, staging: prod }, sourceErrors: [], at: AT,
    probes: { prod: [probe("GET /v1/a", "ok"), probe("GET /v1/b", "skipped", 0)], staging: [probe("GET /v1/a", "ok"), probe("GET /v1/b", "ok")] } });
  assert.equal(output.metrics.prod_working_pct, 100);
  assert.equal(output.metrics.prod_routes_skipped, 1);
});

test("portal parity: a route that worked last run and fails now is a regression", () => {
  const { output } = parityMetrics({ routes: ROUTES, crawler, docs: { prod, staging: prod }, sourceErrors: [], at: AT, previous: { verdicts: { "GET /v1/a": "ok" } },
    probes: { prod: [], staging: [probe("GET /v1/a", "portal", 400, "invalid_request")] } });
  assert.ok(output.flagged?.some(item => item.kind === "regression" && item.excerpt.startsWith("GET /v1/a")));
});

test("portal parity: the runner's first-run state {} reads as no previous state", () => {
  assert.equal(parseState("{}"), undefined);
  assert.deepEqual(parseState('{"verdicts":{"GET /v1/a":"ok"}}'), { verdicts: { "GET /v1/a": "ok" } });
});

test("portal parity: unread sources give -1 shares and source_errors, never a good value", () => {
  const { output } = parityMetrics({ routes: ROUTES, crawler: null, docs: { prod: null, staging: null }, probes: { prod: [], staging: [] }, sourceErrors: ["GET https://api.virev.ai/openapi.json gave HTTP 500"], at: AT });
  for (const key of ["prod_working_pct", "staging_working_pct"]) assert.equal(output.metrics[key], UNMEASURED_PCT, key);
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.flagged?.[0]?.kind, "source_error");
  const duty = parseDutyInput(JSON.parse(DUTY_JSON), "d1", AT);
  assert.equal(judge(duty.metrics, output).verdict, "missed");
});

test("portal parity: the duty JSON passes parseDutyInput and the route map points at real portal operations", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile("scripts/duties/portal-parity.duty.json", "utf8")), "d1", AT);
  assert.equal(duty.name, "Portal matches crawler");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:00" });
  assert.deepEqual(duty.metrics.map(m => [m.key, m.headline ?? false]), [["prod_working_pct", true], ["staging_working_pct", false], ["routes_failing_portal", false], ["routes_failing_crawler", false]]);
  const map = JSON.parse(await readFile("scripts/duties/portal-parity.routes.json", "utf8")) as { routes: Route[] };
  assert.ok(map.routes.every(route => /^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(route.crawler) && route.portal.every(o => /^(GET|POST|PUT|PATCH|DELETE) \/v1\/\S+( job)?$/.test(o)) && !isDm(route.portal.join(" "))));
  assert.equal(new Set(map.routes.map(route => route.crawler)).size, map.routes.length);
  assert.equal(operations(doc(["GET /v1/a"])).has("GET /v1/a"), true);
});
