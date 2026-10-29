// 10-29 06:20 KST: duty d6 Crawler API and MCP carried 5 metrics against the shape of one headline and at most 3 more (c75, c133).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HEADLINE, report, type CallResult } from "../scripts/duties/crawler-api-mcp.ts";

const ok = (name: string): CallResult => ({ name, ok: true, ms: 500, note: "" });
const mcp = { standard: [ok("describe"), ok("sql")], full: [ok("describe"), ok("sql")] };
const api = (posts: number, flagged: { kind: string; at: number; excerpt: string }[] = []) => ({
  metrics: { prod_routes_failing_crawler: 0, api_down_minutes_24h: 6, health_snapshot_down_minutes_24h: 292, ig_posts_searchable: posts, onboarding_renders_3x_under_60s: 3 },
  flagged,
});

test("the duty reads one headline and 3 supporting metrics, and the posts count is a detail line", () => {
  const out = report(api(2_928_155_538), mcp, 1);
  assert.deepEqual(out.metrics, { [HEADLINE]: 0, api_down_minutes_24h: 6, health_snapshot_down_minutes_24h: 292, onboarding_renders_3x_under_60s: 3 });
  assert.ok((out.flagged ?? []).some(f => f.kind === "detail" && f.excerpt.includes("2,928,155,538")));
});

test("a low posts count from crawler-api.mjs shows as a detail line, never as a metric miss", () => {
  const out = report(api(0, [{ kind: "ig_posts_searchable", at: 1, excerpt: "Prod search finds 0 Instagram posts" }]), mcp, 1);
  assert.equal((out.flagged ?? []).filter(f => f.kind === "ig_posts_searchable").length, 0);
  assert.ok((out.flagged ?? []).some(f => f.kind === "detail" && f.excerpt.startsWith("Prod search finds 0")));
});
