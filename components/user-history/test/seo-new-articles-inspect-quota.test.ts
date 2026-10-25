// Guards the 10-25 d2 runs: d2 ran 7 times that day and asked URL Inspection about every one of 146 articles each run, so at 19:01Z Google
// answered 429 "Quota exceeded for sc-domain:virev.ai." to 59 of them and source_errors read 1. Each article now costs at most one call per
// UTC quota day, and an article the inspect-quota.json counter leaves unasked counts as not indexed without failing the source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureArticles, quotaDay, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-25T19:01:00Z");
const ARTICLE = "https://virev.ai/blog/instagram-collab-posts";
const sitemap = `<urlset><url><loc>${ARTICLE}</loc><lastmod>2026-10-15</lastmod></url></urlset>`;
const page = `<meta property="article:published_time" content="2026-10-15T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap : page, { status: 200 })) as typeof fetch;
const first: ArticlesState = { indexed: {}, articles: { [ARTICLE]: { published: "2026-10-15", firstSeen: "2026-10-15", status: 200, kind: "article" } } };
const neutral = async (urls: string[]): Promise<InspectRead> =>
  ({ rows: urls.map(url => ({ url, http: 200, verdict: "NEUTRAL", coverage_state: "Discovered - currently not indexed" })), not_asked: [] });

function run(previous: ArticlesState, now: number, inspect: (urls: string[]) => Promise<InspectRead>) {
  const asked: string[][] = [];
  const result = measureArticles({
    fetch: fakeFetch, now: () => now, inspect: urls => { asked.push(urls); return inspect(urls); },
    readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
  }, previous);
  return result.then(out => ({ ...out, asked }));
}

test("the quota day is the UTC day, like virev_seo.gsc.quota_day", () => {
  assert.equal(quotaDay(Date.parse("2026-10-25T23:59:00Z")), "2026-10-25");
  assert.equal(quotaDay(Date.parse("2026-10-26T00:00:00Z")), "2026-10-26");
});

test("a second run on the same UTC day keeps the first run's verdict and asks no URL", async () => {
  const one = await run(first, NOW, neutral);
  assert.deepEqual(one.asked, [[ARTICLE]]);
  const two = await run(one.state, NOW + 3_600_000, async () => { throw new Error("asked again"); });
  assert.deepEqual(two.asked, []);
  assert.equal(two.output.metrics.source_errors, 0);
  assert.equal(two.output.metrics.new_unindexed_3d, 1);
  assert.match(two.output.flagged!.find(slice => slice.kind === "unindexed")!.excerpt, /Discovered - currently not indexed/);
});

test("the next UTC day asks the article again", async () => {
  const one = await run(first, NOW, neutral);
  const two = await run(one.state, Date.parse("2026-10-26T00:10:00Z"), neutral);
  assert.deepEqual(two.asked, [[ARTICLE]]);
});

test("an article the counter leaves unasked counts as not indexed with its last verdict, and no source failed", async () => {
  const one = await run(first, NOW, neutral);
  const two = await run(one.state, Date.parse("2026-10-26T00:10:00Z"), async urls => ({ rows: [], not_asked: urls, quota_left_before: 0 }));
  assert.equal(two.output.metrics.source_errors, 0);
  assert.equal(two.output.metrics.new_unindexed_3d, 1);
  assert.match(two.output.flagged!.find(slice => slice.kind === "unindexed")!.excerpt, /last asked 2026-10-25, not asked: quota spent/);
  assert.match(two.output.flagged!.find(slice => slice.kind === "inspect_calls")!.excerpt, /1 were not asked, because metrics\/inspect-quota.json had 0 calls left/);
});

test("a 429 from Google still fails the source, since the counter said calls were left", async () => {
  const { output } = await run(first, NOW, async urls => ({ rows: urls.map(url => ({ url, http: 429, error: "Quota exceeded for sc-domain:virev.ai." })), not_asked: [] }));
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.metrics.new_unindexed_3d, 1);
});

test("an article seen indexed leaves the count and is never asked again", async () => {
  const one = await run(first, NOW, async urls => ({ rows: urls.map(url => ({ url, http: 200, verdict: "PASS", coverage_state: "Submitted and indexed" })), not_asked: [] }));
  const two = await run(one.state, Date.parse("2026-10-27T01:00:00Z"), async () => { throw new Error("asked again"); });
  assert.deepEqual(two.asked, []);
  assert.equal(two.output.metrics.new_unindexed_3d, 0);
  assert.deepEqual(two.state.inspected, {});
});
