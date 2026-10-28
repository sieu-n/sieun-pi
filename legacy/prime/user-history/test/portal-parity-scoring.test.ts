// 10-28 00:02Z: the staging crawler had moved every platform to /api/live/<network>/<op> while prod kept the old routes, and the run scored
// staging against prod's crawler openapi, so 63 renamed routes read as portal failures and staging_working_pct read 58.2%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { UNMEASURED_PCT, parityMetrics, scoredRoutes, type OpenApi, type ProbeResult, type Route } from "../scripts/duties/portal-parity.ts";

const doc = (...ops: string[]): OpenApi => {
  const paths: NonNullable<OpenApi["paths"]> = {};
  for (const op of ops) { const [method, path] = op.split(" ") as [string, string]; paths[path] = { ...paths[path], [method.toLowerCase()]: {} }; }
  return { paths };
};
const ok = (op: string): ProbeResult => ({ op, verdict: "ok", status: 200, ms: 5, note: "docs example" });

const OLD: Route = { crawler: "GET /api/live/tiktok/profile", group: "tiktok", portal: ["GET /v1/tiktok/live/profile"] };
const NEW: Route = { crawler: "GET /api/live/tiktok/user_detail", group: "tiktok", portal: ["GET /v1/tiktok/user_detail"] };
const SAME: Route = { crawler: "GET /api/live/youtube/channel", group: "youtube", portal: ["GET /v1/youtube/live/channel", "GET /v1/youtube/channel"] };
const PAUSED: Route = { crawler: "GET /api/douyin/profile/{sec_uid}", group: "douyin", portal: ["GET /v1/douyin/profile"], byDesign: "paused on prod", envs: ["prod"] };
const SERVED: Route = { crawler: "GET /api/douyin/profile/{sec_uid}", group: "douyin", portal: ["GET /v1/douyin/stored/profile"], envs: ["staging"] };
const ROUTES = [OLD, NEW, SAME, PAUSED, SERVED];
const crawler = {
  prod: doc(OLD.crawler, SAME.crawler, PAUSED.crawler),
  staging: doc(NEW.crawler, SAME.crawler, SERVED.crawler),
};
const docs = {
  prod: doc("GET /v1/tiktok/live/profile", "GET /v1/youtube/live/channel", "GET /v1/douyin/profile"),
  staging: doc("GET /v1/tiktok/user_detail", "GET /v1/youtube/channel", "GET /v1/douyin/stored/profile"),
};
const probes = {
  prod: [ok("GET /v1/tiktok/live/profile"), ok("GET /v1/youtube/live/channel")],
  staging: [ok("GET /v1/tiktok/user_detail"), ok("GET /v1/youtube/channel"), ok("GET /v1/douyin/stored/profile")],
};
const run = (over: Partial<Parameters<typeof parityMetrics>[0]> = {}) => { const { metrics, flagged = [] } = parityMetrics({ routes: ROUTES, crawler, docs, probes, sourceErrors: [], at: 1, ...over }).output; return { metrics, flagged }; };

test("each env scores the routes its own crawler lists, so old paths score on prod and the new grammar on staging", () => {
  assert.deepEqual(scoredRoutes(ROUTES, "prod", new Map(Object.keys({ [OLD.crawler]: 1, [SAME.crawler]: 1, [PAUSED.crawler]: 1 }).map(k => [k, {}]))), [OLD, SAME]);
  const { metrics, flagged } = run();
  assert.equal(metrics.prod_working_pct, 100);
  assert.equal(metrics.staging_working_pct, 100);
  assert.equal(metrics.prod_routes_scored, 2);
  assert.equal(metrics.staging_routes_scored, 3);
  assert.equal(metrics.routes_failing_portal, 0);
  assert.equal(metrics.routes_scored, 4);
  assert.equal(flagged.filter(slice => slice.kind.startsWith("missing_")).length, 0);
  assert.equal(flagged.filter(slice => slice.kind === "crawler_route_gone").length, 0);
});

test("a route the staging portal lost while the staging crawler still serves it is missing on staging only", () => {
  const { metrics, flagged } = run({ docs: { ...docs, staging: doc("GET /v1/youtube/channel", "GET /v1/douyin/stored/profile") } });
  assert.equal(metrics.staging_routes_missing, 1);
  assert.equal(metrics.prod_routes_missing, 0);
  assert.equal(metrics.routes_failing_portal, 1);
  assert.match(flagged.find(slice => slice.kind === "missing_staging")!.excerpt, /user_detail/);
});

test("an envs-limited byDesign entry is out of the score on its env, and its successor entry scores on the other", () => {
  const { metrics, flagged } = run({ probes: { ...probes, staging: probes.staging.filter(probe => !probe.op.includes("douyin")) } });
  assert.equal(metrics.staging_routes_unprobed, 1);
  assert.ok(flagged.some(slice => slice.kind === "by_design" && slice.excerpt.includes("on prod")));
});

test("a route neither crawler lists is flagged as gone and scored nowhere", () => {
  const { metrics, flagged } = run({ routes: [...ROUTES, { crawler: "POST /api/live/youtube/videos", group: "youtube", portal: ["POST /v1/youtube/live/videos"] }] });
  assert.equal(metrics.routes_scored, 4);
  assert.ok(flagged.some(slice => slice.kind === "crawler_route_gone" && slice.excerpt.includes("POST /api/live/youtube/videos")));
});

test("an env whose crawler openapi is unread has an unmeasured share and adds no portal failures", () => {
  const { metrics } = run({ crawler: { ...crawler, staging: null }, docs: { ...docs, staging: doc() } });
  assert.equal(metrics.staging_working_pct, UNMEASURED_PCT);
  assert.equal(metrics.routes_failing_portal, 0);
  assert.equal(metrics.prod_working_pct, 100);
});

test("the route map holds unique entries per env and names only real envs", () => {
  const { routes } = JSON.parse(readFileSync(new URL("../scripts/duties/portal-parity.routes.json", import.meta.url), "utf8")) as { routes: Route[] };
  for (const env of ["prod", "staging"] as const) {
    const keys = routes.filter(route => !route.envs || route.envs.includes(env)).map(route => route.crawler);
    assert.deepEqual(keys.filter((key, index) => keys.indexOf(key) !== index), [], `duplicate crawler entries on ${env}`);
  }
  for (const route of routes) for (const env of route.envs ?? []) assert.ok(env === "prod" || env === "staging");
});
