// Guards the 10-18 04:46Z New articles get indexed run: new_unindexed_3d read 128, and 115 of those URLs were /blog/page/N and /blog/tag/ listings
// and about 9 were category hubs such as /blog/tiktok, because every sitemap URL with a <lastmod> counted as an article.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-18T04:46:00Z");
const ARTICLE = "https://virev.ai/ko/blog/instagram-follower-growth-rate";
const LISTINGS = ["https://virev.ai/blog/page/7", "https://virev.ai/blog/tag/korea", "https://virev.ai/blog/tiktok"];
const sitemap = `<urlset>${[ARTICLE, ...LISTINGS].map(url => `<url><loc>${url}</loc><lastmod>2026-10-13</lastmod></url>`).join("")}</urlset>`;
const pages: Record<string, string> = {
  [ARTICLE]: `<meta property="og:type" content="article"><meta property="article:published_time" content="2026-10-13T00:00:00Z">`,
  ...Object.fromEntries(LISTINGS.map(url => [url, `<meta property="og:type" content="website"><script type="application/ld+json">{"@type":"CollectionPage"}</script>`])),
};
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  return new Response(url.endsWith("sitemap.xml") ? sitemap : pages[url] ?? "", { status: url.endsWith("sitemap.xml") || url in pages ? 200 : 404 });
}) as typeof fetch;

test("new_unindexed_3d and days_since_new_article count articles only, and a state row from before the kind field is read again", async () => {
  const asked: string[][] = [];
  const inspect = async (urls: string[]): Promise<InspectRead> => {
    asked.push(urls);
    return { rows: urls.map(url => ({ url, http: 200, verdict: "NEUTRAL", coverage_state: "Discovered - currently not indexed" })), not_asked: [] };
  };
  const previous: ArticlesState = { indexed: {}, articles: Object.fromEntries([ARTICLE, ...LISTINGS].map(url => [url, { published: "2026-10-13", firstSeen: "2026-10-13", status: 200 }])) };
  const { output, state } = await measureArticles({
    fetch: fakeFetch, inspect, now: () => NOW,
    readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
  }, previous);
  assert.deepEqual(asked, [[ARTICLE]]);
  assert.equal(output.metrics.new_unindexed_3d, 1);
  assert.equal(output.metrics.days_since_new_article, 5);
  assert.equal(output.metrics.source_errors, 0);
  assert.equal(state.articles[ARTICLE]!.kind, "article");
  for (const url of LISTINGS) assert.equal(state.articles[url]!.kind, "listing");
  assert.match((output.flagged ?? []).find(row => row.kind === "listings")!.excerpt, /^Detail: 3 sitemap URLs are listing pages/);
});
