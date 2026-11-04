// 10-29 06:20 KST, and again 11-03 with the p1168 metric: duty d6 Crawler API and MCP carried 5 metrics against the shape of one headline and at most 3 more (c75, c133).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HEADLINE, MCP_URLS, mintToken, report, type CallResult } from "../scripts/duties/crawler-api-mcp.ts";

const ok = (name: string): CallResult => ({ name, ok: true, ms: 500, note: "" });
const mcp = { standard: [ok("describe"), ok("sql")], full: [ok("describe"), ok("sql")] };
const api = (posts: number, flagged: { kind: string; at: number; excerpt: string }[] = []) => ({
  metrics: { prod_routes_failing_crawler: 0, api_down_minutes_24h: 6, health_snapshot_down_minutes_24h: 292, ig_posts_searchable: posts, onboarding_renders_3x_under_60s: 3, ig_few_post_stats_pct: 96.2 },
  flagged,
});

test("the duty reads one headline and 3 supporting metrics, and the posts and render counts are detail lines", () => {
  const out = report(api(2_928_155_538), mcp, 1);
  assert.deepEqual(out.metrics, { [HEADLINE]: 0, api_down_minutes_24h: 6, health_snapshot_down_minutes_24h: 292, ig_few_post_stats_pct: 96.2 });
  assert.ok((out.flagged ?? []).some(f => f.kind === "detail" && f.excerpt.includes("2,928,155,538")));
  assert.ok((out.flagged ?? []).some(f => f.kind === "detail" && f.excerpt.includes("3 of 3")));
});

test("a low posts count from crawler-api.mjs shows as a detail line, never as a metric miss", () => {
  const out = report(api(0, [{ kind: "ig_posts_searchable", at: 1, excerpt: "Prod search finds 0 Instagram posts" }]), mcp, 1);
  assert.equal((out.flagged ?? []).filter(f => f.kind === "ig_posts_searchable").length, 0);
  assert.ok((out.flagged ?? []).some(f => f.kind === "detail" && f.excerpt.startsWith("Prod search finds 0")));
});

test("the full org's token names the /mcp/insight endpoint, since the search app picks the tier from it (11-04, p1071)", () => {
  const claims = (tier: "standard" | "full") => JSON.parse(Buffer.from(mintToken("s", tier, 1).split(".")[1] ?? "", "base64url").toString());
  assert.equal(claims("full").aud, "https://virev.ai/mcp/insight");
  assert.equal(claims("full").resource, MCP_URLS.full);
  assert.equal(claims("standard").aud, "https://virev.ai/mcp");
});
