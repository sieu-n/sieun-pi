// Guards the 10-20 07:40Z d9 push: SEO guy's d2 read new_unindexed_3d 1 with no lastEventAt, so d9 read the count as a lagging window.
// The count is open: each run inspects every counted article again, so it dates this run and stays live until Google indexes the article.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, UNMEASURED, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-20T05:52:23Z");
const ARTICLE = "https://virev.ai/blog/instagram-collab-posts";
const sitemap = `<urlset><url><loc>${ARTICLE}</loc><lastmod>2026-10-15</lastmod></url></urlset>`;
const page = `<meta property="article:published_time" content="2026-10-15T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap : page, { status: 200 })) as typeof fetch;
const previous: ArticlesState = { indexed: {}, articles: { [ARTICLE]: { published: "2026-10-15", firstSeen: "2026-10-15", status: 200, kind: "article" } } };
const run = (inspect: (urls: string[]) => Promise<InspectRead>) => measureArticles({
  fetch: fakeFetch, inspect, now: () => NOW, readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
}, previous);
const verdict = (verdict: string) => async (urls: string[]): Promise<InspectRead> =>
  ({ rows: urls.map(url => ({ url, http: 200, verdict, coverage_state: verdict === "PASS" ? "Submitted and indexed" : "Discovered - currently not indexed" })), not_asked: [] });

test("an article still unindexed past 3 days dates new_unindexed_3d at this run's inspection", async () => {
  const { output } = await run(verdict("NEUTRAL"));
  assert.equal(output.metrics.new_unindexed_3d, 1);
  assert.deepEqual(output.lastEventAt, { new_unindexed_3d: NOW });
});

test("a failed inspection counts as unindexed and dates at this run too", async () => {
  const { output } = await run(async () => { throw new Error("quota"); });
  assert.equal(output.metrics.new_unindexed_3d, UNMEASURED);
  assert.deepEqual(output.lastEventAt, { new_unindexed_3d: NOW });
});

test("an indexed article leaves new_unindexed_3d at 0 with no lastEventAt", async () => {
  const { output } = await run(verdict("PASS"));
  assert.equal(output.metrics.new_unindexed_3d, 0);
  assert.equal(output.lastEventAt, undefined);
});
