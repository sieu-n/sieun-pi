// Guards the 10-18 05:21Z New articles get indexed run: URL Inspection answered "Internal error encountered." for /ko/blog/kol-key-opinion-leader,
// so new_unindexed_3d read 5 and source_errors 1, and the same URL inspected minutes later was PASS, Submitted and indexed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-18T05:21:38Z");
const KOL = "https://virev.ai/ko/blog/kol-key-opinion-leader";
const VIRAL = "https://virev.ai/blog/how-many-views-is-viral";
const sitemap = `<urlset>${[KOL, VIRAL].map(url => `<url><loc>${url}</loc><lastmod>2026-10-14</lastmod></url>`).join("")}</urlset>`;
const article = `<meta property="article:published_time" content="2026-10-14T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) =>
  new Response(String(input).endsWith("sitemap.xml") ? sitemap : article, { status: 200 })) as typeof fetch;

test("an inspection that failed is asked once more before it counts as unindexed or as a source error", async () => {
  const asked: string[][] = [];
  const inspect = async (urls: string[]): Promise<InspectRead> => {
    asked.push(urls);
    return { not_asked: [], rows: urls.map(url => url === KOL && asked.length === 1
      ? { url, http: 500, verdict: null, coverage_state: null, error: "Internal error encountered." }
      : { url, http: 200, verdict: url === KOL ? "PASS" : "NEUTRAL", coverage_state: url === KOL ? "Submitted and indexed" : "Crawled - currently not indexed" }) };
  };
  const previous: ArticlesState = { indexed: {}, articles: Object.fromEntries([KOL, VIRAL].map(url => [url, { published: "2026-10-14", firstSeen: "2026-10-14", status: 200, kind: "article" as const }])) };
  const { output, state } = await measureArticles({
    fetch: fakeFetch, inspect, now: () => NOW,
    readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
  }, previous);
  assert.deepEqual(asked, [[KOL, VIRAL], [KOL]]);
  assert.equal(output.metrics.new_unindexed_3d, 1);
  assert.equal(output.metrics.source_errors, 0);
  assert.equal(state.indexed[KOL], "2026-10-18");
});
