// Owner 10-19 'Output tokens/sec is not counting properly': the sidebar meter now reads LGTM, and fails here if it stops counting output tokens.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { grafanaPrometheus, Usage } from "../src/usage/lgtm.ts";

const config = join(mkdtempSync(join(tmpdir(), "usage-lgtm-")), "grafana-alerts.json");
writeFileSync(config, JSON.stringify({ url: "https://obs.example", token: "viewer" }));
const now = Date.parse("2026-10-19T14:00:00Z");

/** A Prometheus behind Grafana that answers every per-kind instant query with `perKind` and every range query with one output point. */
function stub(perKind: Record<string, string>, status = 200) {
  const asked: URL[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer viewer");
    if (status !== 200) return new Response("bad gateway", { status });
    const query = url.searchParams.get("query") ?? "";
    const vector = query.includes("by (kind)") ? Object.entries(perKind).map(([kind, value]) => ({ metric: { kind }, value: [now / 1000, value] })) : [{ metric: {}, value: [now / 1000, "0.5"] }];
    const result = url.pathname.endsWith("/query_range") ? [{ metric: { kind: "output" }, values: [[now / 1000, "7"]] }] : vector;
    return Response.json({ status: "success", data: { resultType: url.pathname.endsWith("/query_range") ? "matrix" : "vector", result } });
  }) as typeof fetch;
  return { asked, usage: new Usage(grafanaPrometheus(config, fetcher), () => now) };
}

test("the per-second output figure is what LGTM answers for prime_agent_tokens_total kind output", async () => {
  const { asked, usage } = stub({ output: "1234.5", input: "10", cache_read: "50000", cache_write: "300" });
  const summary = await usage.summary();
  assert.equal(summary.perSecond.output, 1234.5);
  assert.equal(summary.perSecond.cacheRead, 50000);
  assert.equal(summary.perSecond.cacheWrite, 300);
  assert.equal(summary.perSecond.total, 1234.5 + 10 + 50000 + 300);
  assert.equal(summary.spark.output.at(-1), 7);
  const perSecond = asked.map(url => url.searchParams.get("query") ?? "").find(query => query.includes("rate(") && !query.includes("increase("));
  assert.equal(perSecond, 'sum by (kind) (rate(prime_agent_tokens_total{job="prime-agent"}[1m]))');
  assert.ok(asked.every(url => url.pathname.startsWith("/api/datasources/proxy/uid/estate_prometheus_stg/api/v1/")));
  assert.ok(asked.every(url => (url.searchParams.get("query") ?? "").includes('job="prime-agent"')));
});

test("a failed LGTM query reaches the feed as an error, never as zeros", async () => {
  const { usage } = stub({}, 502);
  const reading = await usage.reading();
  assert.equal(reading.state, "error");
  assert.match(reading.state === "error" ? reading.error : "", /HTTP 502/);
  assert.equal("perSecond" in reading, false);
});
