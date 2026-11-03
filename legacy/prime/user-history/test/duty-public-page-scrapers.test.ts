// 10-28 to 10-29: a scraper on about 11,000 IPs loaded prod /profile pages and pulled every post image through /api/img with the referer
// https://virev.ai/, so the prod crawler shed public media with 503 and real users lost images. The owner made watching and blocking such
// scrapers a duty (msg mvtth6bs). These cases pin how the Public page scrapers precheck sorts calls and turns them into its three numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classify, ENGINES, humanIps, inRanges, rangeList, requestsSql, ROUTES, routeOf, type Row, scrapers, SHED_MIN_503, typicalChrome, type Verify } from "../scripts/duties/public-page-scrapers.ts";
import { type DutyMetric, judge } from "../src/shared/chat-duties.ts";
import { DAY } from "../scripts/duties/estate-reads.ts";
import { type Asn, isHosting, parseCymru } from "../scripts/duties/ip-asn.ts";
import { lookupIps, type WeekRow, weeklyClients, weeklySql } from "../scripts/duties/weekly-scraper-blocks.ts";

const duty = JSON.parse(readFileSync(new URL("../scripts/duties/public-page-scrapers.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };
const WIN = (major: number | string) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}${typeof major === "number" ? ".0.0.0" : ""} Safari/537.36`;
const MAC = (major: number) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
const GOOGLEBOT = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const row = (part: Partial<Row>): Row => ({ route: "img", refk: "page", ref: "https://virev.ai/en/profile/ritatamer", ua: WIN(150), ip: "1.2.3.4", status: 200, origin: true, calls: 1, last: 0, ...part });
const googleOnly: Verify = { engine: (engine, ip) => engine.name === "Google" ? ip.startsWith("66.249.") : null };

test("routes cover the public database pages and their media, and leave out marketing pages", () => {
  assert.equal(routeOf("/en/profile/ritatamer"), "profile");
  assert.equal(routeOf("/profile/ritatamer/__data.json?x-sveltekit-invalidated=01"), "profile");
  assert.equal(routeOf("/ko/top-fitness-influencers-in-japan"), "creator_list");
  assert.equal(routeOf("/viral-electronic-music-posts"), "creator_list");
  assert.equal(routeOf("/japan-influencer-marketing"), "creator_list");
  assert.equal(routeOf("/en/tools/instagram-engagement-rate-calculator/nike"), "tool_result");
  assert.equal(routeOf("/api/img?media=%2Fapi%2Fmedia%2Finstagram_post%2F55962288%2Fpost_image"), "img");
  assert.equal(routeOf("/api/ig-grid/ritatamer?page=3"), "ig_grid");
  assert.equal(routeOf("/en/tools/instagram-engagement-rate-calculator"), null);
  assert.equal(routeOf("/pricing"), null);
  assert.equal(routeOf("/blog/some-article"), null);
  for (const [name] of ROUTES) assert.match(requestsSql(1_793_300_000_000), new RegExp(`'${name}'`));
});

test("calls from our own boxes count as wanted, whatever UA our jobs send", () => {
  assert.deepEqual(classify(row({ ip: "155.254.27.166", ua: "curl/8.18.0", refk: "none", route: "profile" }), 149, googleOnly), { kind: "wanted", who: "our own box" });
  assert.equal(classify(row({ ip: "155.254.27.167", ua: "curl/8.18.0", refk: "none", route: "profile" }), 149, googleOnly).kind, "automated");
});

test("the 10-29 scraper's calls read as automated and a person's calls read as human", () => {
  const typical = 149;
  assert.deepEqual(classify(row({ refk: "bare_self", ref: "https://virev.ai/", ua: WIN(133) }), typical, googleOnly).kind, "automated");
  assert.deepEqual(classify(row({}), typical, googleOnly), { kind: "human" });
  assert.equal(classify(row({ route: "profile", refk: "none", ref: "", ua: WIN(124) }), typical, googleOnly).kind, "automated");
  assert.equal(classify(row({ route: "profile", refk: "none", ref: "", ua: WIN("124") }), typical, googleOnly).kind, "automated");
  assert.equal(classify(row({ route: "profile", refk: "none", ref: "", ua: MAC(124) }), typical, googleOnly).kind, "human");
  assert.equal(classify(row({ route: "profile", refk: "none", ref: "", ua: WIN(140) }), typical, googleOnly).kind, "human");
  assert.equal(classify(row({ route: "profile", ua: "curl/8.18.0" }), typical, googleOnly).kind, "automated");
  assert.equal(classify(row({ route: "profile", ua: "" }), typical, googleOnly).kind, "automated");
});

test("a search engine counts as wanted only from its own IPs, and a link preview only on pages", () => {
  assert.deepEqual(classify(row({ route: "profile", ua: GOOGLEBOT, ip: "66.249.66.1" }), 149, googleOnly), { kind: "wanted", who: "Google" });
  assert.equal(classify(row({ route: "profile", ua: GOOGLEBOT, ip: "45.174.238.246" }), 149, googleOnly).kind, "automated");
  assert.equal(classify(row({ route: "profile", ua: "facebookexternalhit/1.1" }), 149, googleOnly).kind, "wanted");
  assert.equal(classify(row({ route: "img", ua: "facebookexternalhit/1.1" }), 149, googleOnly).kind, "automated");
  assert.ok(ENGINES.some(engine => engine.ua.test(GOOGLEBOT)));
});

test("published ranges match IPv4 and IPv6 addresses", () => {
  const list = rangeList([{ prefixes: [{ ipv4Prefix: "66.249.64.0/27" }, { ipv6Prefix: "2001:4860:4801:10::/64" }] }]);
  assert.equal(inRanges(list, "66.249.64.5"), true);
  assert.equal(inRanges(list, "66.249.65.5"), false);
  assert.equal(inRanges(list, "2001:4860:4801:10::1"), true);
  assert.equal(inRanges(list, "not an ip"), false);
});

test("the typical Chrome major is the most called one, so one fake Chrome 157 does not move the line", () => {
  assert.equal(typicalChrome([row({ ua: WIN(149), calls: 50 }), row({ ua: WIN(157), calls: 1 }), row({ refk: "none", ua: WIN(120), calls: 500 })]), 149);
});

test("the 10-29 readings miss every target and a 10-27 day meets them", () => {
  const scraped = scrapers({ end: 1, errors: [], verify: googleOnly,
    rows: [row({ calls: 90, status: 200 }), row({ calls: 10, status: 503 }), row({ refk: "bare_self", ref: "https://virev.ai/", ua: WIN(133), calls: 300 }),
      row({ refk: "bare_self", ref: "https://virev.ai/", ua: WIN(133), calls: 50, origin: false, status: 403 })],
    shed: [{ minute: 60_000, s503: 1062 }, { minute: 120_000, s503: 2 }, ...Array.from({ length: 4 }, (_, index) => ({ minute: (index + 3) * 60_000, s503: SHED_MIN_503 }))] });
  assert.deepEqual(scraped.metrics, { scraper_share_pct: 75, real_user_image_ok_pct: 90, crawler_shed_min: 5 });
  assert.match(scraped.flagged!.find(slice => slice.item === "scraper_share_pct" && slice.kind === "reading")!.excerpt, /denied 50 more before origin \(img 50\)/);
  assert.match(scraped.flagged!.find(slice => slice.kind === "scraper_pattern")!.excerpt, /bare origin .*: 300 origin calls from 1 IPs/);
  assert.equal(judge(duty.metrics, scraped).verdict, "missed");
  const quiet = scrapers({ end: 1, errors: [], verify: googleOnly, shed: [{ minute: 60_000, s503: 37 }],
    rows: [row({ calls: 996 }), row({ calls: 4, status: 503 }), row({ refk: "bare_self", ref: "https://virev.ai/", ua: WIN(133), calls: 100 })] });
  assert.equal(judge(duty.metrics, quiet).verdict, "met");
});

test("a source that fails leaves its numbers out with a source error", () => {
  const output = scrapers({ end: 1, errors: ["Bing IP ranges: fetch failed"], verify: googleOnly, rows: new Error("Grafana HTTP 502"), shed: [] });
  assert.deepEqual(output.metrics, { crawler_shed_min: 0 });
  assert.deepEqual(output.flagged!.filter(slice => slice.kind === "source_error").map(slice => slice.excerpt), ["Bing IP ranges: fetch failed", "search requests: Grafana HTTP 502"]);
});

// 11-03 KST: a plain Safari 26.0.1 UA pulled 425 /profile pages in an hour from 264 IPs, mostly DigitalOcean, and the owner asked for a weekly
// job that blocks every client at 1% or more ("even 1%"). These cases pin which clients the weekly precheck lists.
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Safari/605.1.15";
const DO: Asn = { asn: 14061, name: "DIGITALOCEAN-ASN - DigitalOcean, LLC, US", cc: "US" };
const KT: Asn = { asn: 4766, name: "KIXS-AS-KR-KR - Korea Telecom, KR", cc: "KR" };
const week = (part: Partial<WeekRow>): WeekRow => ({ ua: WIN(150), ip: "1.2.3.4", refk: "page", page: true, state: "origin", calls: 1, last: 10 * DAY, ...part });

test("the weekly list names a browser UA from a hosting network and a rotating bot, and never a person, a verified engine or a blocked client", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, index) => week({ ua: SAFARI, ip: `64.227.101.${index}`, refk: "none", calls: 2 })),
    week({ ua: SAFARI, ip: "183.108.170.148", calls: 400 }),
    week({ ua: GOOGLEBOT, ip: "66.249.66.1", calls: 300 }),
    week({ ua: "python-requests/2.32", ip: "9.9.9.9", refk: "none", calls: 40, last: 8 * DAY }),
    week({ ua: "Go-http-client/1.1", ip: "8.8.4.4", refk: "none", calls: 500, state: "denied" }),
    week({ calls: 200 }),
  ];
  const asns = new Map([...Array.from({ length: 30 }, (_, index): [string, Asn] => [`64.227.101.${index}`, DO]), ["183.108.170.148", KT]]);
  assert.ok(lookupIps(rows, googleOnly).has("64.227.101.7"));
  const output = weeklyClients({ rows, asns, verify: googleOnly, errors: [], end: 10 * DAY });
  const listed = output.flagged!.filter(slice => slice.kind.startsWith("scraper_client")).map(slice => [slice.kind, slice.sig]);
  assert.deepEqual(listed, [["scraper_client", `browser UA from a hosting network | ${SAFARI}`], ["scraper_client_stopped", "bot or HTTP library UA | other OS python-requests/2.32"]]);
  assert.deepEqual(output.metrics, { unblocked_scrapers: 1 });
  assert.match(output.flagged!.find(slice => slice.kind === "scraper_client")!.excerpt, /from 30 IPs.*AS14061.*--ua-sub '.*Version\/26\.0\.1 Safari\/605\.1\.15' --asn 14061/);
  const blocked = weeklyClients({ rows: [...rows, week({ ua: SAFARI, ip: "64.227.101.3", refk: "none", state: "denied", calls: 5, last: 10 * DAY + 1 })], asns, verify: googleOnly, errors: [], end: 10 * DAY + 2 });
  assert.equal(blocked.metrics.unblocked_scrapers, 0, "a client the firewall denies after its last passed call reads as blocked the same day");
});

test("a bulk whois answer maps each IP to its network and skips NA rows", () => {
  const found = parseCymru("Bulk mode; whois.cymru.com [2026-11-03 10:26:04 +0000]\n14061   | 64.227.101.252   | 64.227.96.0/20      | US | arin     | 2019-08-14 | DIGITALOCEAN-ASN - DigitalOcean, LLC, US\n" +
    "NA      | 10.0.0.1         | NA                  |    | other    |            | NA\n");
  assert.deepEqual([...found], [["64.227.101.252", DO]]);
  assert.equal(isHosting(DO.name), true);
  assert.equal(isHosting(KT.name), false);
  assert.equal(isHosting("CLOUDFLARENET - Cloudflare, Inc., US"), false, "iCloud Private Relay and WARP users exit through Cloudflare");
  assert.match(weeklySql(10 * DAY), /max_threads = 2/);
});

test("the daily share counts a browser UA from a hosting network as automated, and the same UA from a home line as a person", () => {
  const rows = [row({ route: "profile", refk: "none", ref: "", ua: SAFARI, ip: "64.227.101.252", calls: 30 }), row({ route: "profile", ua: SAFARI, ip: "183.108.170.148", calls: 70 })];
  assert.deepEqual([...humanIps(rows, googleOnly)].sort(), ["183.108.170.148", "64.227.101.252"]);
  const output = scrapers({ end: 1, errors: [], verify: googleOnly, shed: [], rows, asns: new Map([["64.227.101.252", DO], ["183.108.170.148", KT]]) });
  assert.equal(output.metrics.scraper_share_pct, 30);
  assert.match(output.flagged!.find(slice => slice.kind === "scraper_pattern")!.excerpt, /browser UA from a hosting network \(AS14061\).*30 origin calls from 1 IPs/);
  assert.equal(scrapers({ end: 1, errors: [], verify: googleOnly, shed: [], rows }).metrics.scraper_share_pct, 0, "with no network lookup the calls stay a person's");
});
