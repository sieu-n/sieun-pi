// Guards the 11-17 New articles get indexed run: new_unindexed_3d read 0 while /blog/how-long-facebook-ads-run and its ko and ja editions were
// out of Google, because the study had moved from /blog/how-long-do-facebook-ads-run on 11-16 and each new URL counted as live since 11-16.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-11-17T01:20:00Z");
const OLD = "https://virev.ai/blog/how-long-do-facebook-ads-run";
const MOVED = "https://virev.ai/blog/how-long-facebook-ads-run";
const NEW = "https://virev.ai/blog/real-estate-influencers";
const article = (day: string): string => `<meta property="article:published_time" content="${day}T00:00:00Z">`;
const sitemap = `<urlset>${[MOVED, NEW].map(url => `<url><loc>${url}</loc><lastmod>2026-11-16</lastmod></url>`).join("")}</urlset>`;
const pages: Record<string, string> = { [MOVED]: article("2026-11-08"), [NEW]: article("2026-11-16") };
const fakeFetch = (async (input: string | URL | Request) => {
  const asked = String(input), url = asked === OLD ? MOVED : asked;
  const response = new Response(url.endsWith("sitemap.xml") ? sitemap : pages[url] ?? "", { status: url.endsWith("sitemap.xml") || url in pages ? 200 : 404 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}) as typeof fetch;

test("an article that moved to a new URL keeps the day its old URL went live, so it still counts as unindexed", async () => {
  const inspect = async (urls: string[]): Promise<InspectRead> => ({ rows: urls.map(url => ({ url, http: 200, verdict: "NEUTRAL", coverage_state: "URL is unknown to Google" })), not_asked: [] });
  const previous: ArticlesState = { indexed: {}, articles: { [OLD]: { published: "2026-11-08", firstSeen: "2026-11-08", status: 200, kind: "article" } } };
  const { output, state } = await measureArticles({
    fetch: fakeFetch, inspect, now: () => NOW,
    readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
  }, previous);
  assert.equal(state.articles[MOVED]!.firstSeen, "2026-11-08");
  assert.equal(state.articles[NEW]!.firstSeen, "2026-11-17");
  assert.equal(state.articles[OLD], undefined);
  assert.equal(output.metrics.new_unindexed_3d, 1);
  assert.equal(output.metrics.days_since_new_article, 0);
  const flagged = output.flagged ?? [];
  assert.equal(flagged.find(row => row.kind === "moved_articles")!.excerpt, "Articles that moved to a new URL and keep their first live day (1): /blog/how-long-do-facebook-ads-run to /blog/how-long-facebook-ads-run (live since 2026-11-08)");
  assert.equal(flagged.find(row => row.kind === "new_articles")!.excerpt, "New in the sitemap since the last run (1): /blog/real-estate-influencers");
});
