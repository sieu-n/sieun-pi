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
 * - it is a browser UA whose IPs mostly open one or two pages each with no referer and never come back, the home-proxy fleet (`fleetKeys`).
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

export type State = "origin" | "hit" | "denied";
export interface WeekRow { ua: string; ip: string; refk: string; page: boolean; state: State; calls: number; last: number }

/** The parts of apps/search/firewall.json the list reads: the allowed UA tokens, the crawler UA regex and our own boxes. */
export interface Firewall { allow: RegExp; bot: RegExp; ownIps: ReadonlySet<string> }
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function parseFirewall(body: unknown): Firewall {
  const file = body as { allow: { ua: string }[]; deny: { ua: string }[]; bot_patterns: string[]; own_ips: string[] };
  return { allow: new RegExp(file.allow.map(entry => escape(entry.ua)).join("|")),
    bot: new RegExp([...file.bot_patterns, ...file.deny.map(entry => escape(entry.ua))].join("|")), ownIps: new Set(file.own_ips) };
}
export const readFirewall = async (): Promise<Firewall> => parseFirewall(JSON.parse(await readFile(join(REPO, "apps/search/firewall.json"), "utf8")));

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

export interface Judge { typical: number | null; verify: Verify; firewall: Firewall; fleet: ReadonlySet<string> }

/** Whether a call needs its IP's network looked up: a browser UA that no earlier step settles. */
export const needsNetwork = (row: WeekRow, judge: Judge): boolean =>
  !judge.firewall.ownIps.has(row.ip) && !judge.firewall.allow.test(row.ua) && !!row.ua.trim() && !judge.firewall.bot.test(row.ua);

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
  const verdict = classify(asRow(row), judge.typical, judge.verify);
  if (verdict.kind === "automated") return `${verdict.why} | ${family}`;
  if (asn && isHosting(asn.name)) return `browser UA from a hosting network | ${row.ua}`;
  if (judge.fleet.has(pairKey(row))) return `one or two pages per IP with no referer, rotating IPs | ${row.ua}`;
  return null;
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
const utcMin = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;
const shellText = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

interface Client { calls: number; denied: number; lastDenied: number; pages: number; ips: Set<string>; asns: Map<number, { name: string; calls: number }>; last: number; ua: string }

/** One signed-in account's busiest UTC day of profile views. */
export interface AccountDay { user: string; day: string; views: number; ips: number }

export interface WeekInputs { rows: readonly WeekRow[] | Error; asns: ReadonlyMap<string, Asn> | Error; accounts: readonly AccountDay[] | Error; judge: Omit<Judge, "fleet" | "typical">;
  errors: readonly string[]; end: number }

/** A client still gets through when a call passed in the last 24 h and after the firewall's last denial of it, so a block made since reads as done. */
const passing = (client: Client, at: number): boolean => client.last > at - DAY && client.last > client.lastDenied;

function blockCommand(key: string, client: Client, at: number, nets: [number, { name: string; calls: number }][]): string {
  const hosting = nets.filter(([asn, net]) => asn && isHosting(net.name)).map(([asn]) => asn);
  const exact = /^(?:browser UA from|one or two pages)/.test(key);
  const label = `${uaFamily(client.ua)}${nets[0]?.[0] ? ` from AS${nets[0][0]}` : ""}, weekly ${new Date(at).toISOString().slice(0, 10)}`;
  const tail = key.startsWith("one or two pages") ? " (no-referer group: --groups-file with a referer nex condition, as the Windows Chrome 151 group)"
    : key.startsWith("bot, AI") ? " (or add its token to deny in apps/search/firewall.json)" : "";
  return `scripts/duties/scraper-block.py --label ${shellText(label)}${exact ? ` --ua-sub ${shellText(client.ua)}` : ""}` +
    `${hosting.length && !key.startsWith("one or two pages") ? ` --asn ${hosting.slice(0, 8).join(" ")}` : ""}${tail}`;
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
  const rows = input.rows;
  const judge: Judge = { ...input.judge, typical: typicalOf(rows), fleet: fleetKeys(rows) };
  const total = rows.reduce((sum, row) => sum + (row.state === "denied" ? 0 : row.calls), 0);
  if (!total) {
    flagged.push({ at, kind: "source_error", excerpt: "otel.otel_logs holds no prod call to the public database routes in the 7 days, so the Vercel drain or the query is broken" });
    return { metrics: {}, flagged };
  }
  const clients = new Map<string, Client>();
  for (const row of rows) {
    const asn = asns.get(row.ip);
    const key = clientKey(row, judge, asn);
    if (!key) continue;
    const client = clients.get(key) ?? { calls: 0, denied: 0, lastDenied: 0, pages: 0, ips: new Set<string>(), asns: new Map(), last: 0, ua: row.ua };
    if (row.state === "denied") { client.denied += row.calls; client.lastDenied = Math.max(client.lastDenied, row.last); clients.set(key, client); continue; }
    client.calls += row.calls;
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
  flagged.push({ at, kind: "reading", item: "unblocked_crawlers", excerpt: `${total} calls to the public database pages and their APIs got past the Vercel Firewall in the 7 days, ` +
    `${crawled} (${pct(crawled, total)}%) of them from ${crawlers.length} crawler clients; ${open.length} still got through in the last 24 h and ` +
    `${crawlers.length - open.length} made none since ${utcMin(at - DAY)} or since the firewall began to deny them.` });
  /** Stopped clients need no action, so the run lists only the largest few of them to keep the run detail readable; every open one is listed. */
  const shown = [...open, ...crawlers.filter(([, client]) => !passing(client, at)).slice(0, STOPPED_SHOWN)].sort((a, b) => b[1].calls - a[1].calls);
  for (const [key, client] of shown) {
    const nets = [...client.asns].sort((a, b) => b[1].calls - a[1].calls);
    const netText = nets.slice(0, 3).map(([asn, net]) => `AS${asn} ${net.name.slice(0, 32)} ${pct(net.calls, client.calls)}%`).join(", ");
    const still = passing(client, at);
    flagged.push({ at: client.last, kind: still ? "scraper_client" : "scraper_client_stopped", ...(still ? { item: "unblocked_crawlers" } : {}), sig: key,
      excerpt: `${pct(client.calls, total)}% (${client.calls} calls, ${client.pages} pages) from ${client.ips.size} IPs, ${client.denied} more denied, last ${utcMin(client.last)}: ` +
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

/** One row per (UA, IP, referer kind, page or API, passed to origin, served from the CDN or denied), each request counted once by its Vercel id. */
export function weeklySql(end: number): string {
  const any = ROUTES.map(([, pattern]) => `(?:${pattern})`).join("|");
  const ref = "LogAttributes['vercel.proxy.referer']";
  return `SELECT replaceRegexpAll(LogAttributes['vercel.proxy.userAgent'], '^\\\\["|"\\\\]$', '') AS ua, LogAttributes['vercel.proxy.clientIp'] AS ip,
  multiIf(${ref} = '', 'none', match(${ref}, '^https?://(www\\\\.)?virev\\\\.ai/?$'), 'bare_self', match(${ref}, '^https?://(www\\\\.)?virev\\\\.ai/'), 'page', 'other') AS refk,
  NOT startsWith(LogAttributes['vercel.proxy.path'], '/api/') AS page,
  multiIf(LogAttributes['vercel.source'] = 'firewall' OR LogAttributes['vercel.proxy.wafAction'] IN ('deny', 'challenge'), 'denied',
    LogAttributes['vercel.proxy.vercelCache'] = 'HIT', 'hit', 'origin') AS state,
  uniqExact(LogAttributes['vercel.requestId']) AS calls, max(toUnixTimestamp64Milli(Timestamp)) AS last
FROM otel.otel_logs WHERE ServiceName = 'search' AND \`__hdx_materialized_deployment.environment.name\` = 'production' AND ${weekWindow(end)}
  AND LogAttributes['vercel.proxy.path'] != '' AND match(LogAttributes['vercel.proxy.path'], ${sqlText(any)})
GROUP BY ua, ip, refk, page, state
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;
}

/** Each signed-in account's profile views per UTC day, from the `profile_view {json}` lines apps/search logs for each viewer page render. */
export const accountsSql = (end: number): string => `SELECT JSONExtractString(substring(Body, 14), 'user') AS user, toString(toDate(Timestamp)) AS day,
  uniqExact(JSONExtractString(substring(Body, 14), 'profile')) AS views, uniqExact(LogAttributes['vercel.proxy.clientIp']) AS ips
FROM otel.otel_logs WHERE ServiceName = 'search' AND \`__hdx_materialized_deployment.environment.name\` = 'production' AND ${weekWindow(end)}
  AND LogAttributes['vercel.source'] = 'lambda' AND startsWith(Body, 'profile_view ') AND JSONExtractString(substring(Body, 14), 'user') != ''
GROUP BY user, day
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;

export async function measure(query: DsQuery, end: number, signal: AbortSignal): Promise<PrecheckOutput> {
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const [raw, accountRows, firewall] = await Promise.all([
    sqlRows(query, CLICKHOUSE, weeklySql(end)).then(found => found, asError),
    sqlRows(query, CLICKHOUSE, accountsSql(end)).then(found => found, asError),
    readFirewall(),
  ]);
  const rows = raw instanceof Error ? raw : raw.map((row): WeekRow => ({ ua: String(row.ua ?? ""), ip: String(row.ip ?? ""), refk: String(row.refk),
    page: Boolean(Number(row.page)), state: String(row.state) as State, calls: Number(row.calls), last: Number(row.last) }));
  const accounts = accountRows instanceof Error ? accountRows : accountRows.map((row): AccountDay => ({ user: String(row.user), day: String(row.day),
    views: Number(row.views), ips: Number(row.ips) }));
  const errors: string[] = [];
  if (rows instanceof Error) return weeklyClients({ rows, asns: new Map(), accounts, judge: { verify: { engine: () => null }, firewall }, errors, end });
  const verify = await verifier(rows.map(asRow), errors, signal);
  const judge = { verify, firewall };
  const lookup = rows.filter(row => needsNetwork(row, { ...judge, typical: null, fleet: new Set() })).map(row => row.ip);
  const asns = await asnOf(lookup, signal).then(found => found, asError);
  return weeklyClients({ rows, asns, accounts, judge, errors, end });
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
