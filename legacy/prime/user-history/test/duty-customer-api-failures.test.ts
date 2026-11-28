// Guards the Customer API failures duty of the api portal vp chat, which keeps board goal p80 met: 0.32% customer prod 5xx on 11-01 UTC
// (5 of 1,576), after about 31% of customer calls failed from 10-13 to 10-26.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingUntil } from "../scripts/duties/chat-system.ts";
import { daySql, lastFullDay, pairJumps, pairsSql, poolSql, report, ROUTE_P90_TARGET_S, routesSql, UNMEASURED } from "../scripts/duties/customer-api-failures.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

test("the window is the last full UTC day", () => {
  assert.deepEqual(lastFullDay(Date.parse("2026-11-04T00:10:00Z")), { start: "2026-11-03 00:00:00", end: "2026-11-04 00:00:00" });
});

test("the share is 5xx over every customer call, and each 5xx is flagged with its operation and request id (11-01 UTC)", () => {
  const out = report({ calls: 1_576, failed5xx: 5 }, [
    { at: Date.parse("2026-11-01T01:40:27.435Z"), endpoint: "instagram.web_profile_info", status: 502, errorCode: "upstream_error",
      requestId: "req_a", orgId: "org_3KauwxlZ8kv5BKXXTtUnvw7jPLp" },
  ], { start: "2026-11-01 00:00:00" }, 151, []);
  assert.equal(out.metrics.customer_5xx_share_pct, 0.32);
  assert.equal(out.metrics.source_errors, 0);
  assert.match(out.flagged![0]!.excerpt, /5 customer 5xx of 1576 calls \(0\.32%\).*151 min/);
  assert.match(out.flagged![2]!.excerpt, /instagram\.web_profile_info 502 upstream_error req_a/);
  const rollsAt = Date.parse("2026-11-03T00:00:00Z");
  assert.deepEqual(out.rollsAt, { customer_5xx_share_pct: rollsAt, slow_route_over_target_s: rollsAt, org_operation_jumps: rollsAt }, "the 11-01 reading holds until 11-02 rolls over");
});

test("a day with no calls reads 0, not a miss", () => {
  assert.equal(report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-03 00:00:00" }, null, []).metrics.customer_5xx_share_pct, 0);
});

test("customer calls come from the house-free view less org_test_, and route p90s from every org's answered charges (11-26)", () => {
  const day = lastFullDay(Date.parse("2026-11-26T02:40:00Z"));
  const calls = daySql(day);
  assert.match(calls, /FROM product\.customer_usage_events WHERE ts >= toDateTime64\('2026-11-25 00:00:00', 3, 'UTC'\)/);
  assert.match(calls, /action IN \('crawl_read', 'data_api_request'\) AND api_key_id != '' AND NOT startsWith\(org_id, 'org_test_'\)/);
  assert.doesNotMatch(calls, /posthog|is_internal/i);
  for (const sql of [routesSql(day), poolSql(day)]) {
    assert.match(sql, /FROM product\.usage_events\s+WHERE action = 'data_api_call' AND kind = 'charge' AND http_status BETWEEN 200 AND 399/);
    assert.match(sql, /route IN \('search\.bing', 'crawl\.google\.play_app', 'crawl\.google\.news'\)/);
  }
  assert.match(poolSql(day), /ts < toDateTime64\('2026-11-26 00:00:00', 3, 'UTC'\)/);
  assert.match(poolSql(day), /ORDER BY at DESC LIMIT 20 BY endpoint/);
});

test("slow_route_over_target_s is the most a route's p90 sits over its own target, and a route under 20 calls reads unknown (p111, 11-02 UTC)", () => {
  const day = { start: "2026-11-02 00:00:00" };
  const counts = { calls: 0, failed5xx: 0 };
  const measured = report(counts, [], day, null, [
    { endpoint: "search.bing", calls: 198, p90Ms: 30_680 }, { endpoint: "crawl.google.play_app", calls: 134, p90Ms: 4_659 },
    { endpoint: "crawl.google.news", calls: 134, p90Ms: 3_177 }]);
  assert.equal(measured.metrics.slow_route_over_target_s, 8.68);
  assert.match(measured.flagged![1]!.excerpt, /most over its own p90 target, all orgs: 8\.68 s; search\.bing 198 calls p90 30\.68 s against 22 s/);
  const quiet = report(counts, [], day, null, [
    { endpoint: "search.bing", calls: 36, p90Ms: 3_536 }, { endpoint: "crawl.google.play_app", calls: 19, p90Ms: 1_470 }]);
  assert.equal(quiet.metrics.slow_route_over_target_s, UNMEASURED);
});

test("Bing is held to 22 s, the crawler's 20 s give-up, while Google Play and News keep 5 s (4940339b9, 11-26)", () => {
  assert.deepEqual(ROUTE_P90_TARGET_S, { "search.bing": 22, "crawl.google.play_app": 5, "crawl.google.news": 5 });
  const metrics: DutyMetric[] = [{ key: "slow_route_over_target_s", label: "Over target", op: "<=", target: 0, unit: "s" }];
  const day = { start: "2026-11-25 00:00:00" };
  const counts = { calls: 0, failed5xx: 0 };
  const read = (bing: number, play: number) => report(counts, [], day, null, [{ endpoint: "search.bing", calls: 80, p90Ms: bing },
    { endpoint: "crawl.google.play_app", calls: 40, p90Ms: play }, { endpoint: "crawl.google.news", calls: 40, p90Ms: 3_000 }]);
  const blockedBing = read(19_800, 3_100);
  assert.equal(blockedBing.metrics.slow_route_over_target_s, -1.9, "Play sits 1.9 s under 5 s and Bing 2.2 s under 22 s");
  assert.equal(judge(metrics, blockedBing).verdict, "met", "a 19.8 s Bing p90 no longer misses the 5 s line");
  const slowPlay = read(9_000, 6_200);
  assert.equal(slowPlay.metrics.slow_route_over_target_s, 1.2, "Play at 6.2 s misses although Bing is far slower");
  assert.equal(judge(metrics, slowPlay).verdict, "missed");
  assert.equal(judge(metrics, read(24_500, 3_100)).verdict, "missed", "Bing past the crawler's give-up misses");
});

test("a route that answers only 5xx reads unknown, never fast (Bing during the GeoNode outage, 11-11 UTC)", () => {
  const down = report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-11 00:00:00" }, null, [
    { endpoint: "search.bing", calls: 0, p90Ms: null, failed5xx: 94 }, { endpoint: "crawl.google.play_app", calls: 93, p90Ms: 1_072 },
    { endpoint: "crawl.google.news", calls: 92, p90Ms: 1_146 }]);
  assert.equal(down.metrics.slow_route_over_target_s, UNMEASURED);
  assert.match(down.flagged![1]!.excerpt, /search\.bing 0 calls p90 none against 22 s, 94 answered 5xx/);
});

test("a quiet day reads each route's newest 20 answered calls instead of the placeholder (d4 read error 3 runs in a row, 11-15 UTC)", () => {
  const since = Date.parse("2026-11-09T05:42:57Z");
  const quiet = report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-15 00:00:00" }, null, [
    { endpoint: "search.bing", calls: 7, p90Ms: 1_330, failed5xx: 2, pool: { calls: 20, p90Ms: 9_203, since } },
    { endpoint: "crawl.google.play_app", calls: 9, p90Ms: 820, pool: { calls: 20, p90Ms: 1_029, since } },
    { endpoint: "crawl.google.news", calls: 9, p90Ms: 910, pool: { calls: 20, p90Ms: 962, since } }]);
  assert.equal(quiet.metrics.slow_route_over_target_s, -3.97, "Play's pooled 1.03 s sits closest to its 5 s");
  assert.match(quiet.flagged![1]!.excerpt, /search\.bing 7 calls p90 1\.33 s \(newest 20 since 2026-11-09T05:42Z: p90 9\.2 s\) against 22 s, 2 answered 5xx/);
});

test("a rerun of a closed day reads quiet until the next UTC midnight, while the day's first run reads live (d4, 11-05)", () => {
  const metrics: DutyMetric[] = [{ key: "slow_route_over_target_s", label: "Over target", op: "<=", target: 0, unit: "s" }];
  const counts = { calls: 0, failed5xx: 0 };
  const bing = (p90Ms: number, lastAt: string) => [{ endpoint: "search.bing", calls: 61, p90Ms, lastAt: Date.parse(lastAt) },
    { endpoint: "crawl.google.play_app", calls: 40, p90Ms: 2_000, lastAt: Date.parse("2026-11-04T20:00:00Z") },
    { endpoint: "crawl.google.news", calls: 40, p90Ms: 2_000 }];
  const run = (at: string, day: string, p90Ms: number, lastAt: string): DutyRunRecord => ({ duty: "d4", at: Date.parse(at), trigger: "push", ms: 1,
    ...judge(metrics, report(counts, [], { start: day }, null, bing(p90Ms, lastAt))) });
  const before = run("2026-11-04T00:33:25Z", "2026-11-03 00:00:00", 4_000, "2026-11-03T23:50:00Z");
  const first = run("2026-11-05T00:33:27Z", "2026-11-04 00:00:00", 22_590, "2026-11-04T23:58:00Z");
  assert.equal(first.metrics.slow_route_over_target_s!.lastEventAt, Date.parse("2026-11-04T23:58:00Z"), "the newest slow-route call of the day");
  assert.equal(metricStreaks([first, before])[0]!.quietSince, undefined, "11-04 had calls after the run before");
  const rerun = run("2026-11-05T02:10:00Z", "2026-11-04 00:00:00", 22_590, "2026-11-04T23:58:00Z");
  const runs = [rerun, first, before];
  assert.equal(metricStreaks(runs)[0]!.quietSince, Date.parse("2026-11-04T23:58:00Z"));
  assert.equal(agingUntil(runs), Date.parse("2026-11-06T00:00:00Z"));
});

test("n is the day's attempts and the calls behind the route p90s, and a day with no calls reads n 0 and says so (c249)", () => {
  const out = report({ calls: 1_576, failed5xx: 5 }, [], { start: "2026-11-01 00:00:00" }, 151, []);
  assert.deepEqual(out.n, { customer_5xx_share_pct: 1_576, slow_route_over_target_s: 0, org_operation_jumps: 0, source_errors: 1 });
  const empty = report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-03 00:00:00" }, null, []);
  assert.equal(empty.n.customer_5xx_share_pct, 0);
  assert.match(empty.flagged![0]!.excerpt, /read 0 calls and measured nothing/);
});

// Owner, #1124-cost-management p52 and p54 (11-28): a PostHog sync cost up to $80 a day for 11 days because its duty judged only a total.
// org_virev_gtm_outreach ran 6,804 crawl.web_scraping_api calls on 11-26 UTC from none, which no total or share in d4 showed.
test("org_operation_jumps counts pairs whose calls or 5xx are over 3 times their own 7-day median and over the floor (11-26 UTC)", () => {
  const rows = [
    { day: "2026-11-26", org: "org_virev_gtm_outreach", endpoint: "crawl.web_scraping_api", calls: 6_804, failed5xx: 114 },
    ...["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"].flatMap(day => [
      { day, org: "org_3Ez44ZRW3ZQrMW6a8PHoM9Oa0uY", endpoint: "search.google", calls: 900, failed5xx: day === "2026-11-26" ? 59 : 24 },
      { day, org: "org_3KGSzGiH5JHPkMcDcrlaHTG0BUz", endpoint: "instagram.web_profile_info", calls: day === "2026-11-26" ? 1_200 : 500, failed5xx: 0 }]),
    { day: "2026-11-26", org: "org_3K6CrZ5L593T4KcvfGBdvMWrpfO", endpoint: "instagram.user_feed", calls: 1, failed5xx: 1 },
    { day: "2026-11-10", org: "org_old", endpoint: "youtube.video", calls: 5_000, failed5xx: 0 },
  ];
  const { jumps, pairs } = pairJumps(rows, "2026-11-26");
  assert.equal(pairs, 4, "a pair with no call in the 8 days is not read");
  assert.deepEqual(jumps, [
    { org: "org_virev_gtm_outreach", endpoint: "crawl.web_scraping_api", kind: "calls", value: 6_804, median: 0 },
    { org: "org_virev_gtm_outreach", endpoint: "crawl.web_scraping_api", kind: "failed5xx", value: 114, median: 0 },
  ], "2.4 times its median, a 0 to 1 pair and 59 5xx at 2.5 times stay quiet");
  const out = report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-26 00:00:00" }, null, [], rows);
  assert.equal(out.metrics.org_operation_jumps, 2);
  assert.equal(out.n.org_operation_jumps, 4);
  assert.match(out.flagged!.find(slice => slice.kind.startsWith("jump_calls"))!.excerpt,
    /org_virev_gtm_outreach crawl\.web_scraping_api: 6804 calls on 2026-11-26 UTC against a median of 0 a day over the 7 days before/);
  const empty = report({ calls: 0, failed5xx: 0 }, [], { start: "2026-11-26 00:00:00" }, null, []);
  assert.equal(empty.n.org_operation_jumps, 0);
  assert.ok(empty.flagged!.some(slice => slice.kind === "no_pairs"));
});

test("the pairs read every org's keyed calls over the day and the 7 before, less org_test_ and one-run proof orgs", () => {
  const sql = pairsSql(lastFullDay(Date.parse("2026-11-27T02:40:00Z")));
  assert.match(sql, /FROM product\.usage_events WHERE ts >= toDateTime64\('2026-11-19 00:00:00', 3, 'UTC'\) AND ts < toDateTime64\('2026-11-27 00:00:00', 3, 'UTC'\)/);
  assert.match(sql, /NOT startsWith\(org_id, 'org_test_'\) AND NOT match\(org_id, '_\[0-9\]\{13\}\$'\)/);
  assert.match(sql, /GROUP BY day, org, endpoint/);
});
