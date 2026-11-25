// d3 (api.virev.ai search): / and /docs read PASS in metrics/2026-10-02.json and "Crawled - currently not indexed" on 11-26, so an indexed
// verdict older than 7 days is asked again and a page Google dropped counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureApiSite, type ApiRead, type ApiSiteState } from "../scripts/duties/seo-api-site.ts";
import type { InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-11-26T01:00:00Z");
const [HOME, DOCS, POST] = ["https://api.virev.ai/", "https://api.virev.ai/docs", "https://api.virev.ai/blog/tiktok-analytics-api"] as [string, string, string];
const sitemap = `<urlset><url><loc>${HOME}</loc></url><url><loc>${DOCS}</loc></url><url><loc>${POST}</loc><lastmod>2026-11-20</lastmod></url></urlset>`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap
  : `<meta property="article:published_time" content="2026-11-20">`, { status: 200 })) as typeof fetch;
const apiRead: ApiRead = {
  visits_per_day: { d7: 2.4, d28: 3 }, visits_target_per_day: 500, signups: { d7: 0, d28: 3, per_30_days: 3.2 }, signups_target_per_month: 30,
  gsc: { start: "2026-10-27", end: "2026-11-23", clicks_per_day: 0, impressions_per_day: 0, top_queries: [] },
};
const previous: ApiSiteState = {
  pages: { [HOME]: { firstSeen: "2026-10-01", status: 200 }, [DOCS]: { firstSeen: "2026-10-01", status: 200 }, [POST]: { firstSeen: "2026-11-20", status: 200, published: "2026-11-20" } },
  indexed: { [HOME]: "2026-10-02", [DOCS]: "2026-11-25" }, inspected: {},
};

test("an indexed verdict older than 7 days is asked again, a newer one is kept, and a URL under 7 days live is not counted", async () => {
  const asked: string[][] = [];
  const inspect = async (urls: string[]): Promise<InspectRead> => {
    asked.push(urls);
    return { rows: urls.map(url => ({ url, http: 200, verdict: "NEUTRAL", coverage_state: "Crawled - currently not indexed" })), not_asked: [] };
  };
  const { output, state } = await measureApiSite({
    fetch: fakeFetch, now: () => NOW, inspect, readApi: async () => apiRead, listMetrics: async () => [],
    readProgram: async () => { throw new Error("absent"); }, readSerpChecks: async () => "",
  }, previous);
  assert.deepEqual(asked, [[HOME]]);
  assert.equal(output.metrics.api_unindexed_7d, 1);
  assert.equal(output.metrics.days_since_new_api_article, 6);
  assert.equal(output.metrics.api_visits_day, 2.4);
  assert.equal(output.metrics.source_errors, 0);
  assert.equal(state.inspected[HOME]!.coverage_state, "Crawled - currently not indexed");
});
