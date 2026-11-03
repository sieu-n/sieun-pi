import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, type DsQuery, grafanaClient, readGrafanaAuth, sqlRows } from "./estate-reads.ts";
import { type Asn, asnOf, isHosting } from "./ip-asn.ts";
import { classify, ROUTES, type Row, typicalChrome, uaFamily, type Verify, verifier } from "./public-page-scrapers.ts";

/**
 * The precheck of ops guy's weekly duty "Scraper blocks" (`node --import tsx scripts/duties/weekly-scraper-blocks.ts`). The owner on 11-03 KST,
 * after a plain Safari UA pulled /profile pages from 264 IPs: "그냥 계속 수동으로 막는것도 해. as a weekly job. even 1%". It reads 7 days of prod
 * calls to the logged-out database pages and their APIs (the routes of public-page-scrapers.ts) from otel.otel_logs through Grafana, in one
 * aggregate query, and lists each client that is neither a verified search or AI engine, a link preview, our own box nor a person at a browser,
 * with 1% or more of the week's calls that the Vercel Firewall let through. A client is one reason and UA across all its IPs, so a scraper that
 * rotates IPs is one client:
 * - a UA that classify() in public-page-scrapers.ts reads as automated, grouped by its UA family with no version, or
 * - a browser UA from a hosting or cloud network (ip-asn.ts), grouped by its exact UA.
 * A browser UA from a home or mobile network is a person and is never listed. The headline counts the listed clients that still got through in
 * the last 24 h; the duty's job blocks each one through the scraper-blocklist Vercel Firewall rule (scraper-block.py).
 * Set WEEKLY_SCRAPERS_END to an ISO time to read the 7 days before it. Prints to OUTPUT_FILE, or stdout. No model call, nothing sent outside.
 */

const CLICKHOUSE = "grafana_clickhouse";
export const WEEK = 7 * DAY;
/** The owner's line, 11-03: "even 1%". */
export const SHARE_MIN_PCT = 1;
/** measured: on 11-03 the 7-day query took 159 to 164 s through Grafana at max_threads=2, the bulk whois of 100,655 IPs 58 to 66 s, and the whole first run 212 s. */
export const WEEK_DEADLINE_MS = 600_000;

export type State = "origin" | "hit" | "denied";
export interface WeekRow { ua: string; ip: string; refk: string; page: boolean; state: State; calls: number; last: number }

/** The row as public-page-scrapers.ts classifies it: a page or an API call, passed or denied. */
export const asRow = (row: WeekRow): Row => ({ route: row.page ? "profile" : "img", refk: row.refk, ref: "", ua: row.ua, ip: row.ip,
  status: row.state === "denied" ? 403 : 200, origin: row.state !== "denied", calls: row.calls, last: row.last });

/** The Chrome major people use most, read from the calls the firewall let through, the same line for the lookup and the list. */
export const typicalOf = (rows: readonly WeekRow[]): number | null => typicalChrome(rows.filter(row => row.state !== "denied").map(asRow));

/** Why a row's client is listed, or null for a wanted bot, our own box or a person. `asn` undefined means not looked up. */
export function clientKey(row: WeekRow, typical: number | null, verify: Verify, asn: Asn | undefined): string | null {
  const verdict = classify(asRow(row), typical, verify);
  if (verdict.kind === "wanted") return null;
  if (verdict.kind === "automated") return `${verdict.why} | ${uaFamily(row.ua).replace(/ \d+$/, "")}`;
  return asn && isHosting(asn.name) ? `browser UA from a hosting network | ${row.ua}` : null;
}

/**
 * The IPs whose network decides whether a client is listed or how to block it: those of each automated client and each exact browser UA whose
 * passed calls alone reach SHARE_MIN_PCT, since no smaller client can.
 */
export function lookupIps(rows: readonly WeekRow[], verify: Verify): Set<string> {
  const typical = typicalOf(rows);
  const passed = rows.filter(row => row.state !== "denied");
  const total = passed.reduce((sum, row) => sum + row.calls, 0);
  const groups = new Map<string, { calls: number; ips: Set<string> }>();
  for (const row of rows) {
    const verdict = classify(asRow(row), typical, verify);
    if (verdict.kind === "wanted") continue;
    const key = verdict.kind === "automated" ? clientKey(row, typical, verify, undefined)! : `ua ${row.ua}`;
    const group = groups.get(key) ?? { calls: 0, ips: new Set<string>() };
    if (row.state !== "denied") group.calls += row.calls;
    group.ips.add(row.ip);
    groups.set(key, group);
  }
  const ips = new Set<string>();
  for (const group of groups.values()) if (total && (group.calls / total) * 100 >= SHARE_MIN_PCT) for (const ip of group.ips) ips.add(ip);
  return ips;
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
const utcMin = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;
const shellText = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

interface Client { calls: number; denied: number; lastDenied: number; pages: number; ips: Set<string>; asns: Map<number, { name: string; calls: number }>; last: number; ua: string }

export interface WeekInputs { rows: readonly WeekRow[] | Error; asns: ReadonlyMap<string, Asn> | Error; verify: Verify; errors: readonly string[]; end: number }

/** The headline (listed clients still getting through) and one flagged item per client at or over SHARE_MIN_PCT, with a block command. */
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
  const typical = typicalOf(rows);
  const total = rows.reduce((sum, row) => sum + (row.state === "denied" ? 0 : row.calls), 0);
  if (!total) {
    flagged.push({ at, kind: "source_error", excerpt: "otel.otel_logs holds no prod call to the public database routes in the 7 days, so the Vercel drain or the query is broken" });
    return { metrics: {}, flagged };
  }
  const clients = new Map<string, Client>();
  for (const row of rows) {
    const asn = asns.get(row.ip);
    const key = clientKey(row, typical, input.verify, asn);
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
  const big = [...clients].filter(([, client]) => pct(client.calls, total) >= SHARE_MIN_PCT).sort((a, b) => b[1].calls - a[1].calls);
  /** Still getting through: a call passed in the last 24 h and after the firewall's last denial of this client, so a block made since reads as done. */
  const passing = (client: Client): boolean => client.last > at - DAY && client.last > client.lastDenied;
  const open = big.filter(([, client]) => passing(client));
  flagged.push({ at, kind: "reading", item: "unblocked_scrapers", excerpt: `${total} calls to the public database pages and their APIs got past the Vercel Firewall in the 7 days. ` +
    `${big.length} automated or hosting-network clients each made ${SHARE_MIN_PCT}% or more of them; ${open.length} still got through in the last 24 h ` +
    `and ${big.length - open.length} made none past the firewall since ${utcMin(at - DAY)} or since the firewall began to deny them.` });
  for (const [key, client] of big) {
    const nets = [...client.asns].sort((a, b) => b[1].calls - a[1].calls);
    const netText = nets.slice(0, 4).map(([asn, net]) => `AS${asn} ${net.name.slice(0, 40)} ${pct(net.calls, client.calls)}%`).join(", ");
    const hosting = nets.filter(([asn, net]) => asn && isHosting(net.name)).map(([asn]) => asn);
    const ua = key.startsWith("browser UA") ? ` --ua-sub ${shellText(client.ua)}` : "";
    const label = `${uaFamily(client.ua)}${nets[0]?.[0] ? ` from AS${nets[0][0]}` : ""}, weekly ${new Date(at).toISOString().slice(0, 10)}`;
    const command = `scripts/duties/scraper-block.py --label ${shellText(label)}${ua}` +
      `${hosting.length ? ` --asn ${hosting.slice(0, 8).join(" ")}` : ""}`;
    const still = passing(client);
    flagged.push({ at: client.last, kind: still ? "scraper_client" : "scraper_client_stopped", ...(still ? { item: "unblocked_scrapers" } : {}), sig: key,
      excerpt: `${pct(client.calls, total)}% (${client.calls} calls, ${client.pages} pages) from ${client.ips.size} IPs, ${Math.round((client.calls / client.ips.size) * 10) / 10} per IP, ` +
        `${client.denied} more denied, last ${utcMin(client.last)}: ${key.slice(0, 200)}; networks ${netText}; IPs ${[...client.ips].slice(0, 3).join(" ")}; ` +
        `start from: ${command}`.slice(0, 900) });
  }
  return { metrics: { unblocked_scrapers: open.length }, flagged, windowMs: { unblocked_scrapers: WEEK } };
}

const sqlText = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

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
FROM otel.otel_logs WHERE ServiceName = 'search' AND \`__hdx_materialized_deployment.environment.name\` = 'production'
  AND Timestamp > fromUnixTimestamp64Milli(${end - WEEK}) AND Timestamp <= fromUnixTimestamp64Milli(${end})
  AND LogAttributes['vercel.proxy.path'] != '' AND match(LogAttributes['vercel.proxy.path'], ${sqlText(any)})
GROUP BY ua, ip, refk, page, state
SETTINGS max_threads = 2, log_comment = 'duty weekly-scraper-blocks'`;
}

export async function measure(query: DsQuery, end: number, signal: AbortSignal): Promise<PrecheckOutput> {
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const raw = await sqlRows(query, CLICKHOUSE, weeklySql(end)).then(found => found, asError);
  const rows = raw instanceof Error ? raw : raw.map((row): WeekRow => ({ ua: String(row.ua ?? ""), ip: String(row.ip ?? ""), refk: String(row.refk),
    page: Boolean(Number(row.page)), state: String(row.state) as State, calls: Number(row.calls), last: Number(row.last) }));
  const errors: string[] = [];
  if (rows instanceof Error) return weeklyClients({ rows, asns: new Map(), verify: { engine: () => null }, errors, end });
  const verify = await verifier(rows.map(asRow), errors, signal);
  const asns = await asnOf(lookupIps(rows, verify), signal).then(found => found, asError);
  return weeklyClients({ rows, asns, verify, errors, end });
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
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
