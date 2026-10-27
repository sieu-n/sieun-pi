// Guards the 10-28 02:41 KST d2 run. The 10-27 03:31Z Search Console window requested 7 counted articles, d2 kept their 01:20Z verdicts for
// 24 h and counted 137, and at 18:45Z 6 of the 7 read "Submitted and indexed". An article with an accepted request is asked at every run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, REQUESTS_LOG, requestedUrls, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const VERDICT_AT = Date.parse("2026-10-27T01:20:00Z");
const NOW = Date.parse("2026-10-27T17:41:00Z");
const [REQUESTED, OTHER] = ["https://virev.ai/blog/health-influencers", "https://virev.ai/blog/beauty-influencers-in-uae"] as [string, string];
const sitemap = `<urlset>${[REQUESTED, OTHER].map(url => `<url><loc>${url}</loc><lastmod>2026-10-19</lastmod></url>`).join("")}</urlset>`;
const page = `<meta property="article:published_time" content="2026-10-19T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap : page, { status: 200 })) as typeof fetch;
const previous: ArticlesState = {
  indexed: {},
  articles: Object.fromEntries([REQUESTED, OTHER].map(url => [url, { published: "2026-10-19", firstSeen: "2026-10-19", status: 200, kind: "article" as const }])),
  inspected: Object.fromEntries([REQUESTED, OTHER].map(url => [url, { at: VERDICT_AT, verdict: "NEUTRAL", coverage_state: "Discovered - currently not indexed" }])),
};
const log = [
  { url: REQUESTED, time: "2026-10-27T03:33:33Z", result: "Indexing requested" },
  { url: OTHER, time: "2026-10-27T03:39:09Z", result: "Quota Exceeded" },
].map(row => JSON.stringify(row)).join("\n") + "\nnot json\n";

async function run(requests: string | undefined) {
  const asked: string[][] = [];
  const pass = async (urls: string[]): Promise<InspectRead> => { asked.push(urls); return { rows: urls.map(url => ({ url, http: 200, verdict: "PASS", coverage_state: "Submitted and indexed" })), not_asked: [] }; };
  const out = await measureArticles({
    fetch: fakeFetch, now: () => NOW, inspect: pass, listMetrics: async () => [],
    readProgram: async file => { if (file === REQUESTS_LOG && requests !== undefined) return requests; throw new Error("absent"); },
  }, previous);
  return { ...out, asked };
}

test("requestedUrls keeps only accepted requests and skips lines that are not JSON", () => {
  assert.deepEqual([...requestedUrls(log)], [REQUESTED]);
});

test("an article requested after its last verdict is asked again before 24 h, and one with no accepted request keeps its verdict", async () => {
  const { output, asked, state } = await run(log);
  assert.deepEqual(asked, [[REQUESTED]]);
  assert.equal(output.metrics.new_unindexed_3d, 1);
  assert.equal(state.indexed[REQUESTED], "2026-10-28");
  assert.match(output.flagged!.find(slice => slice.kind === "inspect_calls")!.excerpt, /asked 1 of 2 articles; 1 kept a verdict under 24 h old, and 1 with a Request indexing were asked again before 24 h/);
});

test("with no request log every verdict under 24 h old is kept", async () => {
  const { output, asked } = await run(undefined);
  assert.deepEqual(asked, []);
  assert.equal(output.metrics.new_unindexed_3d, 2);
});
