// 10-28 00:02Z: the staging crawler had moved every platform to /api/live/<network>/<op> while prod kept the old routes, and the run scored
// staging against prod's crawler openapi, so 63 renamed routes read as portal failures and staging_working_pct read 58.2%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MEDIA_OP, UNMEASURED_PCT, classify, firstMediaUrl, heldEgress, heldInput, heldMedia, heldPaidReads, parityMetrics, probeMedia, scoredRoutes, snapshotRowsVerdict, supplyHoldOf, type OpenApi, type ProbeResult, type Route } from "../scripts/duties/portal-parity.ts";

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

test("a keyless media read the crawler held on purpose scores as held, not the portal's", async (t) => {
  // 11-20 11:05Z: a refresh_paused staging slot under pause.media_refresh answered 503 and d2 read routes_failing_portal 1.
  const answer = (code: string) => async () => Response.json({ ok: false, error: { code, message: "paused" } }, { status: 503 });
  const url = "https://staging-api.virev.ai/v1/media/tiktok_account/275923/profile_pic?e=1795824000&s=7334454549c453ddf83cf23898bf4a00";
  t.mock.method(globalThis, "fetch", answer("source_paused"));
  assert.equal((await probeMedia(url)).verdict, "held");
  t.mock.method(globalThis, "fetch", answer("media_unavailable"));
  assert.equal((await probeMedia(url)).verdict, "portal");
});

test("while an env's crawler reports a proxy supply hold, the run sends none of its box-egress /v1/crawl calls", () => {
  // 11-20: d2 sent 108 /v1/crawl direct preset calls to staging in one hour after the owner's rule c230.
  const status = { ok: true, data: { supply_holds: [{ provider: "geonode", code: "proxy_auth_failed", connect_status: 407, since: 1794213898.7 }] } };
  const hold = supplyHoldOf(status);
  assert.match(hold!, /geonode proxy_auth_failed since 2026-11-09/);
  assert.equal(supplyHoldOf({ ok: true, data: { supply_holds: [] } }), null);
  assert.ok(supplyHoldOf({ ok: true, data: {} }));
  const both = doc("GET /v1/crawl/linktree/page", "POST /v1/crawl/web-scraping-api", "GET /v1/instagram/user_feed");
  const held = heldEgress(both, hold);
  assert.deepEqual([...held.keys()].sort(), ["GET /v1/crawl/linktree/page", "POST /v1/crawl/web-scraping-api"]);
  assert.equal(held.get("GET /v1/crawl/linktree/page")!.verdict, "held");
  assert.equal(heldEgress(both, null).size, 0);
});

test("an answer that names a proxy supply hold or a switched-off Vent is held, not the crawler's", () => {
  // 11-20 11:21Z: prod answered 35 calls 503 upstream_error "upstream temporarily unavailable" and d2 read routes_failing_crawler 20.
  const error = (code: string, message: string) => ({ ok: false, error: { code, message } });
  assert.equal(classify(503, error("upstream_error", "upstream temporarily unavailable")).verdict, "held");
  assert.equal(classify(503, error("upstream_error", "integration crawler is switched off on this Vent: c230")).verdict, "held");
  assert.equal(classify(503, error("upstream_error", "vent_integration_disabled")).verdict, "held");
  assert.equal(classify(403, error("upstream_error", "vent_crawl_paused")).verdict, "held");
  // 11-23 06:04Z: the crawl gate refused 34 reads of each tier's test orgs, which d2 read as 34 routes failing in the crawler.
  assert.equal(classify(502, error("upstream_error", "only paid reads may crawl: this read names no customer workspace and no paid work (crawl_gate.paid_only, owner p42 2026-11-22)")).verdict, "held");
  assert.equal(classify(502, error("upstream_error", "crawl_budget_spent")).verdict, "held");
  assert.equal(classify(502, error("upstream_error", "The crawl job failed")).verdict, "crawler");
});

test("a held route counts as not working in its share and as a crawler failure, and the run counts it apart as held", () => {
  // 11-20 d9 audit: d2 left held routes out of the shares and read 100% while 18 prod routes did not answer (145 of 165 worked).
  const notSent: ProbeResult = { op: "GET /v1/youtube/live/channel", verdict: "held", status: 0, ms: 0, note: "not sent: held" };
  const answered: ProbeResult = { op: "GET /v1/tiktok/user_detail", verdict: "held", status: 503, ms: 200, code: "upstream_error", note: "docs example" };
  const previous = { verdicts: { "staging GET /v1/tiktok/user_detail": "ok" as const } };
  const { output, state } = parityMetrics({ routes: ROUTES, crawler, docs, sourceErrors: [], at: 1, previous,
    probes: { prod: [ok("GET /v1/tiktok/live/profile"), notSent], staging: [answered, ok("GET /v1/youtube/channel"), ok("GET /v1/douyin/stored/profile")] } });
  const { metrics, flagged = [] } = output;
  assert.equal(metrics.prod_working_pct, 50);
  assert.equal(metrics.staging_working_pct, 66.7);
  assert.equal(metrics.routes_failing_crawler, 2);
  assert.equal(metrics.prod_routes_held, 1);
  assert.equal(metrics.staging_routes_held, 1);
  assert.equal(metrics.routes_held, 2);
  assert.equal(metrics.prod_v1_ops_called, 1);
  assert.deepEqual(flagged.filter(slice => slice.kind.startsWith("held_")).map(slice => slice.kind), ["held_prod", "held_staging"]);
  assert.ok(!flagged.some(slice => slice.kind === "regression"));
  assert.equal(state.verdicts["staging GET /v1/tiktok/user_detail"], "ok");
});

test("a call whose input comes only from held answers is held, not unprobed", () => {
  // 11-20 11:5xZ: staging held post_comments, explore and every answer with a media URL, and d2 read 3 of its 8 judged routes as unprobed.
  const held: ProbeResult = { op: "GET /v1/facebook/post_comments", verdict: "held", status: 503, ms: 200, code: "upstream_error", note: "docs example" };
  assert.equal(heldInput("GET /v1/facebook/post_comment_replies", "expansion_token", [held])!.verdict, "held");
  assert.equal(heldInput(MEDIA_OP, "/v1/media URL", [held, { ...held, verdict: "crawler" }])!.verdict, "held");
  assert.equal(heldInput(MEDIA_OP, "/v1/media URL", [held, ok("GET /v1/instagram/user_feed")]), null);
  assert.equal(heldInput(MEDIA_OP, "/v1/media URL", [{ ...held, verdict: "crawler" }]), null);
});

test("a snapshot whose every row failed is held while the proxy supply is held, and the portal's otherwise", () => {
  // 11-20 11:5xZ: every staging batch row failed under the geonode hold, and d2 flagged GET /v1/batch/snapshot/{snapshot_id} as a portal fix.
  const read = ok("GET /v1/batch/snapshot/{snapshot_id}");
  const broken = "every row of the job failed (rows_failed 3 of 3)";
  assert.equal(snapshotRowsVerdict(read, broken, "geonode proxy_auth_failed").verdict, "held");
  assert.equal(snapshotRowsVerdict(read, broken, null).verdict, "portal");
  assert.equal(snapshotRowsVerdict(read, null, "geonode proxy_auth_failed").verdict, "ok");
});

test("the media read is held when no working answer linked a media URL and the answers that would have were held", () => {
  // 11-20 12:0xZ: staging's 5 working answers linked no /v1/media URL, every profile read was held, and d2 read the media route as unprobed.
  const held: ProbeResult = { op: "GET /v1/instagram/user_feed", verdict: "held", status: 503, ms: 200, code: "upstream_error", note: "docs example" };
  const url = "https://staging-api.virev.ai/v1/media/tiktok_account/275923/profile_pic?e=1795824000&s=7334454549c453ddf83cf23898bf4a00";
  assert.equal(heldMedia(null, [ok("GET /v1/search/languages"), held])!.verdict, "held");
  assert.equal(heldMedia(url, [held]), null);
  assert.equal(heldMedia(null, [ok("GET /v1/search/languages")]), null);
});
