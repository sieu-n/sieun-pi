import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import {
  daysBetween, indexedFromMetrics, inspectUrls, lastVerdictsFromMetrics, listSlice, mapLimit, parseSitemap, publishedDay, REASK_AFTER_MS,
  REQUESTS_LOG, requestedUrls, seoulDay, UNMEASURED, type InspectRead, type InspectRow, type InspectVerdict,
} from "./seo-new-articles.ts";

/**
 * The SEO guy's api.virev.ai search precheck (`node --import tsx scripts/duties/seo-api-site.ts`), duty d3 for plan goal p144 (500 api.virev.ai
 * visits a day and 30 API sign-ups a month by 12-31). No model call. It reads:
 * 1. the live sitemap https://api.virev.ai/sitemap.xml, and each URL it has not seen answer 200 yet, for its status and, under /blog/, its
 *    article:published_time;
 * 2. URL Inspection on sc-domain:virev.ai (seo-sources.py inspect, the same quota counter as d2) for sitemap URLs live INDEX_AFTER_DAYS or more
 *    days, reusing a not-indexed verdict for REASK_AFTER_MS unless the URL had an accepted Request indexing, as d2 does, and an indexed one for
 *    INDEXED_REASK_MS;
 * 3. seo-sources.py api, the numbers `seo api` prints (PostHog visits, API sign-ups, Search Console clicks), without its metrics file write;
 * 4. serp-checks.jsonl, which the weekly competitor check (~/work/api-seo/serp_check.py, run by the duty job) appends.
 * The state keeps each URL's first-seen day, so the day a URL went live is the day the sitemap first listed it. On the first run (no state)
 * that day is its article date or lastmod, or, for a URL with neither, the run day minus INDEX_AFTER_DAYS, because it was already live.
 * A source that fails counts in source_errors and gives its metrics the miss value.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const PROGRAM = process.env.SEO_PROGRAM_DIR || join(REPO, "apps/llm-wiki/content/sessions/2026/10/02/0040-virev-seo-agent/program");
const SOURCES_PY = join(import.meta.dirname, "seo-sources.py");
const SERP_CHECKS = process.env.SEO_API_SERP_CHECKS || join(homedir(), "work/api-seo/serp-checks.jsonl");
export const SITEMAP = "https://api.virev.ai/sitemap.xml";
/**
 * api_unindexed_7d counts sitemap URLs live INDEX_AFTER_DAYS or more days that Google has not indexed. d2 gives a virev.ai article 3 days, from 13 of
 * 13 requested URLs indexed within 7 days (10-02 to 10-09); api.virev.ai is a new subdomain Google has indexed none of (0 of 14 on 11-26), so
 * it gets the whole 7 days that measure took.
 * days_since_new_api_article <= 3 is the owner's "write blogs" for api.virev.ai (#api-portal-outreach p10, mwwg7czp), checked in the duty file.
 * COMPETITOR_CHECK_DAYS: the weekly competitor read the seo chat set for d3 on 11-26.
 * PAGE_CONCURRENCY: d2's, measured 10-12, 16 parallel GETs read 376 virev.ai article pages in 11 s.
 */
export const INDEX_AFTER_DAYS = 7;
export const COMPETITOR_CHECK_DAYS = 7;
/**
 * An indexed verdict is asked again after INDEXED_REASK_MS, because Google drops api.virev.ai pages: / and /docs read PASS in metrics/2026-10-02.json
 * and "Crawled - currently not indexed" on 11-26 (keywords.md). It costs about one call a day per 7 indexed URLs against Google's 2,000.
 */
export const INDEXED_REASK_MS = 7 * 86_400_000;
const PAGE_CONCURRENCY = 16;

export interface PageState { firstSeen: string; status: number; published?: string }
export interface ApiSiteState { pages: Record<string, PageState>; indexed: Record<string, string>; inspected: Record<string, InspectVerdict> }
/** What seo-sources.py api prints: virev_seo.api_goal.collect without its daily rows. */
export interface ApiRead {
  visits_per_day: { d7: number; d28: number }; visits_target_per_day: number;
  signups: { d7: number; d28: number; per_30_days: number }; signups_target_per_month: number;
  gsc: { start: string; end: string; clicks_per_day: number; impressions_per_day: number; top_queries: { query: string; clicks: number; impressions: number; position: number }[] };
}
export interface SerpCheck { at: string; keywords: { keyword: string; engine?: string; top?: string[]; ours_top3?: boolean; ours_rank?: number | null; error?: string }[] }
export interface ApiSiteDeps {
  fetch: typeof fetch;
  inspect: (urls: string[]) => Promise<InspectRead>;
  readApi: () => Promise<ApiRead>;
  /** Text of a file under the program folder, by path relative to it. */
  readProgram: (path: string) => Promise<string>;
  /** File names in the program's metrics folder. */
  listMetrics: () => Promise<string[]>;
  /** serp-checks.jsonl, or "" when no check has run. */
  readSerpChecks: () => Promise<string>;
  now: () => number;
}

const NOT_ASKED_PREFIX = "not asked:";
const path = (url: string): string => url.replace(/^https:\/\/api\.virev\.ai/, "") || "/";
const isArticle = (url: string): boolean => /^https:\/\/api\.virev\.ai\/blog\/[^/]+$/.test(url);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const shiftDay = (day: string, days: number): string => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);

/** The newest serp-checks.jsonl line that parses, or undefined. */
export function lastSerpCheck(text: string): SerpCheck | undefined {
  let last: SerpCheck | undefined;
  for (const line of text.split("\n")) {
    try { const row = JSON.parse(line) as SerpCheck; if (typeof row.at === "string" && Array.isArray(row.keywords) && (!last || row.at > last.at)) last = row; } catch { continue; }
  }
  return last;
}

export async function measureApiSite(deps: ApiSiteDeps, previous: ApiSiteState | undefined): Promise<{ output: PrecheckOutput; state: ApiSiteState }> {
  const at = deps.now();
  const today = seoulDay(at);
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = { api_unindexed_7d: UNMEASURED, days_since_new_api_article: UNMEASURED, days_since_competitor_check: UNMEASURED, source_errors: 0 };
  const state: ApiSiteState = { pages: { ...previous?.pages }, indexed: { ...previous?.indexed }, inspected: { ...previous?.inspected } };
  const fail = (source: string, why: string, keys: string[]): void => {
    metrics.source_errors! += 1;
    flagged.push({ at, kind: "source_error", excerpt: `${source}: ${why}. Not measured this run, so ${keys.length ? `${keys.join(", ")} read the miss value ${UNMEASURED}` : "its readings are left out"}.` });
  };
  const apiRead = deps.readApi().then(value => ({ value }), (error: unknown) => ({ error: message(error) }));

  let sitemap: Map<string, string> | undefined;
  try {
    const response = await deps.fetch(SITEMAP);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const parsed = parseSitemap(await response.text());
    if (!parsed.size) throw new Error("no <url> in the sitemap");
    sitemap = parsed;
  } catch (error) { fail(`api.virev.ai sitemap ${SITEMAP}`, message(error), ["api_unindexed_7d", "days_since_new_api_article"]); }

  if (sitemap) {
    const urls = [...sitemap.keys()];
    const toFetch = urls.filter(url => state.pages[url]?.status !== 200);
    const pages = await mapLimit(toFetch, PAGE_CONCURRENCY, async url => {
      try {
        const response = await deps.fetch(url);
        return { url, status: response.status, published: response.status === 200 && isArticle(url) ? publishedDay(await response.text()) : "" };
      } catch { return { url, status: 0, published: "" }; }
    });
    const fresh: string[] = [];
    for (const page of pages) {
      const known = state.pages[page.url];
      const published = page.published || known?.published || "";
      const firstSeen = known?.firstSeen ?? (previous ? today : published || sitemap.get(page.url)!.slice(0, 10) || shiftDay(today, -INDEX_AFTER_DAYS));
      if (!known && previous) fresh.push(page.url);
      state.pages[page.url] = { firstSeen, status: page.status, ...(published ? { published } : {}) };
    }
    for (const url of Object.keys(state.pages)) if (!sitemap.has(url)) delete state.pages[url];
    const live = urls.filter(url => state.pages[url]!.status === 200);
    const broken = urls.filter(url => state.pages[url]!.status !== 200);
    if (broken.length) flagged.push(...listSlice("not_200", "Sitemap URLs that did not answer 200:", broken.map(url => `${path(url)} (${state.pages[url]!.status || "no answer"})`), at));
    if (fresh.length) flagged.push(...listSlice("new_urls", `New in the sitemap since the last run (${fresh.length}):`, fresh.map(path), at));

    const articles = live.filter(url => isArticle(url) && state.pages[url]!.published);
    const newest = articles.reduce((max, url) => state.pages[url]!.firstSeen > max ? state.pages[url]!.firstSeen : max, "");
    if (newest) {
      metrics.days_since_new_api_article = Math.max(0, daysBetween(newest, today));
      flagged.push(...listSlice("newest", `${articles.length} api.virev.ai blog articles answer 200. The newest went live ${newest}:`, articles.filter(url => state.pages[url]!.firstSeen === newest).map(path), at));
    } else fail("api.virev.ai blog", "no /blog/<slug> page answered 200 with an article date", ["days_since_new_api_article"]);

    const files = new Map<string, unknown>();
    for (const name of (await deps.listMetrics().catch(() => [] as string[])).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))) {
      files.set(name, await deps.readProgram(`metrics/${name}`).then(text => JSON.parse(text) as unknown, () => undefined));
    }
    for (const [url, day] of Object.entries(indexedFromMetrics(files))) if (sitemap.has(url) && day > (state.indexed[url] ?? "")) state.indexed[url] = day;
    for (const [url, last] of Object.entries(lastVerdictsFromMetrics(files))) if (sitemap.has(url) && last.at > (state.inspected[url]?.at ?? -1)) state.inspected[url] = last;
    for (const url of Object.keys(state.indexed)) if (!sitemap.has(url)) delete state.indexed[url];
    for (const url of Object.keys(state.inspected)) if (!sitemap.has(url)) delete state.inspected[url];
    const age = (url: string): number => daysBetween(state.pages[url]!.firstSeen, today);
    /** The newest thing an inspection said about a URL: indexed (a PASS, dated at the start of its Seoul day) or its last other verdict. */
    const known = (url: string): { indexed: boolean; at: number } | undefined => {
      const indexedAt = state.indexed[url] ? Date.parse(`${state.indexed[url]}T00:00:00+09:00`) : -Infinity;
      const last = state.inspected[url];
      if (last && last.at > indexedAt) return { indexed: false, at: last.at };
      return Number.isFinite(indexedAt) ? { indexed: true, at: indexedAt } : undefined;
    };
    const counted = live.filter(url => age(url) >= INDEX_AFTER_DAYS);
    const younger = live.length - counted.length;
    try {
      const requested = await deps.readProgram(REQUESTS_LOG).then(requestedUrls, () => new Set<string>());
      const ask = counted.filter(url => {
        const last = known(url);
        if (!last) return true;
        if (last.indexed) return at - last.at >= INDEXED_REASK_MS;
        return requested.has(url) || at - last.at >= REASK_AFTER_MS;
      });
      const { rows, not_asked: skipped }: InspectRead = ask.length ? await deps.inspect(ask) : { rows: [], not_asked: [] };
      const good = (row: InspectRow): boolean => row.http === 200 && !row.error;
      const refused = rows.some(row => row.http === 429);
      const stale = new Set([...skipped, ...rows.filter(row => row.http === 429 || (refused && row.error?.startsWith(NOT_ASKED_PREFIX))).map(row => row.url)]);
      const failed = rows.filter(row => !good(row) && !stale.has(row.url));
      for (const row of rows.filter(good)) {
        if (row.verdict === "PASS") { state.indexed[row.url] = today; delete state.inspected[row.url]; }
        else state.inspected[row.url] = { at, verdict: row.verdict ?? null, coverage_state: row.coverage_state ?? null };
      }
      const unindexed = counted.filter(url => !known(url)?.indexed && !failed.some(row => row.url === url));
      const why = (url: string): string => {
        const last = state.inspected[url];
        const verdict = last ? last.coverage_state ?? last.verdict ?? "?" : "never inspected";
        return stale.has(url) ? `${verdict}, stale: quota spent` : verdict;
      };
      metrics.api_unindexed_7d = unindexed.length + failed.length;
      if (failed.length) {
        metrics.source_errors! += 1;
        flagged.push(...listSlice("source_error", `URL Inspection failed for ${failed.length} of ${ask.length} asked; they count as not indexed:`, failed.map(row => `${path(row.url)} (${row.error ?? `HTTP ${row.http}`})`), at));
      }
      const indexedNow = live.filter(url => known(url)?.indexed);
      flagged.push({ at, kind: "inspect_calls", excerpt: `Detail: ${indexedNow.length} of ${live.length} live sitemap URLs read indexed${indexedNow.length ? ` (${indexedNow.map(path).join(", ")})` : ""}, and ${younger} are under ${INDEX_AFTER_DAYS} days live. ` +
        `URL Inspection asked ${rows.filter(row => !row.error?.startsWith(NOT_ASKED_PREFIX)).length} of ${counted.length}; the rest kept a verdict under 23 h old, or an indexed one under ${INDEXED_REASK_MS / 86_400_000} days old` +
        (stale.size ? `, and ${stale.size} kept a stale verdict because the day's quota is spent.` : ".") });
      flagged.push(...listSlice("unindexed", `Sitemap URLs live ${INDEX_AFTER_DAYS} or more days that Google has not indexed (${unindexed.length} of ${counted.length}):`,
        unindexed.map(url => `${path(url)} (live ${age(url)} days, ${why(url)})`), at));
    } catch (error) { fail("Search Console URL Inspection (seo-sources.py inspect)", message(error), ["api_unindexed_7d"]); }
  }

  const api = await apiRead;
  if ("value" in api) {
    const { visits_per_day: visits, signups, gsc } = api.value;
    metrics.api_visits_day = visits.d7;
    metrics.api_signups_month = signups.per_30_days;
    flagged.push({ at, kind: "goal", excerpt: `Detail (p144): api.virev.ai public visits ${visits.d7} a day over 7 days (${visits.d28} over 28, target ${api.value.visits_target_per_day}); ` +
      `API sign-ups ${signups.d7} in 7 days, ${signups.per_30_days} per 30 days (target ${api.value.signups_target_per_month}); Google ${gsc.start}..${gsc.end} ${gsc.clicks_per_day} clicks and ${gsc.impressions_per_day} impressions a day.` +
      (gsc.top_queries.length ? ` Top queries: ${gsc.top_queries.slice(0, 5).map(row => `${row.query} (${row.impressions} impr, pos ${row.position.toFixed(1)})`).join(", ")}.` : "") });
  } else fail("api.virev.ai goal read (seo-sources.py api: PostHog, Convex, Clerk, Search Console)", api.error, []);

  try {
    const check = lastSerpCheck(await deps.readSerpChecks());
    if (check) {
      metrics.days_since_competitor_check = Math.max(0, daysBetween(seoulDay(Date.parse(check.at)), today));
      const ours = check.keywords.filter(row => row.ours_top3);
      flagged.push({ at, kind: "competitors", excerpt: `Detail: the competitor check of ${seoulDay(Date.parse(check.at))} found api.virev.ai in the top 3 for ${ours.length} of ${check.keywords.length} write-first keywords` +
        `${ours.length ? ` (${ours.map(row => row.keyword).join(", ")})` : ""}. Top 3: ` +
        check.keywords.map(row => `${row.keyword}: ${row.error ?? (row.top ?? []).map(url => { try { return new URL(url).hostname; } catch { return url; } }).join(", ")}`).join("; ") });
    } else flagged.push({ at, kind: "competitors", excerpt: `Detail: no competitor check has run yet (${SERP_CHECKS} is empty or missing).` });
  } catch (error) { flagged.push({ at, kind: "detail_error", excerpt: `${SERP_CHECKS} could not be read (${message(error)})` }); }

  return { output: { metrics, flagged, ...(metrics.api_unindexed_7d! > 0 ? { lastEventAt: { api_unindexed_7d: at } } : {}) }, state };
}

/** seo-sources.py api in auto-sns-agent's SEO CLI project: one JSON object on stdout. */
export function readApi(repo: string): Promise<ApiRead> {
  return new Promise((resolve, reject) => {
    execFile("uv", ["run", "--project", "scripts/seo", "--frozen", "python", SOURCES_PY, "api"], { cwd: repo, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${error.message} ${stderr.trim()}`.trim())); return; }
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as ApiRead); } catch (parseError) { reject(parseError); }
    });
  });
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("seo-api-site: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as ApiSiteState, () => undefined) : undefined;
  const result = await measureApiSite({
    fetch, now: Date.now, inspect: urls => inspectUrls(REPO, urls), readApi: () => readApi(REPO),
    readProgram: file => readFile(join(PROGRAM, file), "utf8"), listMetrics: () => readdir(join(PROGRAM, "metrics")),
    readSerpChecks: () => readFile(SERP_CHECKS, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; }),
  }, previous?.pages ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
