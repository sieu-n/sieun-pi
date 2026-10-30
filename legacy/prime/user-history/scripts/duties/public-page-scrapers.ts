import { promises as dns } from "node:dns";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, type DsQuery, grafanaClient, readGrafanaAuth, SOURCE_DEADLINE_MS, sqlRows } from "./estate-reads.ts";

/**
 * The precheck of ops guy's duty "Public page scrapers" (`node --import tsx scripts/duties/public-page-scrapers.ts`). It reads 24 h of prod
 * traffic to the logged-out pages of virev.ai that read our database or crawler, and the images they load, from ClickHouse otel.otel_logs
 * through Grafana's grafana_clickhouse source (a read-only login, so no root ssh to us-metal01, c146):
 * - `scraper_share_pct`: the share of origin calls (not a CDN hit, not denied by the Vercel Firewall) to those routes that came from
 *   automated clients other than the search engines we want. A search engine counts as wanted only when its IP is in the engine's published
 *   ranges or passes a forward-confirmed reverse DNS check.
 * - `crawler_shed_min`: minutes in which the prod crawler answered SHED_MIN_503 or more public (anonymous) /api/media calls with 503.
 * - `real_user_image_ok_pct`: the share of real users' /api/img origin calls answered without a 5xx.
 * On 10-28 and 10-29 a scraper on about 11,000 IPs loaded /profile pages and then pulled every post image through /api/img with the referer
 * https://virev.ai/ and old Windows Chrome UAs, 78% of /api/img origin calls on 10-29, so the crawler shed and real users lost images
 * (~/work/img-scraper/traffic/NOTES.md). The routes come from ~/work/public-page-scrapers/scope.md.
 * Set PUBLIC_SCRAPERS_END to an ISO time to read the 24 h before it instead of before now, for a before and after number.
 * Prints the output to OUTPUT_FILE, or to stdout when OUTPUT_FILE is unset. No model call, nothing sent outside.
 */

const CLICKHOUSE = "grafana_clickhouse";
const L = "(?:(?:en|ko|ja)/)?";
const PAGE_END = "(?:/__data\\.json)?/?(?:\\?|$)";
const TOOLS = "instagram-engagement-rate-calculator|instagram-fake-follower-checker|instagram-viewer|instagram-story-viewer|instagram-profile-picture|" +
  "instagram-money-calculator|instagram-follower-tracker|tiktok-viewer|tiktok-engagement-rate-calculator|tiktok-money-calculator|tiktok-follower-tracker|" +
  "youtube-money-calculator|youtube-subscriber-tracker|youtube-transcript";

/** Every logged-out route that reads Convex, the crawler or crawler media, by the Vercel request path (scope.md, 10-29). */
export const ROUTES: readonly (readonly [name: string, pattern: string])[] = [
  ["profile", `^/${L}profile/[^/?]+${PAGE_END}`],
  ["creator_list", `^/${L}(?:top-[a-z0-9-]+-influencers(?:-in-[a-z0-9-]+)?|viral-[a-z0-9-]+-posts|[a-z0-9-]+-influencer-(?:rates|marketing)|influencers/[^?]+)${PAGE_END}`],
  ["tool_result", `^/${L}tools/(?:${TOOLS})/[^/?]+${PAGE_END}`],
  ["email_finder", `^/${L}(?:instagram|youtube|linkedin)-email-finder${PAGE_END}`],
  ["live_page", `^/${L}live${PAGE_END}`],
  ["use_cases", `^/${L}use-cases${PAGE_END}`],
  ["sitemap", "^/sitemap\\.xml"],
  ["img", "^/api/img(?:\\?|$)"],
  ["ig_grid", "^/api/ig-grid/"],
  ["ig_tile", "^/api/ig-tile/"],
  ["avatar", "^/api/avatar(?:\\?|$)"],
  ["profile_card", "^/api/public/profile-card/"],
  ["autocomplete", "^/api/profile/autocomplete"],
  ["contact_resolve", "^/api/contact/resolve"],
  ["public_tools_api", "^/api/public-tools/(?:instagram-viewer/highlight|instagram-downloader/(?:resolve|file)|youtube-transcript/resolve)"],
  ["live_api", "^/api/live(?:\\?|$)"],
];
export const routeOf = (path: string): string | null => ROUTES.find(([, pattern]) => new RegExp(pattern).test(path))?.[0] ?? null;
const PAGE_ROUTES: ReadonlySet<string> = new Set(["profile", "creator_list", "tool_result", "email_finder", "live_page", "use_cases", "sitemap"]);

/** measured: on 10-28 06:00Z to 10-29 06:00Z, a quiet day, 3 minutes reached 10 shed 503s; from 10-29 06:00Z to 17:27Z, the scraper bursts, 31 did. */
export const SHED_MIN_503 = 10;
/**
 * measured: on 10-29 the page-referred Chrome calls to these routes peaked at majors 149 to 151, Windows ones held no major from 132 to 143, and
 * the scraper's bare-referer calls used 100 to 139, while humans on 10-28 used 0.5% Chrome 133 or older (separating_features.csv). The newest
 * major seen was a poor anchor, because one fake UA said Chrome 157; 10 below the most used major puts the line at 139 or 140, inside that gap.
 */
export const CHROME_LAG = 10;

/** The search engines we want, with where each publishes its crawler IPs, or the reverse DNS names its crawler IPs resolve to. */
export interface Engine { name: string; ua: RegExp; ranges?: readonly string[]; rdns?: RegExp }
export const ENGINES: readonly Engine[] = [
  { name: "Google", ua: /Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google|AdsBot-Google|Mediapartners-Google|FeedFetcher-Google|APIs-Google|Google-Read-Aloud/i,
    ranges: ["https://developers.google.com/static/search/apis/ipranges/googlebot.json", "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
      "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json"] },
  { name: "Bing", ua: /bingbot|BingPreview|adidxbot|MicrosoftPreview/i, ranges: ["https://www.bing.com/toolbox/bingbot.json"] },
  { name: "Apple", ua: /Applebot/i, ranges: ["https://search.developer.apple.com/applebot.json"] },
  { name: "DuckDuckGo", ua: /DuckDuckBot|DuckAssistBot/i, ranges: ["https://duckduckgo.com/duckduckbot.json"] },
  { name: "OpenAI search", ua: /OAI-SearchBot|ChatGPT-User/i, ranges: ["https://openai.com/searchbot.json", "https://openai.com/chatgpt-user.json"] },
  { name: "Perplexity", ua: /PerplexityBot|Perplexity-User/i, ranges: ["https://www.perplexity.ai/perplexitybot.json", "https://www.perplexity.ai/perplexity-user.json"] },
  { name: "Naver", ua: /Yeti\//, rdns: /\.naver\.com$/ },
  { name: "Yandex", ua: /YandexBot|YandexImages|YandexMobileBot/i, rdns: /\.yandex\.(?:ru|net|com)$/ },
  { name: "Baidu", ua: /Baiduspider/i, rdns: /\.baidu\.(?:com|jp)$/ },
  { name: "Seznam", ua: /SeznamBot/i, rdns: /\.seznam\.cz$/ },
];
/** Link preview fetchers that render a shared page once. They count as wanted on pages and as automated on image and API routes. */
export const PREVIEW_UA = /facebookexternalhit|Twitterbot|Slackbot-LinkExpanding|LinkedInBot|Discordbot|TelegramBot|WhatsApp|kakaotalk-scrap|Pinterestbot/i;
/** The public IPs of our own boxes, us-metal02 and us-metal01, whose jobs check these pages (10-29: 2,900 calls from 155.254.27.166 by curl, node, python and test UAs). */
export const OWN_IPS: ReadonlySet<string> = new Set(["155.254.27.166", "64.34.205.243"]);
export const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrap|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|undici|headless|phantom|httpclient|libwww|^node$|externalhit|externalagent|fetcher/i;

export interface Row { route: string; refk: string; ref: string; ua: string; ip: string; status: number; origin: boolean; calls: number; last: number }
export type Verdict = { kind: "human" } | { kind: "wanted"; who: string } | { kind: "automated"; why: string };
export interface Verify { engine(engine: Engine, ip: string): boolean | null }

export const chromeMajor = (ua: string): number | null => { const major = /Chrome\/(\d+)/.exec(ua)?.[1]; return major ? Number(major) : null; };

/** The Chrome major with the most calls that a page on virev.ai referred and no bot UA made, the line CHROME_LAG counts back from. */
export function typicalChrome(rows: readonly Row[]): number | null {
  const calls = new Map<number, number>();
  for (const row of rows) {
    const major = row.refk === "page" && !BOT_UA.test(row.ua) ? chromeMajor(row.ua) : null;
    if (major !== null) calls.set(major, (calls.get(major) ?? 0) + row.calls);
  }
  return [...calls].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
}

/** Who made one call group, by the features the 10-29 study separated scrapers with: UA, referer and IP. */
export function classify(row: Row, typical: number | null, verify: Verify): Verdict {
  if (OWN_IPS.has(row.ip)) return { kind: "wanted", who: "our own box" };
  const ua = row.ua.trim();
  const engine = ENGINES.find(candidate => candidate.ua.test(ua));
  if (engine) {
    const ok = verify.engine(engine, row.ip);
    return ok === false ? { kind: "automated", why: `UA claims ${engine.name} from an IP outside its ranges` } : { kind: "wanted", who: engine.name };
  }
  if (PREVIEW_UA.test(ua)) return PAGE_ROUTES.has(row.route) ? { kind: "wanted", who: "link preview" } : { kind: "automated", why: "link preview UA on an image or API route" };
  if (!ua) return { kind: "automated", why: "no user agent" };
  if (BOT_UA.test(ua)) return { kind: "automated", why: "bot or HTTP library UA" };
  if (row.refk === "bare_self") return { kind: "automated", why: "referer is the bare origin https://virev.ai/" };
  if (/Chrome\/\d+ /.test(ua)) return { kind: "automated", why: "Chrome version with no dotted build, which no real Chrome sends" };
  const major = chromeMajor(ua);
  if (major !== null && typical !== null && /Windows NT/.test(ua) && !/Edg\/|OPR\//.test(ua) && major < typical - CHROME_LAG)
    return { kind: "automated", why: `Windows Chrome more than ${CHROME_LAG} majors behind the most used one (${typical})` };
  return { kind: "human" };
}

/** The UA in a few words: the bot token, or browser, major and OS. */
export function uaFamily(ua: string): string {
  const bot = /([A-Za-z][\w.-]*(?:bot|Bot|crawler|spider|externalhit|agent|Fetcher|-User))/.exec(ua)?.[1];
  if (bot) return bot;
  if (!ua.trim()) return "(empty)";
  const os = /Windows NT/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "other OS";
  const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : chromeMajor(ua) !== null ? `Chrome ${chromeMajor(ua)}` : /Safari\//.test(ua) ? "Safari" : ua.slice(0, 40);
  return `${os} ${browser}`;
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
const utcMin = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;

export interface Inputs { rows: readonly Row[] | Error; shed: readonly { minute: number; s503: number }[] | Error; verify: Verify; errors: readonly string[]; end: number }

/** The three numbers and the rows a duty run reads to find and block the next scraper pattern. */
export function scrapers(input: Inputs): PrecheckOutput {
  const at = input.end;
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = input.errors.map(excerpt => ({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) }));
  if (input.rows instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `search requests: ${input.rows.message}`.slice(0, 600) });
  else summarize(input.rows, input.verify, at, metrics, flagged);
  if (input.shed instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `crawler 503s: ${input.shed.message}`.slice(0, 600) });
  else {
    const minutes = input.shed.filter(minute => minute.s503 >= SHED_MIN_503).sort((a, b) => a.minute - b.minute);
    metrics.crawler_shed_min = minutes.length;
    const worst = [...minutes].sort((a, b) => b.s503 - a.s503).slice(0, 5).map(minute => `${utcMin(minute.minute)} ${minute.s503}`);
    flagged.push({ at, kind: "reading", item: "crawler_shed_min", excerpt: `The prod crawler answered ${SHED_MIN_503}+ anonymous /api/media calls with 503 in ${minutes.length} minutes ` +
      `of the 24 h${minutes.length ? `, first ${utcMin(minutes[0]!.minute)}, last ${utcMin(minutes.at(-1)!.minute)}, worst ${worst.join(", ")}` : ""} (caddy access log on us-metal01).` });
  }
  return { metrics, flagged, windowMs: { scraper_share_pct: DAY, crawler_shed_min: DAY, real_user_image_ok_pct: DAY } };
}

function summarize(rows: readonly Row[], verify: Verify, at: number, metrics: Record<string, number>, flagged: FlaggedSlice[]): void {
  const typical = typicalChrome(rows);
  let origin = 0, automated = 0, wanted = 0, humanImg = 0, humanImgOk = 0, denied = 0;
  const patterns = new Map<string, { calls: number; ips: Set<string>; routes: Map<string, number>; refs: Map<string, number>; majors: Set<number>; ua: string; last: number; e5xx: number }>();
  const deniedBy = new Map<string, number>();
  for (const row of rows) {
    if (!row.origin) { if (row.status === 403) { denied += row.calls; deniedBy.set(row.route, (deniedBy.get(row.route) ?? 0) + row.calls); } continue; }
    origin += row.calls;
    const verdict = classify(row, typical, verify);
    if (verdict.kind === "wanted") { wanted += row.calls; continue; }
    if (verdict.kind === "human") {
      if (row.route === "img") { humanImg += row.calls; if (row.status < 500) humanImgOk += row.calls; }
      continue;
    }
    automated += row.calls;
    const key = `${verdict.why} | ${uaFamily(row.ua).replace(/ \d+$/, "")}`;
    const pattern = patterns.get(key) ?? { calls: 0, ips: new Set<string>(), routes: new Map(), refs: new Map(), majors: new Set<number>(), ua: row.ua, last: 0, e5xx: 0 };
    pattern.calls += row.calls;
    const major = /(?:Chrome|Firefox|Edg)\/(\d+)/.exec(row.ua)?.[1];
    if (major) pattern.majors.add(Number(major));
    pattern.ips.add(row.ip);
    pattern.routes.set(row.route, (pattern.routes.get(row.route) ?? 0) + row.calls);
    const ref = row.refk === "page" ? "a virev.ai page" : row.refk === "none" ? "none" : row.ref;
    pattern.refs.set(ref, (pattern.refs.get(ref) ?? 0) + row.calls);
    pattern.last = Math.max(pattern.last, row.last);
    if (row.status >= 500) pattern.e5xx += row.calls;
    patterns.set(key, pattern);
  }
  if (origin) {
    metrics.scraper_share_pct = pct(automated, origin);
    flagged.push({ at, kind: "reading", item: "scraper_share_pct", excerpt: `${automated} of ${origin} origin calls to the public database pages and their images were automated ` +
      `clients we do not want, ${wanted} came from verified search engines, link previews and our own boxes, and ${origin - automated - wanted} from people. ` +
      `The Vercel Firewall denied ${denied} more before origin${deniedBy.size ? ` (${[...deniedBy].map(([route, calls]) => `${route} ${calls}`).join(", ")})` : ""}.` });
  } else flagged.push({ at, kind: "source_error", excerpt: "otel.otel_logs holds no prod origin call to the public database routes in the 24 h, so the Vercel drain or the query is broken" });
  if (humanImg) {
    metrics.real_user_image_ok_pct = pct(humanImgOk, humanImg);
    flagged.push({ at, kind: "reading", item: "real_user_image_ok_pct", excerpt: `${humanImgOk} of ${humanImg} /api/img origin calls by people were answered without a 5xx.` });
  }
  const top = [...patterns].sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  for (const [key, pattern] of top) {
    const routes = [...pattern.routes].sort((a, b) => b[1] - a[1]).map(([route, calls]) => `${route} ${calls}`).join(", ");
    const refs = [...pattern.refs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ref, calls]) => `${ref} ${calls}`).join(", ");
    flagged.push({ at: pattern.last, kind: "scraper_pattern", item: "scraper_share_pct", sig: key,
      excerpt: `${key}${pattern.majors.size ? ` ${Math.min(...pattern.majors)} to ${Math.max(...pattern.majors)}` : ""}: ${pattern.calls} origin calls from ${pattern.ips.size} IPs (${Math.round((pattern.calls / pattern.ips.size) * 10) / 10} per IP), ` +
        `${pattern.e5xx} answered 5xx, last ${utcMin(pattern.last)}; routes ${routes}; referers ${refs}; UA ${pattern.ua.slice(0, 160)}; IPs ${[...pattern.ips].slice(0, 4).join(" ")}`.slice(0, 600) });
  }
}

const sqlText = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const window = (end: number): string => `Timestamp > fromUnixTimestamp64Milli(${end - DAY}) AND Timestamp <= fromUnixTimestamp64Milli(${end})`;

/** One row per (route, referer kind, UA, IP, status, origin) of the prod search drain, each request counted once by its Vercel request id. */
export function requestsSql(end: number): string {
  const any = ROUTES.map(([, pattern]) => `(?:${pattern})`).join("|");
  const route = `multiIf(${ROUTES.map(([name, pattern]) => `match(path, ${sqlText(pattern)}), '${name}'`).join(", ")}, '')`;
  return `SELECT route, refk, any(ref) AS ref, ua, ip, status, origin, count() AS calls, max(ts) AS last FROM (
  SELECT ${route} AS route, multiIf(ref = '', 'none', match(ref, '^https?://(www\\\\.)?virev\\\\.ai/?$'), 'bare_self', match(ref, '^https?://(www\\\\.)?virev\\\\.ai/'), 'page', 'other') AS refk,
    ref, ua, ip, toUInt16OrZero(status) AS status, cache != 'HIT' AND waf NOT IN ('deny', 'challenge') AS origin, ts
  FROM (SELECT LogAttributes['vercel.requestId'] AS rid, any(LogAttributes['vercel.proxy.path']) AS path, max(toUnixTimestamp64Milli(Timestamp)) AS ts,
      anyIf(LogAttributes['vercel.proxy.statusCode'], LogAttributes['vercel.proxy.statusCode'] != '') AS status,
      anyIf(LogAttributes['vercel.proxy.referer'], LogAttributes['vercel.proxy.referer'] != '') AS ref,
      replaceRegexpAll(anyIf(LogAttributes['vercel.proxy.userAgent'], LogAttributes['vercel.proxy.userAgent'] != ''), '^\\\\["|"\\\\]$', '') AS ua,
      anyIf(LogAttributes['vercel.proxy.clientIp'], LogAttributes['vercel.proxy.clientIp'] != '') AS ip,
      anyIf(LogAttributes['vercel.proxy.vercelCache'], LogAttributes['vercel.proxy.vercelCache'] != '') AS cache,
      anyIf(LogAttributes['vercel.proxy.wafAction'], LogAttributes['vercel.proxy.wafAction'] != '') AS waf
    FROM otel.otel_logs WHERE ServiceName = 'search' AND ResourceAttributes['deployment.environment.name'] = 'production' AND ${window(end)}
      AND LogAttributes['vercel.proxy.path'] != '' AND match(LogAttributes['vercel.proxy.path'], ${sqlText(any)})
    GROUP BY rid))
WHERE route != '' GROUP BY route, refk, ua, ip, status, origin`;
}

/** The prod crawler's 503s to anonymous /api/media calls per minute, from its caddy access log. */
export const shedSql = (end: number): string => `SELECT toUnixTimestamp(toStartOfMinute(Timestamp)) * 1000 AS minute, count() AS s503 FROM otel.otel_logs
WHERE ServiceName = 'caddy' AND ResourceAttributes['deployment.environment.name'] = 'production' AND ${window(end)}
  AND LogAttributes['request.host'] = 'crawler.virev.ai' AND startsWith(LogAttributes['request.uri'], '/api/media/')
  AND LogAttributes['request.headers.X-Virev-Caller.0'] = 'anonymous' AND LogAttributes['status'] = '503'
GROUP BY minute`;

/** An engine's published ranges as one block list, from Google's JSON shape that every engine here uses. */
export function rangeList(bodies: readonly unknown[]): BlockList {
  const list = new BlockList();
  for (const body of bodies) {
    for (const prefix of (body as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] }).prefixes ?? []) {
      const cidr = prefix.ipv4Prefix ?? prefix.ipv6Prefix;
      if (!cidr) continue;
      const [net, bits] = cidr.split("/");
      list.addSubnet(net!, Number(bits), prefix.ipv4Prefix ? "ipv4" : "ipv6");
    }
  }
  return list;
}

export const inRanges = (list: BlockList, ip: string): boolean => isIPv4(ip) ? list.check(ip, "ipv4") : isIPv6(ip) ? list.check(ip, "ipv6") : false;

/** Checks each IP that claims a wanted engine: published ranges, or a reverse DNS name the engine owns that resolves back to the IP. */
async function verifier(rows: readonly Row[], errors: string[], signal: AbortSignal): Promise<Verify> {
  const claims = new Map<Engine, Set<string>>();
  for (const row of rows) {
    const engine = ENGINES.find(candidate => candidate.ua.test(row.ua));
    if (engine && row.origin) claims.set(engine, (claims.get(engine) ?? new Set()).add(row.ip));
  }
  const answers = new Map<string, boolean | null>();
  await Promise.all([...claims].map(async ([engine, ips]) => {
    if (engine.ranges) {
      try {
        const bodies = await Promise.all(engine.ranges.map(async url => {
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`${url} answered ${response.status}`);
          return response.json() as Promise<unknown>;
        }));
        const list = rangeList(bodies);
        for (const ip of ips) answers.set(`${engine.name} ${ip}`, inRanges(list, ip));
      } catch (error) {
        errors.push(`${engine.name} IP ranges: ${error instanceof Error ? error.message : String(error)}, so its ${ips.size} IPs count as wanted unchecked`);
        for (const ip of ips) answers.set(`${engine.name} ${ip}`, null);
      }
      return;
    }
    await Promise.all([...ips].map(async ip => {
      const names = await dns.reverse(ip).catch(() => [] as string[]);
      const owned = names.filter(name => engine.rdns!.test(name));
      const back = await Promise.all(owned.map(name => dns.lookup(name, { all: true }).then(found => found.some(entry => entry.address === ip), () => false)));
      answers.set(`${engine.name} ${ip}`, back.includes(true));
    }));
  }));
  return { engine: (engine, ip) => answers.get(`${engine.name} ${ip}`) ?? null };
}

export async function measure(query: DsQuery, end: number, signal: AbortSignal): Promise<PrecheckOutput> {
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const [raw, shed] = await Promise.all([
    sqlRows(query, CLICKHOUSE, requestsSql(end)).then(found => found, asError),
    sqlRows(query, CLICKHOUSE, shedSql(end)).then(found => found.map(row => ({ minute: Number(row.minute), s503: Number(row.s503) })), asError),
  ]);
  const rows = raw instanceof Error ? raw : raw.map((row): Row => ({ route: String(row.route), refk: String(row.refk), ref: String(row.ref ?? ""), ua: String(row.ua ?? ""),
    ip: String(row.ip ?? ""), status: Number(row.status), origin: Boolean(Number(row.origin)), calls: Number(row.calls), last: Number(row.last) }));
  const errors: string[] = [];
  const verify = rows instanceof Error ? { engine: () => null } : await verifier(rows, errors, signal);
  return scrapers({ rows, shed, verify, errors, end });
}

async function main(): Promise<void> {
  const end = process.env.PUBLIC_SCRAPERS_END ? Date.parse(process.env.PUBLIC_SCRAPERS_END) : Date.now();
  let output: PrecheckOutput;
  try {
    if (!Number.isFinite(end)) throw new Error(`PUBLIC_SCRAPERS_END ${process.env.PUBLIC_SCRAPERS_END} is not a time`);
    const signal = AbortSignal.timeout(SOURCE_DEADLINE_MS);
    output = await measure(grafanaClient(fetch, await readGrafanaAuth(), end, signal), end, signal);
  } catch (error) {
    output = { metrics: {}, flagged: [{ at: Date.now(), kind: "source_error", excerpt: `prod ClickHouse: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }] };
  }
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
