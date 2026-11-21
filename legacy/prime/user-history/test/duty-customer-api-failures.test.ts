// Guards the Customer API failures duty of the api portal vp chat, which keeps board goal p80 met: 0.32% customer prod 5xx on 11-01 UTC
// (5 of 1,576), after about 31% of customer calls failed from 10-13 to 10-26.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingUntil } from "../scripts/duties/chat-system.ts";
import { handleOf, hog, lastFullDay, report, UNMEASURED } from "../scripts/duties/customer-api-failures.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

test("the window is the last full UTC day", () => {
  assert.deepEqual(lastFullDay(Date.parse("2026-11-04T00:10:00Z")), { start: "2026-11-03 00:00:00", end: "2026-11-04 00:00:00" });
});

test("the share is 5xx over completed plus failed, and each 5xx is flagged with its handle and request id (11-01 UTC)", () => {
  const out = report({ completed: 1_452, failed: 124, failed5xx: 5 }, [
    { at: "2026-11-01T01:40:27.435Z", endpoint: "instagram.web_profile_info", status: 502, errorCode: "upstream_error", handle: "dinkey727",
      requestId: "req_a", orgId: "org_3KauwxlZ8kv5BKXXTtUnvw7jPLp" },
  ], { start: "2026-11-01 00:00:00" }, 151, []);
  assert.equal(out.metrics.customer_5xx_share_pct, 0.32);
  assert.equal(out.metrics.source_errors, 0);
  assert.match(out.flagged![0]!.excerpt, /5 customer 5xx of 1576 attempts \(0\.32%\).*151 min/);
  assert.match(out.flagged![2]!.excerpt, /@dinkey727 req_a/);
  const rollsAt = Date.parse("2026-11-03T00:00:00Z");
  assert.deepEqual(out.rollsAt, { customer_5xx_share_pct: rollsAt, slow_route_p90_s: rollsAt }, "the 11-01 reading holds until 11-02 rolls over");
});

test("a day with no calls reads 0, not a miss", () => {
  assert.equal(report({ completed: 0, failed: 0, failed5xx: 0 }, [], { start: "2026-11-03 00:00:00" }, null, []).metrics.customer_5xx_share_pct, 0);
});

test("the handle comes from the crawler path", () => {
  assert.equal(handleOf("/api/live/instagram/user_feed?handle=sisterann_judy4&max_pages=1"), "sisterann_judy4");
  assert.equal(handleOf("/api/profiles/nike"), null);
});

test("slow_route_p90_s is the slowest p90 of Bing, Google Play and News over every org, and a route under 20 calls reads unknown (p111, 11-02 UTC)", () => {
  const day = { start: "2026-11-02 00:00:00" };
  const counts = { completed: 0, failed: 0, failed5xx: 0 };
  const measured = report(counts, [], day, null, [
    { endpoint: "search.bing", calls: 198, p90Ms: 30_680 }, { endpoint: "crawl.google.play_app", calls: 134, p90Ms: 4_659 },
    { endpoint: "crawl.google.news", calls: 134, p90Ms: 3_177 }]);
  assert.equal(measured.metrics.slow_route_p90_s, 30.68);
  assert.match(measured.flagged![1]!.excerpt, /slowest p90, all orgs: 30\.68 s; search\.bing 198 calls p90 30\.68 s/);
  const quiet = report(counts, [], day, null, [
    { endpoint: "search.bing", calls: 36, p90Ms: 3_536 }, { endpoint: "crawl.google.play_app", calls: 19, p90Ms: 1_470 }]);
  assert.equal(quiet.metrics.slow_route_p90_s, UNMEASURED);
});

test("a route that answers only 5xx reads unknown, never fast (Bing during the GeoNode outage, 11-11 UTC)", () => {
  const down = report({ completed: 0, failed: 0, failed5xx: 0 }, [], { start: "2026-11-11 00:00:00" }, null, [
    { endpoint: "search.bing", calls: 0, p90Ms: null, failed5xx: 94 }, { endpoint: "crawl.google.play_app", calls: 93, p90Ms: 1_072 },
    { endpoint: "crawl.google.news", calls: 92, p90Ms: 1_146 }]);
  assert.equal(down.metrics.slow_route_p90_s, UNMEASURED);
  assert.match(down.flagged![1]!.excerpt, /search\.bing 0 calls p90 none, 94 answered 5xx/);
});

test("a quiet day reads each route's newest 20 answered calls instead of the placeholder (d4 read error 3 runs in a row, 11-15 UTC)", () => {
  const since = Date.parse("2026-11-09T05:42:57Z");
  const quiet = report({ completed: 0, failed: 0, failed5xx: 0 }, [], { start: "2026-11-15 00:00:00" }, null, [
    { endpoint: "search.bing", calls: 7, p90Ms: 1_330, failed5xx: 2, pool: { calls: 20, p90Ms: 9_203, since } },
    { endpoint: "crawl.google.play_app", calls: 9, p90Ms: 820, pool: { calls: 20, p90Ms: 1_029, since } },
    { endpoint: "crawl.google.news", calls: 9, p90Ms: 910, pool: { calls: 20, p90Ms: 962, since } }]);
  assert.equal(quiet.metrics.slow_route_p90_s, 9.2);
  assert.match(quiet.flagged![1]!.excerpt, /search\.bing 7 calls p90 1\.33 s \(newest 20 since 2026-11-09T05:42Z: p90 9\.2 s\), 2 answered 5xx/);
});

test("a rerun of a closed day reads quiet until the next UTC midnight, while the day's first run reads live (d4, 11-05)", () => {
  const metrics: DutyMetric[] = [{ key: "slow_route_p90_s", label: "Slowest p90", op: "<=", target: 5, unit: "s" }];
  const counts = { completed: 0, failed: 0, failed5xx: 0 };
  const bing = (p90Ms: number, lastAt: string) => [{ endpoint: "search.bing", calls: 61, p90Ms, lastAt: Date.parse(lastAt) },
    { endpoint: "crawl.google.play_app", calls: 40, p90Ms: 2_000, lastAt: Date.parse("2026-11-04T20:00:00Z") },
    { endpoint: "crawl.google.news", calls: 40, p90Ms: 2_000 }];
  const run = (at: string, day: string, p90Ms: number, lastAt: string): DutyRunRecord => ({ duty: "d4", at: Date.parse(at), trigger: "push", ms: 1,
    ...judge(metrics, report(counts, [], { start: day }, null, bing(p90Ms, lastAt))) });
  const before = run("2026-11-04T00:33:25Z", "2026-11-03 00:00:00", 4_000, "2026-11-03T23:50:00Z");
  const first = run("2026-11-05T00:33:27Z", "2026-11-04 00:00:00", 22_590, "2026-11-04T23:58:00Z");
  assert.equal(first.metrics.slow_route_p90_s!.lastEventAt, Date.parse("2026-11-04T23:58:00Z"), "the newest slow-route call of the day");
  assert.equal(metricStreaks([first, before])[0]!.quietSince, undefined, "11-04 had calls after the run before");
  const rerun = run("2026-11-05T02:10:00Z", "2026-11-04 00:00:00", 22_590, "2026-11-04T23:58:00Z");
  const runs = [rerun, first, before];
  assert.equal(metricStreaks(runs)[0]!.quietSince, Date.parse("2026-11-04T23:58:00Z"));
  assert.equal(agingUntil(runs), Date.parse("2026-11-06T00:00:00Z"));
});

test("a PostHog 503 or 504 is sent once more, and a 4xx or a second 5xx still throws (11-13 and 11-21 00:00Z runs)", async () => {
  const sender = (statuses: number[]) => {
    const seen: number[] = [];
    const send = (async () => {
      const status = statuses[seen.length]!;
      seen.push(status);
      return new Response(status === 200 ? JSON.stringify({ results: [[1]] }) : "busy", { status });
    }) as typeof fetch;
    return { send, seen };
  };
  for (const busy of [503, 504]) {
    const once = sender([busy, 200]);
    assert.deepEqual(await hog("k", "select 1", once.send), [[1]]);
    assert.deepEqual(once.seen, [busy, 200]);
  }
  const twice = sender([503, 504, 200]);
  await assert.rejects(hog("k", "select 1", twice.send), /answered 504/);
  assert.equal(twice.seen.length, 2);
  const denied = sender([403, 200]);
  await assert.rejects(hog("k", "select 1", denied.send), /answered 403/);
  assert.equal(denied.seen.length, 1);
});
