import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, type DsQuery, grafanaClient, readGrafanaAuth, REPO, sqlRows } from "./estate-reads.ts";
import { type Asn, asnOf, isHosting } from "./ip-asn.ts";
import { classify, ENGINES, PREVIEW_UA, ROUTES, type Row, typicalChrome, uaFamily, type Verify, verifier } from "./public-page-scrapers.ts";

/**
 * The precheck of ops guy's weekly duty "Scraper blocks" (`node --import tsx scripts/duties/weekly-scraper-blocks.ts`). The owner on 11-03 KST:
 * "그냥 계속 수동으로 막는것도 해. as a weekly job. even 1%", then "크롤링으로 보이는 ip/user profile/...는 계속 차단하고, anti-crawling system 계속
 * 관리해. any sort of crawling, block" and "any sort of crawling for data extraction". It reads 7 days of prod calls to the logged-out database
 * pages and their APIs (the routes of public-page-scrapers.ts) from otel.otel_logs through Grafana in one aggregate query, and lists every
 * crawler client that the Vercel Firewall let through, whatever its size. A client is one reason and one UA across all its IPs, so a scraper
 * that rotates IPs is one client. A call is a crawler's when, in this order:
 * - its UA claims an allowed search indexer from an IP outside that engine's published ranges, or a link preview fetched an image or API route;
 * - its UA is empty or matches the deny tokens or bot patterns of apps/search/firewall.json (AI training and AI fetch bots, HTTP libraries);
 * - classify() in public-page-scrapers.ts reads it as automated (bare-origin referer, fake or stale Chrome);
 * - it is a browser UA from a hosting or cloud network (ip-asn.ts);
 * - it is a browser UA whose IPs mostly open one or two pages each with no referer and never come back, the home-proxy fleet (`fleetKeys`);
 * - forged-referer: one IP+UA loads FORGED_MIN_PAGES or more pages with a virev.ai referer and makes no call a browser that runs the page makes
 *   (an asset, __data.json, an API call, the PostHog relay or a POST), from an IP that calls no /api or __data.json under any UA. A forged
 *   referer skips every no-referer group of firewall.json, as the Windows Chrome/152.0.0.0 client did on 11-15. forgedSql reads every page
 *   path for it, the blog and the other pages outside ROUTES too, because that client took 640 blog pages.
 * Only the allow list of firewall.json (search indexers and link previews, checked against published ranges where the engine has them), our own
 * boxes and people stay out. The headline counts the listed clients that still got through in the last 24 h; the duty's job blocks each one
 * through scraper-block.py. A second read lists signed-in accounts over ACCOUNT_VIEWS_MAX profile views in a UTC day from the `profile_view`
 * lines of apps/search.
 * Set WEEKLY_SCRAPERS_END to an ISO time to read the 7 days before it. Prints to OUTPUT_FILE, or stdout. No model call, nothing sent outside.
 */

const CLICKHOUSE = "grafana_clickhouse";
export const WEEK = 7 * DAY;
/** measured: on 11-03 the 7-day query took 159 to 164 s through Grafana at max_threads=2, the bulk whois of 100,655 IPs 58 to 66 s, and the whole first run 212 s. */
export const WEEK_DEADLINE_MS = 600_000;
/**
 * measured: in the 7 days to 11-03 10:26Z, of the UAs with 20 or more IPs on these routes, those of people had at most 8 lone IPs, ones that
 * opened one or two pages with no referer and nothing else (Mac Chrome 156, 8 of 51), and at most 20% of their IPs lone (iPhone Safari 26.5,
 * 4 of 20), while 75 UAs had 41% or more lone, each with 17 or more (Windows Chrome 151, 6,927 of 7,008; Mac Firefox 151, 1,957 of 1,962).
 */
export const FLEET_MIN_IPS = 20;
export const FLEET_MIN_SHARE = 0.4;
/** A fleet IP opens at most this many pages with no referer in the week. measured: the Windows Chrome 151 fleet opened one profile page per IP, then its images (11-03 findings). */
export const LONE_MAX_PAGES = 2;
/**
 * measured: in the 7 days to 11-03 10:30Z, the busiest real user working in /app (campaign, search and DM calls) opened 7 public profile pages and
 * 16 in-app record reads in a day, and the most profile pages any IP that also reached /app opened in a day was 27, while the two Alibaba IPs of a
 * Chrome/124.0 scraper opened 200 and 174 in a day (~/work/scraper-watch/weekly-scraper-duty/app-users-7d.json).
 */
export const ACCOUNT_VIEWS_MAX = 50;
export const STOPPED_SHOWN = 20;
/**
 * measured: in the 7 days to 11-15 18:30Z, IP+UA pairs on an IP that called /api or __data.json under some UA (people and our boxes) loaded at most
 * 9 virev.ai-referred pages with no asset, __data.json, API call or POST, and none of the 19,713 pairs that called them loaded more than 1 such
 * page in an hour with none, while the 11-15 Chrome/152.0.0.0 client loaded 408 to 6,801 per IP.
 */
export const FORGED_MIN_PAGES = 10;

export type State = "origin" | "hit" | "denied";
/** One (UA, IP, referer kind, route, state) group of calls; path is one of its paths, which the firewall replay reads. */
export interface WeekRow { ua: string; ip: string; refk: string; page: boolean; path: string; state: State; calls: number; last: number }

/** The parts of apps/search/firewall.json the list reads: the allowed UA tokens, the crawler UA regex and our own boxes. */
export interface Firewall { allow: RegExp; bot: RegExp; ownIps: ReadonlySet<string> }
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function parseFirewall(body: unknown): Firewall {
  const file = body as { allow: { ua: string }[]; deny: { ua: string }[]; bot_patterns: string[]; own_ips: string[] };
  return { allow: new RegExp(file.allow.map(entry => escape(entry.ua)).join("|")),
    bot: new RegExp([...file.bot_patterns, ...file.deny.map(entry => escape(entry.ua))].join("|")), ownIps: new Set(file.own_ips) };
}

/** The parts of apps/search/firewall.json that acts() reads; the file goes to acts() whole. */
export interface FirewallCondition { type?: string; key?: string; op?: string; neg?: boolean; value?: string | string[]; use?: string }
export interface FirewallFile { own_ua_env: string; rules: { name: string; action: { action: string }; groups: { conditions: FirewallCondition[] }[] }[] }
/** A request in the shape acts() of auto-sns-agent scripts/repo/vercel/firewall.mjs reads. */
export interface FirewallRequest { path: string; ip: string; asn: string | undefined; country: string | undefined; headers: Record<string, string | undefined> }
/** acts() of that file: the `rule group <n>` names a request meets. */
export type Acts = (file: FirewallFile, request: FirewallRequest, env: Record<string, string>) => string[];
/** Whether the published rules would now deny a passed call of this shape, whatever the fields the log lacks hold. */
export type Replay = (row: WeekRow, asn: Asn | undefined) => boolean;

/** The actions that keep a crawler out; weeklySql counts a challenge as denied too. */
const BLOCKING: ReadonlySet<string> = new Set(["deny", "challenge"]);
const UNKNOWN = "weekly-scraper-blocks unknown";

/**
 * Replays a passed call through the deny and challenge rules of firewall.json with acts(). The log has no sec-ch-ua or country, and only the kind
 * of a foreign referer, and an IP whois missed has no ASN, so each such field is tried absent, present with a value no rule names, and as each
 * value a negated condition names; a call shape counts as denied only when every try is.
 */
export function replayer(file: FirewallFile, acts: Acts): Replay {
  const blocking = { ...file, rules: file.rules.filter(rule => BLOCKING.has(rule.action.action)) };
  const env = { [file.own_ua_env]: UNKNOWN };
  const conditions = file.rules.flatMap(rule => rule.groups.flatMap(group => group.conditions));
  const tries = (field: (condition: FirewallCondition) => boolean): (string | undefined)[] => [undefined, UNKNOWN,
    ...conditions.filter(condition => condition.neg && field(condition) && ["eq", "inc", "sub"].includes(condition.op ?? "")).flatMap(condition => condition.value ?? [])];
  const countries = tries(condition => condition.type === "geo_country");
  const hints = tries(condition => condition.type === "header" && condition.key === "sec-ch-ua");
  const anyAsn = tries(condition => condition.type === "geo_as_number");
  const referers: Record<string, (string | undefined)[]> = { none: [undefined], bare_self: ["https://virev.ai/"], page: ["https://virev.ai/en"],
    other: tries(condition => condition.type === "header" && condition.key === "referer").filter(value => value !== undefined) };
  return (row, asn) => {
    const path = row.path.split("?")[0];
    if (!path) return false;
    return (referers[row.refk] ?? [UNKNOWN]).every(referer => hints.every(hint => countries.every(country => (asn ? [String(asn.asn)] : anyAsn).every(as =>
      acts(blocking, { path, ip: row.ip, asn: as, country, headers: { "user-agent": row.ua, referer, "sec-ch-ua": hint } }, env).length > 0))));
  };
}

const firewallFile = async (): Promise<unknown> => JSON.parse(await readFile(join(REPO, "apps/search/firewall.json"), "utf8"));

/** The row as public-page-scrapers.ts classifies it: a page or an API call, passed or denied. */
export const asRow = (row: WeekRow): Row => ({ route: row.page ? "profile" : "img", refk: row.refk, ref: "", ua: row.ua, ip: row.ip,
  status: row.state === "denied" ? 403 : 200, origin: row.state !== "denied", calls: row.calls, last: row.last });

/** The Chrome major people use most, read from the calls the firewall let through. */
export const typicalOf = (rows: readonly WeekRow[]): number | null => typicalChrome(rows.filter(row => row.state !== "denied").map(asRow));

const pairKey = (row: Pick<WeekRow, "ua" | "ip">): string => `${row.ua}\t${row.ip}`;

/** The (UA, IP) pairs of the home-proxy fleets: a UA with FLEET_MIN_IPS or more lone IPs that are FLEET_MIN_SHARE or more of its IPs. */
export function fleetKeys(rows: readonly WeekRow[]): Set<string> {
  const pairs = new Map<string, { ua: string; pages: number; referred: boolean }>();
  for (const row of rows) {
    if (row.state === "denied" || !row.page) continue;
    const pair = pairs.get(pairKey(row)) ?? { ua: row.ua, pages: 0, referred: false };
    pair.pages += row.calls;
    if (row.refk !== "none") pair.referred = true;
    pairs.set(pairKey(row), pair);
  }
  const uas = new Map<string, { ips: number; lone: string[] }>();
  for (const [key, pair] of pairs) {
    const ua = uas.get(pair.ua) ?? { ips: 0, lone: [] };
    ua.ips += 1;
    if (!pair.referred && pair.pages <= LONE_MAX_PAGES) ua.lone.push(key);
    uas.set(pair.ua, ua);
  }
  const keys = new Set<string>();
  for (const ua of uas.values()) if (ua.lone.length >= FLEET_MIN_IPS && ua.lone.length / ua.ips >= FLEET_MIN_SHARE) for (const key of ua.lone) keys.add(key);
  return keys;
}

/** forged holds the (UA, IP) pairs of forgedSql's rows. */
export interface Judge { typical: number | null; verify: Verify; firewall: Firewall; fleet: ReadonlySet<string>; forged: ReadonlySet<string> }

/** Whether a call needs its IP's network looked up: a browser UA that no earlier step settles. */
export const needsNetwork = (row: WeekRow, judge: Judge): boolean =>
  !judge.firewall.ownIps.has(row.ip) && !judge.firewall.allow.test(row.ua) && !!row.ua.trim() && !judge.firewall.bot.test(row.ua);

export const FORGED = "forged-referer: virev.ai referer on its pages and no asset, __data.json or API call";

/** The client a crawler's call belongs to (reason | UA), or null for an allowed indexer or preview, our own box or a person. */
export function clientKey(row: WeekRow, judge: Judge, asn: Asn | undefined): string | null {
  const ua = row.ua.trim();
  const family = uaFamily(ua).replace(/ \d+$/, "");
  if (judge.firewall.ownIps.has(row.ip)) return null;
  if (judge.firewall.allow.test(ua)) {
    const engine = ENGINES.find(candidate => candidate.ua.test(ua));
    if (engine && judge.verify.engine(engine, row.ip) === false) return `UA claims ${engine.name} from an IP outside its ranges | ${family}`;
    if (PREVIEW_UA.test(ua) && !row.page) return `link preview UA on an image or API route | ${family}`;
    return null;
  }
  if (!ua || judge.firewall.bot.test(ua)) return `bot, AI or HTTP library UA | ${family}`;
  if (judge.forged.has(pairKey(row))) return `${FORGED} | ${row.ua}`;
  const verdict = classify(asRow(row), judge.typical, judge.verify);
  if (verdict.kind === "automated") return `${verdict.why} | ${family}`;
  if (asn && isHosting(asn.name)) return `browser UA from a hosting network | ${row.ua}`;
  if (judge.fleet.has(pairKey(row))) return `one or two pages per IP with no referer, rotating IPs | ${row.ua}`;
  return null;
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
const utcMin = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;
const shellText = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** shapes counts the client's passed call groups and covered those the published rules would now deny. */
interface Client { calls: number; denied: number; lastDenied: number; pages: number; ips: Set<string>; asns: Map<number, { name: string; calls: number }>; last: number; ua: string;
  shapes: number; covered: number; gap: string }

/** One signed-in account's busiest UTC day of profile views. */
export interface AccountDay { user: string; day: string; views: number; ips: number }

/** forged holds forgedSql's rows, which replace the route rows of their (UA, IP) pairs. */
export interface WeekInputs { rows: readonly WeekRow[] | Error; forged?: readonly WeekRow[] | Error; asns: ReadonlyMap<string, Asn> | Error; accounts: readonly AccountDay[] | Error;
  judge: Omit<Judge, "fleet" | "typical" | "forged">; errors: readonly string[]; end: number; replay?: Replay | undefined }

/** The published rules would now deny every call shape the client got through with, so a block reads as done before the client comes back. */
const covered = (client: Client): boolean => client.shapes > 0 && client.covered === client.shapes;
/**
 * A client still gets through when a call passed in the last 24 h, after the firewall's last denial of it, and the published rules would not
 * deny all its passed call shapes, so a block made since reads as done.
 */
const passing = (client: Client, at: number): boolean => client.last > at - DAY && client.last > client.lastDenied && !covered(client);

function blockCommand(key: string, client: Client, at: number, nets: [number, { name: string; calls: number }][]): string {
  const hosting = nets.filter(([asn, net]) => asn && isHosting(net.name)).map(([asn]) => asn);
  const exact = /^(?:browser UA from|one or two pages|forged-referer)/.test(key);
  const label = `${uaFamily(client.ua)}${nets[0]?.[0] ? ` from AS${nets[0][0]}` : ""}, weekly ${new Date(at).toISOString().slice(0, 10)}`;
  const tail = key.startsWith("one or two pages") ? " (no-referer group: --groups-file with a referer nex condition, as the Windows Chrome 151 group)"
    : key.startsWith("bot, AI") ? " (or add its token to deny in apps/search/firewall.json)" : "";
  return `scripts/duties/scraper-block.py --label ${shellText(label)}${key.startsWith("forged-referer") ? " --forged-referer" : ""}${exact ? ` --ua-sub ${shellText(client.ua)}` : ""}` +
    `${hosting.length && !key.startsWith("one or two pages") ? ` --asn ${hosting.slice(0, 8).join(" ")}` : ""}` +
    `${key.startsWith("forged-referer") && !hosting.length ? ` --client-ips ${[...client.ips].join(" ")}` : ""}${tail}`;
}

/** The headline (crawler clients still getting through), one flagged item per crawler client with a block command, and the accounts over the line. */
export function weeklyClients(input: WeekInputs): PrecheckOutput {
  const at = input.end;
  const flagged: FlaggedSlice[] = input.errors.map(excerpt => ({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) }));
  if (input.rows instanceof Error) {
    flagged.push({ at, kind: "source_error", excerpt: `search requests: ${input.rows.message}`.slice(0, 600) });
    return { metrics: {}, flagged };
  }
  if (input.asns instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `whois.cymru.com: ${input.asns.message}, so no browser UA counts as hosting`.slice(0, 600) });
  const asns = input.asns instanceof Error ? new Map<string, Asn>() : input.asns;
  if (input.forged instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `forged-referer read: ${input.forged.message}`.slice(0, 600) });
  const forged = input.forged instanceof Error ? [] : input.forged ?? [];
  const forgedPairs = new Set(forged.map(pairKey));
  const rows = [...input.rows.filter(row => !forgedPairs.has(pairKey(row))), ...forged];
  const judge: Judge = { ...input.judge, typical: typicalOf(input.rows), fleet: fleetKeys(rows), forged: forgedPairs };
  const total = rows.reduce((sum, row) => sum + (row.state === "denied" ? 0 : row.calls), 0);
  if (!total) {
    flagged.push({ at, kind: "source_error", excerpt: "otel.otel_logs holds no prod call to the public database routes in the 7 days, so the Vercel drain or the query is broken" });
    return { metrics: {}, flagged };
  }
  const keyed = rows.flatMap(row => {
    const asn = asns.get(row.ip);
    const key = clientKey(row, judge, asn);
    return key ? [{ row, asn, key }] : [];
  });
  const replayed = new Map(keyed.filter(({ row }) => row.state !== "denied").map(entry => [entry, input.replay?.(entry.row, entry.asn) ?? false]));
  /**
   * The (client, IP) pairs whose no-referer entry page the published rules now deny. A browser there never gets that page's HTML, so it never
   * loads the images and APIs the page refers to: on 11-13 every /api/img call the replay left open came with a virev.ai page referer from an IP
   * whose first call was such a page (36.212.247.234, Windows Chrome 148, 8 pages then 8 images within 9 s).
   */
  const shut = new Set(keyed.filter(entry => entry.row.page && entry.row.refk === "none" && replayed.get(entry)).map(({ row, key }) => `${key}\t${row.ip}`));
  const clients = new Map<string, Client>();
  for (const entry of keyed) {
    const { row, asn, key } = entry;
    const client = clients.get(key) ?? { calls: 0, denied: 0, lastDenied: 0, pages: 0, ips: new Set<string>(), asns: new Map(), last: 0, ua: row.ua, shapes: 0, covered: 0, gap: "" };
    if (row.state === "denied") { client.denied += row.calls; client.lastDenied = Math.max(client.lastDenied, row.last); clients.set(key, client); continue; }
    client.calls += row.calls;
    client.shapes += 1;
    if (replayed.get(entry) || (!row.page && row.refk === "page" && shut.has(`${key}\t${row.ip}`))) client.covered += 1;
    else client.gap ||= `${row.path} with referer ${row.refk} from AS${asn?.asn ?? "?"}`;
    if (row.page) client.pages += row.calls;
    client.ips.add(row.ip);
    client.last = Math.max(client.last, row.last);
    const net = client.asns.get(asn?.asn ?? 0) ?? { name: asn?.name ?? "not looked up", calls: 0 };
    net.calls += row.calls;
    client.asns.set(asn?.asn ?? 0, net);
    clients.set(key, client);
  }
  const crawlers = [...clients].filter(([, client]) => client.calls > 0).sort((a, b) => b[1].calls - a[1].calls);
  const open = crawlers.filter(([, client]) => passing(client, at));
  const crawled = crawlers.reduce((sum, [, client]) => sum + client.calls, 0);
  const ruled = crawlers.filter(([, client]) => covered(client) && client.last > at - DAY && client.last > client.lastDenied).length;
  flagged.push({ at, kind: "reading", item: "unblocked_crawlers", excerpt: `${total} calls to the public database pages and their APIs got past the Vercel Firewall in the 7 days, ` +
    `${crawled} (${pct(crawled, total)}%) of them from ${crawlers.length} crawler clients; ${open.length} still got through in the last 24 h, ` +
    `${ruled} more passed in the last 24 h but the published rules of apps/search/firewall.json now deny every call shape they passed with, and ` +
    `${crawlers.length - open.length - ruled} made none since ${utcMin(at - DAY)} or since the firewall began to deny them.` });
  /** Stopped clients need no action, so the run lists only the largest few of them to keep the run detail readable; every open one is listed. */
  const shown = [...open, ...crawlers.filter(([, client]) => !passing(client, at)).slice(0, STOPPED_SHOWN)].sort((a, b) => b[1].calls - a[1].calls);
  for (const [key, client] of shown) {
    const nets = [...client.asns].sort((a, b) => b[1].calls - a[1].calls);
    const netText = nets.slice(0, 3).map(([asn, net]) => `AS${asn} ${net.name.slice(0, 32)} ${pct(net.calls, client.calls)}%`).join(", ");
    const still = passing(client, at);
    flagged.push({ at: client.last, kind: still ? "scraper_client" : "scraper_client_stopped", ...(still ? { item: "unblocked_crawlers" } : {}), sig: key,
      excerpt: `${pct(client.calls, total)}% (${client.calls} calls, ${client.pages} pages) from ${client.ips.size} IPs, ${client.denied} more denied, last ${utcMin(client.last)}, ` +
        `the published rules now deny ${client.covered} of its ${client.shapes} passed call shapes${client.gap && input.replay ? ` (not ${client.gap.slice(0, 120)})` : ""}: ` +
        `${key.slice(0, 200)}; networks ${netText}; IPs ${[...client.ips].slice(0, 3).join(" ")}; start from: ${blockCommand(key, client, at, nets)}`.slice(0, 900) });
  }
  const metrics: Record<string, number> = { unblocked_crawlers: open.length };
  if (input.accounts instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `profile_view lines: ${input.accounts.message}`.slice(0, 600) });
  else {
    const over = input.accounts.filter(account => account.views > ACCOUNT_VIEWS_MAX).sort((a, b) => b.views - a.views);
    metrics.heavy_view_accounts = new Set(over.map(account => account.user)).size;
    flagged.push({ at, kind: "reading", item: "heavy_view_accounts", excerpt: `${input.accounts.length} signed-in account days viewed profiles in the 7 days; ` +
      `${metrics.heavy_view_accounts} accounts passed ${ACCOUNT_VIEWS_MAX} profiles in one UTC day.` });
    for (const account of over) flagged.push({ at, kind: "heavy_view_account", item: "heavy_view_accounts", sig: `account ${account.user}`,
      excerpt: `Clerk user ${account.user} viewed ${account.views} profiles from ${account.ips} IPs on ${account.day}; check its org's campaigns, searches and saved lists in Convex before a ban.` });
  }
  /** The newest passed call of a client still getting through, so a count whose crawlers made no new call reads quiet and a fresh one live. */
  const newestOpen = Math.max(0, ...open.map(([, client]) => client.last));
  return { metrics, flagged, windowMs: { unblocked_crawlers: WEEK, heavy_view_accounts: WEEK },
    ...newestOpen > 0 ? { lastEventAt: { unblocked_crawlers: newestOpen } } : {} };
}

const sqlText = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const weekWindow = (end: number): string => `Timestamp > fromUnixTimestamp64Milli(${end - WEEK}) AND Timestamp <= fromUnixTimestamp64Milli(${end})`;
const PATH = "LogAttributes['vercel.proxy.path']";
const REF = "LogAttributes['vercel.proxy.referer']";
const UA_SQL = "replaceRegexpAll(LogAttributes['vercel.proxy.userAgent'], '^\\\\[\"|\"\\\\]$', '')";
const REFK_SQL = `multiIf(${REF} = '', 'none', match(${REF}, '^https?://(www\\\\.)?virev\\\\.ai/?$'), 'bare_self', match(${REF}, '^https?://(www\\\\.)?virev\\\\.ai/'), 'page', 'other')`;
const ROUTE_SQL = `multiIf(${ROUTES.map(([name, pattern]) => `match(${PATH}, ${sqlText(pattern)}), '${name}'`).join(", ")}, '')`;
const STATE_SQL = `multiIf(LogAttributes['vercel.source'] = 'firewall' OR LogAttributes['vercel.proxy.wafAction'] IN ('deny', 'challenge'), 'denied',
    LogAttributes['vercel.proxy.vercelCache'] = 'HIT', 'hit', 'origin')`;
const PROD = `ServiceName = 'search' AND \`__hdx_materialized_deployment.environment.name\` = 'production'`;
/** A file a page links to (sitemap, robots, a blog's CSV), which a crawler fetches as readily as a person, so it is neither a page nor a browser's sign. */
const DOWNLOAD = `match(${PATH}, '\\\\.(?:xml|txt|csv)(?:\\\\?|$)')`;
/**
 * A call that only a browser running the page makes: __data.json, an API or +server route, the PostHog relay (/_relay), a blog asset (/_blog),
 * any other asset, or a POST. The drain logs none of apps/search's /_app assets, which the CDN serves, but it logs all of these (11-15 read).
 */
const BROWSER_SIGN = `(NOT ${DOWNLOAD} AND (LogAttributes['vercel.proxy.method'] NOT IN ('GET', 'HEAD', '') OR position(${PATH}, '/api/') > 0
    OR position(${PATH}, '__data.json') > 0 OR startsWith(${PATH}, '/_') OR match(${PATH}, '\\\\.(?:png|jpe?g|gif|svg|ico|webp|avif|css|m?js|woff2?|ttf|webmanifest|json|map)(?:\\\\?|$)')))`;
const DOCUMENT = `(NOT ${BROWSER_SIGN} AND NOT ${DOWNLOAD})`;

/**
 * One row per (UA, IP, referer kind, page or API, route of ROUTES, passed to origin, served from the CDN or denied) with one of its paths, each
 * request counted once by its Vercel id. A row per route gives the firewall replay one path for each route a client used.
 */
export function weeklySql(end: number): string {
  const any = ROUTES.map(([, pattern]) => `(?:${pattern})`).join("|");
  return `SELECT ${UA_SQL} AS ua, LogAttributes['vercel.proxy.clientIp'] AS ip, ${REFK_SQL} AS refk,
  NOT startsWith(${PATH}, '/api/') AS page, ${ROUTE_SQL} AS route, any(${PATH}) AS path, ${STATE_SQL} AS state,
  uniqExact(LogAttributes['vercel.requestId']) AS calls, max(toUnixTimestamp64Milli(Timestamp)) AS last
FROM otel.otel_logs WHERE ${PROD} AND ${weekWindow(end)}
  AND ${PATH} != '' AND match(${PATH}, ${sqlText(any)})
GROUP BY ua, ip, refk, page, route, state
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;
}

/**
 * The page rows, in weeklySql's shape, of every (UA, IP) pair with the forged-referer shape, on every page path (route '' outside ROUTES): FORGED_MIN_PAGES
 * or more pages with a virev.ai referer, no BROWSER_SIGN call from the pair, and no /api or __data.json call from its IP under any UA. One scan of
 * the week, with the pair and IP sums as window functions.
 */
export function forgedSql(end: number): string {
  const id = "LogAttributes['vercel.requestId']";
  return `SELECT ua, ip, refk, page, route, path, state, calls, last FROM (
  SELECT *, sum(signs) OVER (PARTITION BY ua, ip) AS pair_signs, sum(referred) OVER (PARTITION BY ua, ip) AS pair_referred, sum(app) OVER (PARTITION BY ip) AS ip_app
  FROM (SELECT ${UA_SQL} AS ua, LogAttributes['vercel.proxy.clientIp'] AS ip, ${REFK_SQL} AS refk, true AS page, ${ROUTE_SQL} AS route,
      anyIf(${PATH}, ${DOCUMENT}) AS path, ${STATE_SQL} AS state, uniqExactIf(${id}, ${DOCUMENT}) AS calls,
      uniqExactIf(${id}, ${DOCUMENT} AND refk IN ('page', 'bare_self')) AS referred, uniqExactIf(${id}, ${BROWSER_SIGN}) AS signs,
      uniqExactIf(${id}, position(${PATH}, '/api/') > 0 OR position(${PATH}, '__data.json') > 0) AS app,
      maxIf(toUnixTimestamp64Milli(Timestamp), ${DOCUMENT}) AS last
    FROM otel.otel_logs WHERE ${PROD} AND ${weekWindow(end)} AND ${PATH} != ''
    GROUP BY ua, ip, refk, route, state))
WHERE pair_signs = 0 AND pair_referred >= ${FORGED_MIN_PAGES} AND ip_app = 0 AND calls > 0
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;
}

/** Each signed-in account's profile views per UTC day, from the `profile_view {json}` lines apps/search logs for each viewer page render. */
export const accountsSql = (end: number): string => `SELECT JSONExtractString(substring(Body, 14), 'user') AS user, toString(toDate(Timestamp)) AS day,
  uniqExact(JSONExtractString(substring(Body, 14), 'profile')) AS views, uniqExact(LogAttributes['vercel.proxy.clientIp']) AS ips
FROM otel.otel_logs WHERE ${PROD} AND ${weekWindow(end)}
  AND LogAttributes['vercel.source'] = 'lambda' AND startsWith(Body, 'profile_view ') AND JSONExtractString(substring(Body, 14), 'user') != ''
GROUP BY user, day
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;

export async function measure(query: DsQuery, end: number, signal: AbortSignal): Promise<PrecheckOutput> {
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const [raw, forgedRaw, accountRows, file] = await Promise.all([
    sqlRows(query, CLICKHOUSE, weeklySql(end)).then(found => found, asError),
    sqlRows(query, CLICKHOUSE, forgedSql(end)).then(found => found, asError),
    sqlRows(query, CLICKHOUSE, accountsSql(end)).then(found => found, asError),
    firewallFile(),
  ]);
  const firewall = parseFirewall(file);
  const weekRows = (found: Record<string, unknown>[]): WeekRow[] => found.map((row): WeekRow => ({ ua: String(row.ua ?? ""), ip: String(row.ip ?? ""),
    refk: String(row.refk), page: Boolean(Number(row.page)), path: String(row.path ?? ""), state: String(row.state) as State, calls: Number(row.calls), last: Number(row.last) }));
  const rows = raw instanceof Error ? raw : weekRows(raw);
  const forged = forgedRaw instanceof Error ? forgedRaw : weekRows(forgedRaw);
  const accounts = accountRows instanceof Error ? accountRows : accountRows.map((row): AccountDay => ({ user: String(row.user), day: String(row.day),
    views: Number(row.views), ips: Number(row.ips) }));
  const errors: string[] = [];
  if (rows instanceof Error) return weeklyClients({ rows, asns: new Map(), accounts, judge: { verify: { engine: () => null }, firewall }, errors, end });
  const all = forged instanceof Error ? rows : [...rows, ...forged];
  const verify = await verifier(all.map(asRow), errors, signal);
  const judge = { verify, firewall };
  /** Every passed call's network too, so the replay can test the ASN groups on an indexer UA or a bot UA. */
  const lookup = all.filter(row => needsNetwork(row, { ...judge, typical: null, fleet: new Set(), forged: new Set() }) || (row.state !== "denied" && !firewall.ownIps.has(row.ip)))
    .map(row => row.ip);
  const asns = await asnOf(lookup, signal).then(found => found, asError);
  const replay = await import(pathToFileURL(join(REPO, "scripts/repo/vercel/firewall.mjs")).href)
    .then(module => replayer(file as FirewallFile, module.acts as Acts), (error: unknown) => {
      errors.push(`firewall replay through ${REPO}/scripts/repo/vercel/firewall.mjs: ${asError(error).message}, so only a denial after the last pass counts as blocked`);
      return undefined;
    });
  return weeklyClients({ rows, forged, asns, accounts, judge, errors, end, replay });
}

/**
 * Adds direct_to_google_ratio: virev.ai pageviews with PostHog $referring_domain $direct over those from Google, last 7 full UTC days, read by
 * auto-sns-agent scripts/duties/search/direct-to-google.mjs. The owner on 11-03: "normal behaviour is  these two being essentially similar."
 */
export async function withDirectRatio(output: PrecheckOutput, at: number): Promise<PrecheckOutput> {
  try {
    const ratio = await import(pathToFileURL(join(REPO, "scripts/duties/search/direct-to-google.mjs")).href);
    const read = ratio.measure(await ratio.readDays(7));
    return { ...output, metrics: { ...output.metrics, direct_to_google_ratio: read.metrics.direct_to_google_ratio },
      ...read.lastEventAt ? { lastEventAt: { ...output.lastEventAt, ...read.lastEventAt } } : {},
      flagged: [...(output.flagged ?? []), { at, kind: "reading", item: "direct_to_google_ratio",
        excerpt: `PostHog virev.ai pageviews in the last 7 full UTC days: ${read.direct} $direct, ${read.google} from Google, ratio ${read.metrics.direct_to_google_ratio}.` }],
      windowMs: { ...output.windowMs, direct_to_google_ratio: WEEK } };
  } catch (error) {
    return { ...output, flagged: [...(output.flagged ?? []), { at, kind: "source_error", item: "direct_to_google_ratio",
      excerpt: `PostHog direct_to_google_ratio: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }] };
  }
}

async function main(): Promise<void> {
  const end = process.env.WEEKLY_SCRAPERS_END ? Date.parse(process.env.WEEKLY_SCRAPERS_END) : Date.now();
  let output: PrecheckOutput;
  try {
    if (!Number.isFinite(end)) throw new Error(`WEEKLY_SCRAPERS_END ${process.env.WEEKLY_SCRAPERS_END} is not a time`);
    const signal = AbortSignal.timeout(WEEK_DEADLINE_MS);
    output = await measure(grafanaClient(fetch, await readGrafanaAuth(), end, signal), end, signal);
  } catch (error) {
    output = { metrics: {}, flagged: [{ at: Date.now(), kind: "source_error", excerpt: `prod ClickHouse: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }] };
  }
  output = await withDirectRatio(output, Date.now());
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
