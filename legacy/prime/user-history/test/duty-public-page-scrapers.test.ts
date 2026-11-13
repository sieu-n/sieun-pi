// 10-28 to 10-29: a scraper on about 11,000 IPs loaded prod /profile pages and pulled every post image through /api/img with the referer
// https://virev.ai/, so the prod crawler shed public media with 503 and real users lost images. The owner made watching and blocking such
// scrapers a duty (msg mvtth6bs). These cases pin how the Public page scrapers precheck sorts calls and turns them into its three numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classify, ENGINES, humanIps, inRanges, rangeList, requestsSql, ROUTES, routeOf, type Row, scrapers, SHED_MIN_503, typicalChrome, type Verify, verifier } from "../scripts/duties/public-page-scrapers.ts";
import { type DutyMetric, judge } from "../src/shared/chat-duties.ts";
import { DAY } from "../scripts/duties/estate-reads.ts";
import { type Asn, isHosting, parseCymru } from "../scripts/duties/ip-asn.ts";
import { accountsSql, ACCOUNT_VIEWS_MAX, type Acts, type FirewallCondition, type FirewallFile, FLEET_MIN_IPS, fleetKeys, parseFirewall, replayer, type WeekRow, weeklyClients,
  weeklySql } from "../scripts/duties/weekly-scraper-blocks.ts";

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

test("KakaoBot counts as Daum from an IP on Kakao's list and as automated from anywhere else", async () => {
  // 11-10 03:30Z: 15 listed Kakao IPs and 3 spoofs sent KakaoBot to the public pages after a Korean blog post.
  const kakao = "Mozilla/5.0 (compatible; KakaoBot/1.0; +https://cs.kakao.com/helps_html/1073213012)";
  const rows = [row({ route: "profile", ua: kakao, ip: "211.249.246.168" }), row({ route: "profile", ua: kakao, ip: "207.6.89.97" })];
  const verify = await verifier(rows, [], AbortSignal.abort());
  assert.deepEqual(classify(rows[0]!, 149, verify), { kind: "wanted", who: "Daum" });
  assert.deepEqual(classify(rows[1]!, 149, verify), { kind: "automated", why: "UA claims Daum from an IP outside its ranges" });
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

// 11-03 KST: a plain Safari 26.0.1 UA pulled /profile pages from DigitalOcean IPs and a Windows Chrome 151 UA opened one profile page per home
// IP, and the owner asked for a weekly job that blocks "any sort of crawling for data extraction". These cases pin which clients it lists.
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Safari/605.1.15";
const DO: Asn = { asn: 14061, name: "DIGITALOCEAN-ASN - DigitalOcean, LLC, US", cc: "US" };
const KT: Asn = { asn: 4766, name: "KIXS-AS-KR-KR - Korea Telecom, KR", cc: "KR" };
const FIREWALL = parseFirewall({ allow: [{ ua: "Googlebot" }, { ua: "facebookexternalhit" }], deny: [{ ua: "ChatGPT-User" }], bot_patterns: ["[Bb]ot[^a-z]", "[Pp]ython"],
  own_ips: ["155.254.27.166"] });
const week = (part: Partial<WeekRow>): WeekRow => ({ ua: WIN(150), ip: "1.2.3.4", refk: "page", page: true, path: "/profile/someone", state: "origin", calls: 1, last: 10 * DAY, ...part });
const weekly = (rows: WeekRow[], asns: Map<string, Asn>, end = 10 * DAY) => weeklyClients({ rows, asns, accounts: [], judge: { verify: googleOnly, firewall: FIREWALL }, errors: [], end });
const listed = (output: ReturnType<typeof weeklyClients>) => output.flagged!.filter(slice => slice.kind.startsWith("scraper_client")).map(slice => [slice.kind, slice.sig]);

test("the weekly list names every crawler whatever its size, and never a person, an allowed indexer or our own box", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, index) => week({ ua: SAFARI, ip: `64.227.101.${index}`, refk: "none", calls: 2 })),
    week({ ua: SAFARI, ip: "183.108.170.148", calls: 4000 }),
    week({ ua: GOOGLEBOT, ip: "66.249.66.1", calls: 300 }),
    week({ ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", ip: "20.63.180.103", calls: 3 }),
    week({ ua: "python-requests/2.32", ip: "9.9.9.9", refk: "none", calls: 40, last: 8 * DAY }),
    week({ ua: "curl/8.18.0", ip: "155.254.27.166", refk: "none", calls: 90 }),
    week({ calls: 200 }),
  ];
  const asns = new Map([...Array.from({ length: 30 }, (_, index): [string, Asn] => [`64.227.101.${index}`, DO]), ["183.108.170.148", KT]]);
  const output = weekly(rows, asns);
  assert.deepEqual(listed(output), [["scraper_client", `browser UA from a hosting network | ${SAFARI}`], ["scraper_client_stopped", "bot, AI or HTTP library UA | other OS python-requests/2.32"],
    ["scraper_client", "bot, AI or HTTP library UA | ChatGPT-User"]]);
  assert.equal(output.metrics.unblocked_crawlers, 2);
  assert.match(output.flagged!.find(slice => slice.kind === "scraper_client")!.excerpt, /from 30 IPs.*AS14061.*--ua-sub '.*Version\/26\.0\.1 Safari\/605\.1\.15' --asn 14061/);
  const blocked = weekly([...rows, week({ ua: SAFARI, ip: "64.227.101.3", refk: "none", state: "denied", calls: 5, last: 10 * DAY + 1 })], asns, 10 * DAY + 2);
  assert.equal(listed(blocked)[0]![0], "scraper_client_stopped", "a client the firewall denies after its last passed call reads as blocked the same day");
});

/** acts() of auto-sns-agent scripts/repo/vercel/firewall.mjs for the condition ops these cases use, without its compile step. */
const fakeActs: Acts = (file, request) => file.rules.flatMap(rule => rule.groups.flatMap((group, at) => group.conditions.every(condition => {
  const have = condition.type === "path" ? request.path : condition.type === "user_agent" ? request.headers["user-agent"]
    : condition.type === "header" ? request.headers[condition.key!] : condition.type === "geo_as_number" ? request.asn : request.country;
  const met = condition.op === "nex" ? have === undefined : condition.op === "eq" ? have === condition.value : have !== undefined && new RegExp(String(condition.value)).test(have);
  return met !== Boolean(condition.neg);
}) ? [`${rule.name} group ${at}`] : []));

test("a client counts as blocked once the published deny rules cover every call shape it passed with, before it comes back (d7, 11-13)", () => {
  const rule = (action: string, ...groups: FirewallCondition[][]) => ({ name: action, action: { action }, groups: groups.map(conditions => ({ conditions })) });
  const file: FirewallFile = { own_ua_env: "FIREWALL_OWN_UA", rules: [
    rule("deny", [{ type: "user_agent", op: "re", value: "Version/26\\.0\\.1 Safari" }, { type: "header", key: "referer", op: "nex" }],
      [{ type: "user_agent", op: "re", value: "Googlebot" }, { type: "geo_as_number", op: "eq", neg: true, value: "15169" }],
      [{ type: "user_agent", op: "re", value: "Chrome/" }, { type: "header", key: "sec-ch-ua", op: "nex" }]),
    rule("log", [{ type: "path", op: "re", value: "^/profile/" }])] };
  const safari = Array.from({ length: 30 }, (_, index) => week({ ua: SAFARI, ip: `64.227.101.${index}`, refk: "none", calls: 2 }));
  const asns = new Map(safari.map((row): [string, Asn] => [row.ip, DO]));
  const run = (rows: WeekRow[], found = asns) => weeklyClients({ rows, asns: found, accounts: [], judge: { verify: googleOnly, firewall: FIREWALL }, errors: [], end: 10 * DAY,
    replay: replayer(file, fakeActs) });
  assert.deepEqual(listed(run(safari)), [["scraper_client_stopped", `browser UA from a hosting network | ${SAFARI}`]]);
  assert.equal(run(safari).metrics.unblocked_crawlers, 0);
  assert.match(run(safari).flagged!.find(slice => slice.kind === "scraper_client_stopped")!.excerpt, /rules now deny 30 of its 30 passed call shapes/);
  assert.equal(run([...safari, week({ ua: SAFARI, ip: "64.227.101.7", refk: "page", calls: 2 })]).metrics.unblocked_crawlers, 1, "a shape with a referer still gets through");
  const image = (ip: string) => week({ ua: SAFARI, ip, refk: "page", page: false, path: "/api/img?media=%2Fapi%2Fmedia%2Fx" });
  assert.equal(run([...safari, image("64.227.101.3")]).metrics.unblocked_crawlers, 0, "an image its page referred to follows a denied entry page from the same IP");
  assert.equal(run([...safari, image("64.227.102.1")], new Map([...asns, ["64.227.102.1", DO]])).metrics.unblocked_crawlers, 1,
    "a self-referer image call from an IP with no denied entry page still gets through");
  const fakeGooglebot = week({ ua: GOOGLEBOT, ip: "34.1.2.3", calls: 50 });
  assert.equal(run([fakeGooglebot], new Map([["34.1.2.3", { asn: 396982, name: "GOOGLE-CLOUD-PLATFORM, US", cc: "US" }]])).metrics.unblocked_crawlers, 0);
  assert.equal(run([fakeGooglebot], new Map()).metrics.unblocked_crawlers, 1, "with no ASN the replay also tries AS15169, which the rule spares");
  assert.equal(run([week({ ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0", ip: "64.227.101.1", refk: "bare_self" })]).metrics.unblocked_crawlers, 1,
    "the log has no sec-ch-ua, so a rule that needs it absent proves nothing");
});

test("unblocked_crawlers' lastEventAt is the newest call of a client still getting through, and none once every client stopped (ops guy, 2026-11-10)", () => {
  const chatgpt = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
  const stale = week({ ua: "python-requests/2.32", ip: "9.9.9.9", refk: "none", calls: 40, last: 8 * DAY });
  const output = weekly([stale, week({ ua: chatgpt, ip: "20.63.180.103", calls: 3, last: 10 * DAY - 1000 }), week({ calls: 200 })], new Map());
  assert.deepEqual(output.lastEventAt, { unblocked_crawlers: 10 * DAY - 1000 });
  assert.equal(weekly([stale, week({ calls: 200 })], new Map()).lastEventAt, undefined);
});

test("a browser UA whose home IPs each open one page with no referer is a fleet, and the same UA with referers stays a person", () => {
  const fleet = Array.from({ length: FLEET_MIN_IPS }, (_, index) => week({ ua: WIN(151), ip: `73.0.0.${index}`, refk: "none" }));
  const people = [...Array.from({ length: 10 }, (_, index) => week({ ua: WIN(151), ip: `98.0.0.${index}`, refk: "other", calls: 3 }))];
  const output = weekly([...fleet, ...people], new Map());
  assert.deepEqual(listed(output), [["scraper_client", `one or two pages per IP with no referer, rotating IPs | ${WIN(151)}`]]);
  assert.match(output.flagged!.find(slice => slice.kind === "scraper_client")!.excerpt, /\(20 calls, 20 pages\) from 20 IPs/);
  assert.equal(fleetKeys([...fleet.slice(0, FLEET_MIN_IPS - 1), ...people]).size, 0, "fewer lone IPs than the line is no fleet");
});

test("a signed-in account over the daily profile line is listed for a ban check", () => {
  const output = weeklyClients({ rows: [week({ calls: 5 })], asns: new Map(), judge: { verify: googleOnly, firewall: FIREWALL }, errors: [], end: 10 * DAY,
    accounts: [{ user: "user_heavy", day: "2026-11-02", views: ACCOUNT_VIEWS_MAX + 1, ips: 3 }, { user: "user_normal", day: "2026-11-02", views: 7, ips: 1 }] });
  assert.equal(output.metrics.heavy_view_accounts, 1);
  assert.deepEqual(output.flagged!.filter(slice => slice.kind === "heavy_view_account").map(slice => slice.sig), ["account user_heavy"]);
  assert.match(accountsSql(10 * DAY), /startsWith\(Body, 'profile_view '\)/);
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
