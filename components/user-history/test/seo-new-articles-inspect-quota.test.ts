// Guards the 10-25 and 10-26 d2 runs. On 10-25 Vent logged 13 d2 runs that asked URL Inspection about all 144 to 146 counted articles each,
// and from 19:01Z Google answered 429 "Quota exceeded for sc-domain:virev.ai." (source_errors 1). At 2026-10-26 00:08Z it still answered 429
// to all 32 calls d2 made, and new_unindexed_3d read 146 of 146 with every article a quota error. Each article now costs at most one call in
// any 24 h, and a quota refusal keeps the article's last verdict as stale instead of failing the source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, REASK_AFTER_MS, type ArticlesState, type InspectRead, type InspectRow } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-25T19:01:00Z");
const ARTICLES = ["https://virev.ai/blog/instagram-collab-posts", "https://virev.ai/blog/health-influencers"];
const [ARTICLE] = ARTICLES as [string];
const sitemap = `<urlset>${ARTICLES.map(url => `<url><loc>${url}</loc><lastmod>2026-10-15</lastmod></url>`).join("")}</urlset>`;
const page = `<meta property="article:published_time" content="2026-10-15T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap : page, { status: 200 })) as typeof fetch;
const first: ArticlesState = { indexed: {}, articles: Object.fromEntries(ARTICLES.map(url => [url, { published: "2026-10-15", firstSeen: "2026-10-15", status: 200, kind: "article" as const }])) };
const answer = (verdict: string) => (url: string): InspectRow => ({ url, http: 200, verdict, coverage_state: verdict === "PASS" ? "Submitted and indexed" : "Discovered - currently not indexed" });
const neutral = async (urls: string[]): Promise<InspectRead> => ({ rows: urls.map(answer("NEUTRAL")), not_asked: [] });
const quota = (url: string): InspectRow => ({ url, http: 429, verdict: null, coverage_state: null, error: "Quota exceeded for sc-domain:virev.ai." });
const refuse = async (urls: string[]): Promise<InspectRead> => ({ rows: urls.map((url, i) => i ? { url, http: 0, error: "not asked: URL Inspection failed earlier in this run" } : quota(url)), not_asked: [] });

function run(previous: ArticlesState, now: number, inspect: (urls: string[]) => Promise<InspectRead>, metricsFiles: Record<string, unknown> = {}) {
  const asked: string[][] = [];
  return measureArticles({
    fetch: fakeFetch, now: () => now, inspect: urls => { asked.push(urls); return inspect(urls); },
    readProgram: async file => { const name = file.replace("metrics/", ""); if (name in metricsFiles) return JSON.stringify(metricsFiles[name]); throw new Error("absent"); },
    listMetrics: async () => Object.keys(metricsFiles),
  }, previous).then(out => ({ ...out, asked }));
}
const excerpt = (output: { flagged?: { kind: string; excerpt: string }[] }, kind: string): string => output.flagged!.find(slice => slice.kind === kind)!.excerpt;

test("a run within 24 h of an article's last verdict keeps it and asks nothing, across a UTC midnight", async () => {
  const one = await run(first, NOW, neutral);
  assert.deepEqual(one.asked, [ARTICLES]);
  const two = await run(one.state, Date.parse("2026-10-26T00:08:00Z"), async () => { throw new Error("asked again"); });
  assert.deepEqual(two.asked, []);
  assert.equal(two.output.metrics.source_errors, 0);
  assert.equal(two.output.metrics.new_unindexed_3d, 2);
  assert.match(excerpt(two.output, "inspect_calls"), /asked 0 of 2 articles; 2 kept a verdict under 24 h old\./);
});

test("24 h after the last verdict the article is asked again", async () => {
  const one = await run(first, NOW, neutral);
  const two = await run(one.state, NOW + REASK_AFTER_MS, neutral);
  assert.deepEqual(two.asked, [ARTICLES]);
});

test("a 429 keeps the last verdict as stale, fails no source, and the next run asks one article before the rest", async () => {
  const one = await run(first, NOW, neutral);
  const later = NOW + REASK_AFTER_MS;
  const two = await run(one.state, later, refuse);
  assert.equal(two.output.metrics.source_errors, 0);
  assert.equal(two.output.metrics.new_unindexed_3d, 2);
  assert.match(excerpt(two.output, "unindexed"), /Discovered - currently not indexed as of 2026-10-25T19:01Z, stale: quota spent/);
  assert.match(excerpt(two.output, "inspect_calls"), /2 kept their last verdict as stale because Google answered 429/);
  assert.equal(two.state.refusedAt, later);
  const three = await run(two.state, later + 3_600_000, refuse);
  assert.deepEqual(three.asked, [[ARTICLE]]);
  assert.equal(three.output.metrics.source_errors, 0);
  const four = await run(three.state, later + 7_200_000, async urls => ({ rows: urls.map(answer("PASS")), not_asked: [] }));
  assert.deepEqual(four.asked, [[ARTICLE], ARTICLES.slice(1)]);
  assert.equal(four.output.metrics.new_unindexed_3d, 0);
  assert.equal(four.state.refusedAt, undefined);
});

test("an article never inspected and refused for quota still counts as not indexed, without a source error", async () => {
  const { output } = await run(first, NOW, refuse);
  assert.equal(output.metrics.source_errors, 0);
  assert.equal(output.metrics.new_unindexed_3d, 2);
  assert.match(excerpt(output, "unindexed"), /never inspected, stale: quota spent/);
});

test("articles the inspect-quota.json counter leaves unasked are stale, not failed", async () => {
  const { output } = await run(first, NOW, async urls => ({ rows: [], not_asked: urls, quota_left_before: -106 }));
  assert.equal(output.metrics.source_errors, 0);
  assert.match(excerpt(output, "inspect_calls"), /because metrics\/inspect-quota.json had 0 calls left/);
});

test("a 500 is still a source error", async () => {
  const { output } = await run(first, NOW, async urls => ({ rows: urls.map(url => ({ url, http: 500, error: "Internal error encountered." })), not_asked: [] }));
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.metrics.new_unindexed_3d, 2);
});

test("a verdict another caller wrote to metrics/YYYY-MM-DD.json today is reused, and a PASS there is never asked again", async () => {
  const files = { "2026-10-26.json": { inspect: { rows: [answer("NEUTRAL")(ARTICLE), answer("PASS")(ARTICLES[1]!)] } } };
  const { output, asked } = await run(first, Date.parse("2026-10-26T00:08:00Z"), async () => { throw new Error("asked"); }, files);
  assert.deepEqual(asked, []);
  assert.equal(output.metrics.new_unindexed_3d, 1);
});
