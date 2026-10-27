import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The SEO guy's New articles get indexed precheck (`node --import tsx scripts/duties/seo-new-articles.ts`). No model call. It reads:
 * 1. the live blog sitemap (https://virev.ai/blog/sitemap.xml lists every locale; an article is a <url> with a <lastmod>), and each
 *    article page it has not seen answer 200 yet, for its status and article:published_time;
 * 2. URL Inspection (seo-sources.py inspect, counted in metrics/inspect-quota.json) for articles that went live in the last 14 days, are live
 *    3 or more days, and that no earlier inspection in metrics/*.json or this duty's state saw indexed, at most once per article per
 *    REASK_AFTER_MS, or at every run for one with an accepted Request indexing in REQUESTS_LOG;
 * 3. for detail lines only: metrics/indexnow-sent.json of the SEO program, for sitemap URLs `seo indexnow --new` would still send, and the
 *    program's ledger.jsonl, for checks past their date with no result and the share of the last 30 days' scored checks that won.
 * The state keeps each article's first-seen day, so the day an article went live is the day the sitemap first listed it. On the first run
 * (no state) that day is the page's published date. A source that fails counts in source_errors and gives its metrics the miss value.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const PROGRAM = process.env.SEO_PROGRAM_DIR || join(REPO, "apps/llm-wiki/content/sessions/2026/10/02/0040-virev-seo-agent/program");
const SOURCES_PY = join(import.meta.dirname, "seo-sources.py");
export const SITEMAP = "https://virev.ai/blog/sitemap.xml";
/** The miss value of a metric whose source failed, the convention of auto-sns-agent scripts/duties/ci/duty-sources.mjs (UNMEASURED). */
export const UNMEASURED = 999_999;
/**
 * Where each number comes from. The duty (seo-new-articles.duty.json) is one headline plus 2 supporting metrics (c75), each read from the
 * owner's words "keep publishing blog articles daily":
 * days_since_new_article <= 1, the headline: an article or edition went live today or yesterday.
 * new_unindexed_3d <= 0: articles that went live in the last NEW_WINDOW_DAYS days, live INDEX_AFTER_DAYS or more days, that Google has not
 * indexed. A published article that nobody can find is not published, and the older backlog (285 on 10-15) is a detail line, so a fixed
 * new-article pipeline can turn this green while the crawl demand fix job works the backlog.
 * new_unindexed_3d's `lastEventAt` is this run whenever it is above 0: each run reads every counted article's verdict from the last 24 h,
 * or its last known verdict, marked stale, when Google refused the call for quota, so the count drops the run an article is seen indexed. It is an open count, like repeat-split's after_fix lines, and no
 * old event waits in it to leave a window. Dating it by the day each article crossed 3 days would read it quiet: on 10-20 at 05:52Z
 * /blog/instagram-collab-posts, past 3 days since 10-18, read "Discovered - currently not indexed", and a quiet count starts no fix job
 * for the 9 days before it leaves the 14-day window. A failed inspection or source counts as unindexed, and it failed at this run too.
 * source_errors <= 0: the sitemap, the pages and URL Inspection were read.
 * Detail lines with no target: the older unindexed backlog, sitemap URLs IndexNow has not got, overdue ledger checks and the 30-day ledger
 * win share.
 * INDEX_AFTER_DAYS: the program ledger's seo-recrawl checks measured 13 of 13 requested URLs indexed within 7 days (10-02 to 10-09) and 9 of
 * 11 the same day on 10-12.
 * NEW_WINDOW_DAYS: the 10-15 brief for this duty, "count only articles published in the last 14 days, not the old backlog".
 * Only new articles are inspected. Inspecting the backlog too took the 10-14 and 10-15 runs to 107 s and 74 s against the 120 s precheck
 * timeout; the backlog line counts the older articles no inspection in metrics/*.json or this duty's state has seen indexed.
 * PAGE_CONCURRENCY: measured 10-12, 16 parallel GETs read all 376 article pages in 11 s.
 */
export const INDEX_AFTER_DAYS = 3;
export const NEW_WINDOW_DAYS = 14;
export const WIN_WINDOW_DAYS = 30;
const PAGE_CONCURRENCY = 16;

/**
 * A sitemap URL is an article when its page carries article:published_time or datePublished, and a listing (/blog/page/N, /blog/tag/x, a
 * category hub such as /blog/tiktok) when it answered 200 without one. On 10-18 115 of the 128 new_unindexed_3d URLs were /page/N and /tag/
 * listings and about 9 were category hubs, so only articles count. A state row from before this field has no kind and is fetched again.
 */
export type PageKind = "article" | "listing";
export interface ArticleState { published: string; firstSeen: string; status: number; kind?: PageKind }
/** The last answer URL Inspection gave for an article that was not PASS, and when (epoch ms). */
export interface InspectVerdict { at: number; verdict: string | null; coverage_state: string | null }
/** `inspected` is absent in state written before 10-26. */
export interface ArticlesState { articles: Record<string, ArticleState>; indexed: Record<string, string>; inspected?: Record<string, InspectVerdict> }
export interface InspectRow { url: string; http: number; verdict?: string | null; coverage_state?: string | null; error?: string | null }
export interface InspectRead { rows: InspectRow[]; not_asked: string[]; quota_left_before?: number }
export interface LedgerEntry { worker?: string; url?: string; check_date?: string; result?: string; result_date?: string }
export interface ArticlesDeps {
  fetch: typeof fetch;
  inspect: (urls: string[]) => Promise<InspectRead>;
  /** Text of a file under the program folder, by path relative to it. */
  readProgram: (path: string) => Promise<string>;
  /** File names in the program's metrics folder. */
  listMetrics: () => Promise<string[]>;
  now: () => number;
}

/** The Seoul calendar day of a time, as YYYY-MM-DD. */
export const seoulDay = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
/**
 * An article's verdict is reused for 24 h, so d2 asks each counted article at most once in any 24 h, whatever the number of runs.
 * Google allows URL Inspection 2,000 calls a day per property (developers.google.com/webmaster-tools/limits). measured: on 10-25 Vent logged
 * 13 d2 runs that asked about all 144 to 146 counted articles each, 2,001 calls by 19:01Z, when Google began answering 429
 * "Quota exceeded for sc-domain:virev.ai.", and it still answered 429 at 2026-10-26 00:08Z (Vent prod otel.vent_calls).
 */
export const REASK_AFTER_MS = 24 * 3_600_000;
/**
 * The Request indexing log of the daily Search Console window (second google user's windows.py), one JSON row per attempt, under the program
 * folder. An article with an accepted request is asked again at every run until it reads indexed, so the drop shows at the next run instead
 * of up to 24 h later. On 10-28 at 02:41 KST d2 still counted 6 of the 7 counted articles the 10-27 03:31Z window requested, from verdicts
 * taken at 01:20Z, and all 6 read "Submitted and indexed" at 18:45Z. It costs one call per requested article that is not indexed yet, 9 at
 * that run, against Google's 2,000 a day.
 */
export const REQUESTS_LOG = "workers/place-pages/indexing-requests.jsonl";
const NOT_ASKED_PREFIX = "not asked:";
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
const unescape = (text: string): string => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&quot;/g, '"').trim();

/** {loc: lastmod} for every <url> of a sitemap; lastmod is "" when absent. The blog sitemap gives a lastmod to articles only. */
export function parseSitemap(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(block!)?.[1];
    if (loc) out.set(unescape(loc), unescape(/<lastmod>([^<]+)<\/lastmod>/.exec(block!)?.[1] ?? ""));
  }
  return out;
}

/** Sitemap URLs IndexNow never accepted, or accepted with another lastmod: what `seo indexnow --new` sends (virev_seo.indexnow.pending). */
export function indexNowPending(sitemap: ReadonlyMap<string, string>, sent: Record<string, { lastmod?: string }>): string[] {
  return [...sitemap].filter(([url, lastmod]) => !(url in sent) || sent[url]!.lastmod !== lastmod).map(([url]) => url);
}

/** The page's article:published_time (or JSON-LD datePublished) day, or "" when it has none. */
export function publishedDay(html: string): string {
  return (/article:published_time" content="([^"]+)"/.exec(html)?.[1] ?? /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? "").slice(0, 10);
}

/** URLs some inspection saw indexed (verdict PASS), with the day, from every section with `rows` in metrics/YYYY-MM-DD.json files. */
export function indexedFromMetrics(files: ReadonlyMap<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, data] of files) {
    if (typeof data !== "object" || data === null) continue;
    for (const section of Object.values(data)) {
      const rows = typeof section === "object" && section !== null && Array.isArray((section as { rows?: unknown }).rows) ? (section as { rows: InspectRow[] }).rows : [];
      for (const row of rows) if (row?.verdict === "PASS" && typeof row.url === "string" && !(row.url in out)) out[row.url] = name.slice(0, 10);
    }
  }
  return out;
}

/** The newest answer other than PASS for each URL in the metrics/YYYY-MM-DD.json `rows` sections, dated at the start of that Seoul day. */
export function lastVerdictsFromMetrics(files: ReadonlyMap<string, unknown>): Record<string, InspectVerdict> {
  const out: Record<string, InspectVerdict> = {};
  for (const [name, data] of files) {
    if (typeof data !== "object" || data === null) continue;
    const at = Date.parse(`${name.slice(0, 10)}T00:00:00+09:00`);
    for (const section of Object.values(data)) {
      const rows = typeof section === "object" && section !== null && Array.isArray((section as { rows?: unknown }).rows) ? (section as { rows: InspectRow[] }).rows : [];
      for (const row of rows) {
        if (row?.http !== 200 || row.error || !row.verdict || row.verdict === "PASS" || typeof row.url !== "string") continue;
        if (at > (out[row.url]?.at ?? -1)) out[row.url] = { at, verdict: row.verdict, coverage_state: row.coverage_state ?? null };
      }
    }
  }
  return out;
}

/** URLs the window's log shows an accepted Request indexing for ("Indexing requested"); a line that is not JSON is skipped. */
export function requestedUrls(log: string): Set<string> {
  const out = new Set<string>();
  for (const line of log.split("\n")) {
    try {
      const row = JSON.parse(line) as { url?: unknown; result?: unknown };
      if (typeof row.url === "string" && row.result === "Indexing requested") out.add(row.url);
    } catch { continue; }
  }
  return out;
}

/** Overdue checks (no result, check date before today) and the win share of checks scored in the last 30 days. */
export function ledgerStats(entries: readonly LedgerEntry[], today: string): { overdue: LedgerEntry[]; scored: number; wins: number } {
  const overdue = entries.filter(entry => !entry.result && typeof entry.check_date === "string" && entry.check_date < today);
  const scored = entries.filter(entry => entry.result && entry.result_date && daysBetween(entry.result_date, today) <= WIN_WINDOW_DAYS);
  return { overdue, scored: scored.length, wins: scored.filter(entry => entry.result === "win").length };
}

/** One flagged slice that lists every item after its head line, or none when there is no item. */
export function listSlice(kind: string, head: string, items: readonly string[], at: number): FlaggedSlice[] {
  return items.length ? [{ at, kind, excerpt: `${head} ${items.join(", ")}` }] : [];
}

const path = (url: string): string => url.replace(/^https:\/\/virev\.ai/, "");

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await fn(items[index]!); }
  }));
  return out;
}

export async function measureArticles(deps: ArticlesDeps, previous: ArticlesState | undefined): Promise<{ output: PrecheckOutput; state: ArticlesState }> {
  const at = deps.now();
  const today = seoulDay(at);
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = { days_since_new_article: UNMEASURED, new_unindexed_3d: UNMEASURED, source_errors: 0 };
  const state: ArticlesState & { inspected: Record<string, InspectVerdict> } = {
    articles: { ...previous?.articles }, indexed: { ...previous?.indexed },
    inspected: Object.fromEntries(Object.entries(previous?.inspected ?? {}).filter(([, last]) => typeof last.at === "number")),
  };
  const fail = (source: string, why: string, keys: string[]): void => {
    metrics.source_errors! += 1;
    flagged.push({ at, kind: "source_error", excerpt: `${source}: ${why}. Not measured this run, so ${keys.join(", ")} read the miss value ${UNMEASURED}.` });
  };
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

  let sitemap: Map<string, string> | undefined;
  try {
    const response = await deps.fetch(SITEMAP);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const parsed = parseSitemap(await response.text());
    if (!parsed.size) throw new Error("no <url> in the sitemap");
    sitemap = parsed;
  } catch (error) { fail(`Blog sitemap ${SITEMAP}`, message(error), ["days_since_new_article", "new_unindexed_3d"]); }

  if (sitemap) {
    const articles = [...sitemap].filter(([, lastmod]) => lastmod).map(([url]) => url);
    const toFetch = articles.filter(url => state.articles[url]?.status !== 200 || !state.articles[url]?.kind);
    const pages = await mapLimit(toFetch, PAGE_CONCURRENCY, async url => {
      try {
        const response = await deps.fetch(url);
        const published = response.status === 200 ? publishedDay(await response.text()) : "";
        const kind: PageKind | undefined = response.status !== 200 ? undefined : published ? "article" : "listing";
        return { url, status: response.status, published, kind };
      } catch { return { url, status: 0, published: "", kind: undefined }; }
    });
    const fresh: string[] = [];
    for (const page of pages) {
      const known = state.articles[page.url];
      const published = page.published || known?.published || sitemap.get(page.url)!.slice(0, 10);
      const firstSeen = known?.firstSeen ?? (previous ? today : published);
      const kind = page.kind ?? known?.kind;
      if (!known && previous && kind === "article") fresh.push(page.url);
      state.articles[page.url] = { published, firstSeen, status: page.status, ...(kind ? { kind } : {}) };
    }
    for (const url of Object.keys(state.articles)) if (!sitemap.has(url)) delete state.articles[url];
    const broken = articles.filter(url => state.articles[url]!.status !== 200);
    if (broken.length) flagged.push(...listSlice("not_200", "Articles in the sitemap that did not answer 200:", broken.map(url => `${path(url)} (${state.articles[url]!.status || "no answer"})`), at));
    if (fresh.length) flagged.push(...listSlice("new_articles", `New in the sitemap since the last run (${fresh.length}):`, fresh.map(path), at));

    const live = articles.filter(url => state.articles[url]!.status === 200 && state.articles[url]!.kind === "article");
    const listings = articles.filter(url => state.articles[url]!.kind === "listing").length;
    if (listings) flagged.push({ at, kind: "listings", excerpt: `Detail: ${listings} sitemap URLs are listing pages (pagination, tags, category hubs) with no article:published_time, left out of every metric.` });
    const newest = live.reduce((max, url) => state.articles[url]!.firstSeen > max ? state.articles[url]!.firstSeen : max, "");
    if (newest) {
      metrics.days_since_new_article = Math.max(0, daysBetween(newest, today));
      const newestUrls = live.filter(url => state.articles[url]!.firstSeen === newest).map(path);
      flagged.push(...listSlice("newest", `${live.length} articles answer 200. The newest went live ${newest}:`, newestUrls, at));
    } else fail("Blog articles", "no article page answered 200", ["days_since_new_article"]);

    try {
      const sent = JSON.parse(await deps.readProgram("metrics/indexnow-sent.json")) as Record<string, { lastmod?: string }>;
      const pending = indexNowPending(sitemap, sent);
      flagged.push(...(pending.length ? listSlice("indexnow_unsent", `Detail: sitemap URLs IndexNow has not got in their current version (${pending.length}), sent by \`seo indexnow --new\`:`, pending.map(path), at)
        : [{ at, kind: "indexnow_unsent", excerpt: `Detail: IndexNow has all ${sitemap.size} sitemap URLs in their current version (indexnow_unsent 0).` }]));
    } catch (error) { flagged.push({ at, kind: "detail_error", excerpt: `metrics/indexnow-sent.json could not be read (${message(error)}), so the IndexNow detail line is missing` }); }

    const files = new Map<string, unknown>();
    for (const name of (await deps.listMetrics().catch(() => [] as string[])).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))) {
      files.set(name, await deps.readProgram(`metrics/${name}`).then(text => JSON.parse(text) as unknown, () => undefined));
    }
    for (const [url, day] of Object.entries(indexedFromMetrics(files))) state.indexed[url] ??= day;
    const age = (url: string): number => daysBetween(state.articles[url]!.firstSeen, today);
    const unseen = live.filter(url => age(url) >= INDEX_AFTER_DAYS && !state.indexed[url]);
    const due = unseen.filter(url => age(url) <= NEW_WINDOW_DAYS);
    const backlog = unseen.filter(url => age(url) > NEW_WINDOW_DAYS);
    try {
      for (const url of Object.keys(state.inspected)) if (!due.includes(url)) delete state.inspected[url];
      for (const [url, last] of Object.entries(lastVerdictsFromMetrics(files))) {
        if (due.includes(url) && last.at > (state.inspected[url]?.at ?? -1)) state.inspected[url] = last;
      }
      const requested = await deps.readProgram(REQUESTS_LOG).then(requestedUrls, () => new Set<string>());
      const ask = due.filter(url => requested.has(url) || !(at - (state.inspected[url]?.at ?? -Infinity) < REASK_AFTER_MS));
      const reasked = ask.filter(url => requested.has(url) && at - (state.inspected[url]?.at ?? -Infinity) < REASK_AFTER_MS).length;
      // seo-sources.py inspect asks a failed URL once more itself, but never after a 429, and after a 429 any caller saw it asks one URL first.
      const { rows, not_asked: skipped, quota_left_before: quotaLeft }: InspectRead = ask.length ? await deps.inspect(ask) : { rows: [], not_asked: [] };
      const good = (row: InspectRow): boolean => row.http === 200 && !row.error;
      const refused = rows.some(row => row.http === 429);
      // Google's 429 and the inspect-quota.json counter both mean the day's calls are spent, so those articles keep their last verdict.
      const stale = new Set([...skipped, ...rows.filter(row => row.http === 429 || (refused && row.error?.startsWith(NOT_ASKED_PREFIX))).map(row => row.url)]);
      const failed = rows.filter(row => !good(row) && !stale.has(row.url));
      for (const row of rows.filter(good)) {
        if (row.verdict === "PASS") { state.indexed[row.url] = today; delete state.inspected[row.url]; } else state.inspected[row.url] = { at, verdict: row.verdict ?? null, coverage_state: row.coverage_state ?? null };
      }
      const unindexed = due.filter(url => !state.indexed[url] && !failed.some(row => row.url === url));
      const why = (url: string): string => {
        const last = state.inspected[url];
        const verdict = last ? last.coverage_state ?? last.verdict ?? "?" : "never inspected";
        return stale.has(url) ? `${verdict}${last ? ` as of ${new Date(last.at).toISOString().slice(0, 16)}Z` : ""}, stale: quota spent` : verdict;
      };
      metrics.new_unindexed_3d = unindexed.length + failed.length;
      if (failed.length) {
        metrics.source_errors! += 1;
        flagged.push(...listSlice("source_error", `URL Inspection failed for ${failed.length} of ${ask.length} asked; they count as not indexed:`, failed.map(row => `${path(row.url)} (${row.error ?? `HTTP ${row.http}`})`), at));
      }
      flagged.push({ at, kind: "inspect_calls", excerpt: `Detail: URL Inspection asked ${rows.filter(row => !row.error?.startsWith(NOT_ASKED_PREFIX)).length} of ${due.length} articles; ` +
        `${due.length - ask.length} kept a verdict under 24 h old` + (reasked ? `, and ${reasked} with a Request indexing were asked again before 24 h` : "") + (stale.size ? `, and ${stale.size} kept their last verdict as stale because ` +
        (refused ? `Google answered 429 "Quota exceeded"` : `metrics/inspect-quota.json had ${Math.max(0, quotaLeft ?? 0)} calls left for the UTC day`) +
        "; one that no inspection has seen indexed still counts as not indexed." : ".") });
      flagged.push(...listSlice("unindexed", `Articles that went live in the last ${NEW_WINDOW_DAYS} days, live ${INDEX_AFTER_DAYS} or more days, that Google has not indexed (${unindexed.length} of ${due.length}):`,
        unindexed.map(url => `${path(url)} (live ${age(url)} days, ${why(url)})`), at));
    } catch (error) { fail("Search Console URL Inspection (seo-sources.py inspect)", message(error), ["new_unindexed_3d"]); }
    flagged.push(...listSlice("backlog", `Detail: older articles (live over ${NEW_WINDOW_DAYS} days) no inspection has seen indexed (${backlog.length}), the crawl demand fix job's work, not re-inspected here:`, backlog.map(path), at));
  }

  try {
    const lines = (await deps.readProgram("ledger.jsonl")).split("\n").filter(line => line.trim());
    const entries: LedgerEntry[] = [];
    let bad = 0;
    for (const line of lines) { try { entries.push(JSON.parse(line) as LedgerEntry); } catch { bad++; } }
    const stats = ledgerStats(entries, today);
    const winPct = stats.scored ? Math.round(stats.wins / stats.scored * 100) : 0;
    flagged.push({ at, kind: "ledger", excerpt: `Detail: ledger.jsonl has ${entries.length} checks, ${stats.overdue.length} overdue (ledger_overdue), ${stats.scored} scored in the last ${WIN_WINDOW_DAYS} days, ${stats.wins} won (ledger_win_pct ${winPct}%).` +
      (bad ? ` ${bad} lines are not JSON and are left out.` : "") });
    for (const entry of stats.overdue) flagged.push({ at, kind: "ledger_overdue", excerpt: `${entry.worker ?? "?"}: ${entry.url ?? "?"} was due ${entry.check_date} and has no result` });
  } catch (error) { flagged.push({ at, kind: "detail_error", excerpt: `ledger.jsonl could not be read (${message(error)}), so the ledger detail line is missing` }); }

  return { output: { metrics, flagged, ...(metrics.new_unindexed_3d! > 0 ? { lastEventAt: { new_unindexed_3d: at } } : {}) }, state };
}

/** URL Inspection through auto-sns-agent's SEO CLI project: the URLs go on stdin, one JSON object comes back. */
export function inspectUrls(repo: string, urls: string[]): Promise<InspectRead> {
  return new Promise((resolve, reject) => {
    const child = execFile("uv", ["run", "--project", "scripts/seo", "--frozen", "python", SOURCES_PY, "inspect"], { cwd: repo, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`${error.message} ${stderr.trim()}`.trim())); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as InspectRead); } catch (parseError) { reject(parseError); }
      });
    child.stdin?.end(urls.join("\n") + "\n");
  });
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("seo-new-articles: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as ArticlesState, () => undefined) : undefined;
  const result = await measureArticles({
    fetch, now: Date.now, inspect: urls => inspectUrls(REPO, urls),
    readProgram: file => readFile(join(PROGRAM, file), "utf8"), listMetrics: () => readdir(join(PROGRAM, "metrics")),
  }, previous?.articles ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
