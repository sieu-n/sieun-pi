import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type DutySchedule, headlineMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type ArticlesDeps, type ArticlesState, daysBetween, indexedFromMetrics, indexNowPending, type InspectRead, ledgerStats, measureArticles, listSlice,
  parseSitemap, publishedDay, seoulDay, SITEMAP, UNMEASURED } from "../scripts/duties/seo-new-articles.ts";
import { type TrafficRead, visitsOutput, type VisitsRead } from "../scripts/duties/seo-search-visits.ts";

const NOW = Date.parse("2026-10-12T01:20:00Z");
/** The duty files leave out schedule (c66), so add.ts keeps the live schedule; parseDutyInput takes it from the caller. */
const SCHEDULE: DutySchedule = { kind: "daily", at: "09:00" };
const dutyFile = async (slug: string): Promise<unknown> => JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", `${slug}.duty.json`), "utf8"));

const READ: VisitsRead = {
  traffic: {
    windows: {
      d7: { start: "2026-10-05", end: "2026-10-11", per_day: { goal: 247 }, goal_by_source_per_day: { social: 136.4, direct: 94, google: 5.7, paid: 0 } },
      d28: { start: "2026-09-14", end: "2026-10-11", per_day: { goal: 61.8 }, goal_by_source_per_day: {} },
    },
    last_day: { date: "2026-10-11", blog: 36, tools: 1, landing: 16, app: 0, bot: 171, internal: 0, goal: 37 }, sessions_read: 3247,
    top_goal_entries_d28: [{ path: "/blog/will-ai-kill-us-all", visits: 1495 }],
  },
  gsc: { today: "2026-10-12", last_final: "2026-10-10", d7: { start: "2026-10-04", end: "2026-10-10", clicks: 57, impressions: 5317, position: 10.26 } },
  signups: { clerk_users: 223, d28: 33, attribution: "ok", matched: 32, by_section: { landing: 22, tools: 1, blog: 4, app: 4 } },
};

test("search visits: the 10-12 reads give the owner's goal metrics, and every metric of the duty file has a value", async () => {
  const output = visitsOutput(READ, NOW);
  assert.deepEqual(output.metrics, { goal_visits_d7: 247, google_clicks_d7: 8.1, signups_goal_d28: 0.18, source_errors: 0 });
  const duty = parseDutyInput(await dutyFile("seo-search-visits"), "d1", NOW, SCHEDULE);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
  assert.deepEqual(headlineMetric(duty.metrics)?.key, "goal_visits_d7");
  assert.ok(duty.metrics.length <= 4, "one headline plus at most 3 supporting metrics (c75)");
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "missed");
  assert.ok(verdict.summary.startsWith("goal_visits_d7 247"));
  assert.ok(output.flagged?.some(item => item.kind === "visits" && item.excerpt.includes("social 136.4") && item.excerpt.includes("61.8 over 2026-09-14..2026-10-11")));
});

test("search visits: a failed, stale or silent source is a source error with the miss value, never a good number", () => {
  const output = visitsOutput({
    traffic: { ...READ.traffic as TrafficRead, last_day: { date: "2026-10-11", blog: 0, tools: 0, landing: 0, app: 0, bot: 0, internal: 0 } },
    gsc: { today: "2026-10-12", last_final: "2026-10-05", d7: { start: "x", end: "y", clicks: 900, impressions: 1, position: 1 } },
    signups: { clerk_users: 223, d28: 33, attribution: "error", attribution_error: "403" },
  }, NOW);
  assert.equal(output.metrics.source_errors, 3);
  assert.equal(output.metrics.google_clicks_d7, -UNMEASURED);
  assert.equal(output.metrics.goal_visits_d7, -UNMEASURED);
  assert.equal(output.metrics.signups_goal_d28, -UNMEASURED);
  assert.equal(visitsOutput({ gsc: { error: "GscError: no key" } }, NOW).metrics.source_errors, 3);
});

const xml = (items: [string, string][]): string => `<urlset>${items.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}</urlset>`;

function deps(options: { sitemap: [string, string][]; pages?: Record<string, { status: number; published?: string }>; verdicts?: Record<string, string>; ledger?: string;
  sent?: Record<string, { lastmod: string }>; metrics?: Record<string, unknown>; now?: number }): ArticlesDeps & { inspected: string[][]; fetched: string[] } {
  const inspected: string[][] = [];
  const fetched: string[] = [];
  const fetcher = (async (url: string) => {
    if (url === SITEMAP) return new Response(xml(options.sitemap), { status: 200 });
    fetched.push(url);
    const page = options.pages?.[url] ?? { status: 200, published: "2026-10-01" };
    return new Response(page.published ? `<meta property="article:published_time" content="${page.published}"/>` : "", { status: page.status });
  }) as unknown as typeof fetch;
  const files: Record<string, string> = {
    "ledger.jsonl": options.ledger ?? "",
    "metrics/indexnow-sent.json": JSON.stringify(options.sent ?? {}),
    ...Object.fromEntries(Object.entries(options.metrics ?? {}).map(([name, data]) => [`metrics/${name}`, JSON.stringify(data)])),
  };
  return {
    fetch: fetcher, now: () => options.now ?? NOW, inspected, fetched,
    readProgram: async file => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file]!; },
    listMetrics: async () => Object.keys(options.metrics ?? {}),
    inspect: async (urls): Promise<InspectRead> => { inspected.push(urls); return { rows: urls.map(url => ({ url, http: 200, verdict: options.verdicts?.[url] ?? "NEUTRAL", coverage_state: "Discovered - currently not indexed" })), not_asked: [] }; },
  };
}

const B = "https://virev.ai/blog/";
test("new articles: first run dates articles by their published day, inspects only unindexed ones live 3 or more days, and reads the ledger", async () => {
  const run = deps({
    sitemap: [[`${B.slice(0, -1)}`, ""], [`${B}a`, "2026-10-10"], [`${B}b`, "2026-10-08"], [`${B}c`, "2026-10-05"], [`${B}old`, "2026-09-01"]],
    pages: { [`${B}a`]: { status: 200, published: "2026-10-10" }, [`${B}b`]: { status: 200, published: "2026-10-08" }, [`${B}c`]: { status: 200, published: "2026-10-05" }, [`${B}old`]: { status: 200, published: "2026-09-01" } },
    sent: { [`${B}a`]: { lastmod: "2026-10-10" }, [`${B}b`]: { lastmod: "2026-10-01" } },
    metrics: { "2026-10-09.json": { inspect: { rows: [{ url: `${B}c`, verdict: "PASS" }] } } },
    ledger: [{ worker: "w1", url: `${B}a`, check_date: "2026-10-11" }, { check_date: "2026-10-30" }, { result: "win", result_date: "2026-10-10" }, { result: "loss", result_date: "2026-10-09" }].map(entry => JSON.stringify(entry)).join("\n"),
  });
  const { output, state } = await measureArticles(run, undefined);
  assert.equal(run.fetched.length, 4, "only the articles, the ones with a lastmod, are fetched");
  assert.deepEqual(run.inspected, [[`${B}b`]], "a is under 3 days, c was indexed before, old went live over 14 days ago");
  assert.deepEqual(output.metrics, { days_since_new_article: 2, new_unindexed_3d: 1, source_errors: 0 });
  const detail = (kind: string): string => output.flagged?.find(item => item.kind === kind)?.excerpt ?? "";
  assert.match(detail("backlog"), /\(1\)[^]*\/blog\/old/);
  assert.match(detail("indexnow_unsent"), /\(4\)/);
  assert.match(detail("ledger"), /1 overdue \(ledger_overdue\), 2 scored in the last 30 days, 1 won \(ledger_win_pct 50%\)/);
  assert.match(detail("unindexed"), /\/blog\/b \(live 4 days, Discovered - currently not indexed\)/);
  assert.equal(state.articles[`${B}a`]?.firstSeen, "2026-10-10");
  assert.equal(state.indexed[`${B}c`], "2026-10-09");
  const duty = parseDutyInput(await dutyFile("seo-new-articles"), "d2", NOW, SCHEDULE);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
  assert.equal(headlineMetric(duty.metrics)?.key, "days_since_new_article");
  assert.ok(duty.metrics.length <= 4, "one headline plus at most 3 supporting metrics (c75)");
  assert.ok(judge(duty.metrics, output).summary.startsWith("days_since_new_article 2 days (target at most 1 days)"));
});

test("new articles: a later run dates a new URL by the day it first appears, skips pages that answered 200, and keeps indexed URLs", async () => {
  const previous: ArticlesState = { articles: { [`${B}a`]: { published: "2026-10-01", firstSeen: "2026-10-01", status: 200 } }, indexed: { [`${B}a`]: "2026-10-05" } };
  const run = deps({ sitemap: [[`${B}a`, "2026-10-01"], [`${B}new`, "2026-10-09"], [`${B}gone`, "2026-10-09"]], pages: { [`${B}gone`]: { status: 404 } } });
  const { output, state } = await measureArticles(run, previous);
  assert.deepEqual(run.fetched.sort(), [`${B}gone`, `${B}new`]);
  assert.equal(state.articles[`${B}new`]?.firstSeen, "2026-10-12", "dated by first sight, not by its 10-09 published day");
  assert.equal(output.metrics.days_since_new_article, 0);
  assert.deepEqual(run.inspected, [], "a is indexed, new is under 3 days");
  assert.ok(output.flagged?.some(item => item.kind === "not_200" && item.excerpt.includes("/blog/gone (404)")));
  assert.ok(output.flagged?.some(item => item.kind === "new_articles" && item.excerpt.includes("/blog/new")));
});

test("new articles: a sitemap or inspection failure is a source error with the miss value", async () => {
  const run = deps({ sitemap: [] });
  const { output } = await measureArticles(run, undefined);
  assert.equal(output.metrics.days_since_new_article, UNMEASURED);
  assert.equal(output.metrics.new_unindexed_3d, UNMEASURED);
  assert.equal(output.metrics.source_errors, 1);

  const failing = deps({ sitemap: [[`${B}x`, "2026-10-01"]] });
  failing.inspect = async () => { throw new Error("GscError: quota used up"); };
  const second = await measureArticles(failing, undefined);
  assert.equal(second.output.metrics.new_unindexed_3d, UNMEASURED);
  assert.equal(second.output.metrics.source_errors, 1);

  const quota = deps({ sitemap: [[`${B}y`, "2026-10-05"]] });
  quota.inspect = async urls => ({ rows: [], not_asked: urls });
  const third = await measureArticles(quota, undefined);
  assert.equal(third.output.metrics.new_unindexed_3d, 1, "a new article the quota left out counts as not indexed");
  assert.equal(third.output.metrics.source_errors, 1);
  assert.equal(third.output.metrics.days_since_new_article, 11, "dated by the page's 10-01 published day on a first run");
});

test("new articles: pure helpers", () => {
  assert.deepEqual([...parseSitemap("<url><loc>https://virev.ai/blog/a&amp;b</loc><lastmod>2026-10-10</lastmod></url><url><loc>https://virev.ai/blog</loc></url>")],
    [["https://virev.ai/blog/a&b", "2026-10-10"], ["https://virev.ai/blog", ""]]);
  assert.deepEqual(indexNowPending(new Map([["u1", "1"], ["u2", "2"], ["u3", ""]]), { u1: { lastmod: "1" }, u2: { lastmod: "1" } }), ["u2", "u3"]);
  assert.equal(publishedDay('<script>{"datePublished":"2026-10-12T00:00:00Z"}</script>'), "2026-10-12");
  assert.equal(seoulDay(Date.parse("2026-10-11T15:30:00Z")), "2026-10-12");
  assert.equal(daysBetween("2026-10-09", "2026-10-12"), 3);
  assert.deepEqual(indexedFromMetrics(new Map([["2026-10-02.json", { gsc: {}, panel: { rows: [{ url: "u", verdict: "PASS" }, { url: "v", verdict: "FAIL" }] } }]])), { u: "2026-10-02" });
  assert.deepEqual(ledgerStats([{ check_date: "2026-10-11" }, { check_date: "2026-10-12" }, { result: "win", result_date: "2026-08-01" }], "2026-10-12").overdue.length, 1);
  const slices = listSlice("k", "Head:", Array.from({ length: 400 }, (_, index) => `/blog/item-${index}`), NOW);
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.excerpt.match(/item-\d+/g)?.length, 400, "every item is kept");
  assert.deepEqual(listSlice("k", "Head:", [], NOW), []);
});
