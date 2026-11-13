// 10-28 00:02Z: the staging crawler had moved every platform to /api/live/<network>/<op> while prod kept the old routes, and the run scored
// staging against prod's crawler openapi, so 63 renamed routes read as portal failures and staging_working_pct read 58.2%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MEDIA_OP, UNMEASURED_PCT, firstMediaUrl, heldPaidReads, parityMetrics, scoredRoutes, type OpenApi, type ProbeResult, type Route } from "../scripts/duties/portal-parity.ts";

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

test("a renamed read with aliases scores once on prod whether its crawler serves the old name, the new one or both", () => {
  // 11-01: prod crawler c9d8d290b7 served only the new names while prod's portal (main 416fae9) called the old ones; the rollback serves the old
  // names and the alias release both. Prod's portal documents only the old /v1 operation, staging's only the new one.
  const MERGED: Route = { crawler: NEW.crawler, aliases: [OLD.crawler], group: "tiktok", portal: [...NEW.portal, ...OLD.portal] };
  const base = { routes: [MERGED, SAME], docs, probes };
  const prodOn = (...paths: string[]) => run({ ...base, crawler: { ...crawler, prod: doc(...paths, SAME.crawler) } }).metrics;
  for (const metrics of [prodOn(OLD.crawler), prodOn(OLD.crawler, NEW.crawler)]) {
    assert.equal(metrics.prod_routes_scored, 2);
    assert.equal(metrics.prod_working_pct, 100);
    assert.equal(metrics.routes_failing_portal, 0);
  }
  const broken = run({ ...base, crawler: { ...crawler, prod: doc(NEW.crawler, SAME.crawler) },
    probes: { ...probes, prod: [{ op: OLD.portal[0]!, verdict: "portal", status: 404, ms: 5, code: "not_found", note: "docs example" }, ok("GET /v1/youtube/live/channel")] } }).metrics;
  assert.equal(broken.prod_routes_scored, 2);
  assert.equal(broken.prod_working_pct, 50);
  assert.equal(broken.routes_failing_portal, 1);
  assert.equal(run({ ...base }).metrics.staging_working_pct, 100);
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

test("a route whose presets share one crawler path fails when one preset fails, even while the others work", () => {
  // 11-02 21:20Z on: prod GET /v1/crawl/taplink/page answered 502 while the other POST /api/crawl/fetch presets passed, and d2 read 100.
  const FETCH: Route = { crawler: "POST /api/crawl/fetch", group: "jobs_crawl", portal: ["GET /v1/crawl/linktree/page", "GET /v1/crawl/taplink/page"] };
  const both = doc("GET /v1/crawl/linktree/page", "GET /v1/crawl/taplink/page");
  const broken: ProbeResult = { op: "GET /v1/crawl/taplink/page", verdict: "crawler", status: 502, ms: 24600, code: "upstream_error", note: "docs example" };
  const { metrics } = run({
    routes: [FETCH], crawler: { prod: doc(FETCH.crawler), staging: doc(FETCH.crawler) }, docs: { prod: both, staging: both },
    probes: { prod: [ok("GET /v1/crawl/linktree/page"), broken], staging: [ok("GET /v1/crawl/linktree/page"), ok("GET /v1/crawl/taplink/page")] },
  });
  assert.equal(metrics.prod_working_pct, 0);
  assert.equal(metrics.staging_working_pct, 100);
  assert.equal(metrics.routes_failing_crawler, 1);
});

test("the route map holds unique entries per env and names only real envs", () => {
  const { routes } = JSON.parse(readFileSync(new URL("../scripts/duties/portal-parity.routes.json", import.meta.url), "utf8")) as { routes: Route[] };
  for (const env of ["prod", "staging"] as const) {
    const keys = routes.filter(route => !route.envs || route.envs.includes(env)).map(route => route.crawler);
    assert.deepEqual(keys.filter((key, index) => keys.indexOf(key) !== index), [], `duplicate crawler entries on ${env}`);
    const aliases = routes.filter(route => !route.envs || route.envs.includes(env)).flatMap(route => route.aliases ?? []);
    assert.deepEqual(aliases.filter(alias => keys.includes(alias) || aliases.indexOf(alias) !== aliases.lastIndexOf(alias)), [], `an alias another entry scores on ${env}`);
  }
  for (const route of routes) for (const env of route.envs ?? []) assert.ok(env === "prod" || env === "staging");
});

// 11-04 00:00Z: four paid prod reads failed in a Convex billing outage, the run held their failures for the UTC day, and every later run
// read prod_working_pct 97.5% while the routes worked again.
test("a paid prod read holds only a working answer for the UTC day, so a failed one is called again on the next run", () => {
  const paid = new Set(["GET /v1/tiktok/live/profile", "GET /v1/youtube/live/channel"]);
  const at = Date.parse("2026-11-04T00:00:12.956Z");
  const failed: ProbeResult = { op: "GET /v1/youtube/live/channel", verdict: "portal", status: 502, ms: 5, note: "upstream failure" };
  const { state } = parityMetrics({ routes: ROUTES, crawler, docs, probes: { ...probes, prod: [ok("GET /v1/tiktok/live/profile"), failed] }, sourceErrors: [], at, paid });
  assert.deepEqual(state.paidAt, { "GET /v1/tiktok/live/profile": at });
  const later = Date.parse("2026-11-04T01:53:00Z");
  assert.deepEqual([...heldPaidReads(paid, state, later).keys()], ["GET /v1/tiktok/live/profile"]);
  const stale = { ...state, paidAt: { ...state.paidAt, "GET /v1/youtube/live/channel": at } };
  assert.deepEqual([...heldPaidReads(paid, stale, later).keys()], ["GET /v1/tiktok/live/profile"]);
  assert.equal(heldPaidReads(paid, state, Date.parse("2026-11-05T00:00:00Z")).size, 0);
});

test("the keyless /v1/media read scores from its own probe though no openapi lists it", () => {
  // 11-10 to 11-13: every prod /v1/media URL answered 502 media_unavailable (auto-sns-agent cca08bba2c), and d2 scored no media route.
  const MEDIA: Route = { crawler: "GET /api/media/{kind}/{entity_id}/{slot}", group: "media", portal: [MEDIA_OP] };
  const url = "https://api.virev.ai/v1/media/instagram_account/3882/profile_pic?e=1795219200&s=f28da9cf04a9e5aff1b2eb4eb0f9bc3a";
  assert.equal(firstMediaUrl([null, { data: { profile_pic_url: url } }]), url);
  const withMedia = { ...crawler, prod: doc(OLD.crawler, SAME.crawler, PAUSED.crawler, MEDIA.crawler) };
  const failing = { op: MEDIA_OP, verdict: "portal" as const, status: 502, ms: 5, code: "media_unavailable", note: "keyless GET" };
  const broken = run({ routes: [...ROUTES, MEDIA], crawler: withMedia, probes: { ...probes, prod: [...probes.prod, failing] } }).metrics;
  assert.equal(broken.prod_routes_portal, 1);
  assert.equal(broken.prod_routes_missing, 0);
  const fixed = run({ routes: [...ROUTES, MEDIA], crawler: withMedia, probes: { ...probes, prod: [...probes.prod, ok(MEDIA_OP)] } }).metrics;
  assert.equal(fixed.prod_working_pct, 100);
});
