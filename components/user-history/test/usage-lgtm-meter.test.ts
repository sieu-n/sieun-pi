// Owner 10-19 'Output tokens/sec is not counting properly': the sidebar meter now reads LGTM, and fails here if it stops counting output tokens.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
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
  return { asked, fetcher, usage: new Usage(grafanaPrometheus(config, fetcher), () => now) };
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

test("an unreachable LGTM names the network cause, not only fetch failed", async () => {
  const fetcher = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); }) as typeof fetch;
  const reading = await new Usage(grafanaPrometheus(config, fetcher), () => now).reading();
  assert.equal(reading.state === "error" ? reading.error : "", "LGTM unreachable: fetch failed (ECONNRESET: read ECONNRESET)");
});

test("a query on an HTTP/2 session that LGTM's proxy closed is asked again on a new one", async () => {
  const good = stub({ output: "812", input: "1", cache_read: "2", cache_write: "3" });
  let calls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("New streams cannot be created after receiving a GOAWAY"), { code: "ERR_HTTP2_GOAWAY_SESSION" }) });
    return good.fetcher(input, init);
  }) as typeof fetch;
  const reading = await new Usage(grafanaPrometheus(config, fetcher), () => now).reading();
  assert.equal(reading.state === "error" ? reading.error : "ok", "ok");
  assert.equal(reading.state === "error" ? 0 : reading.perSecond.output, 812);
});

test("the default LGTM client asks over HTTP/1.1, which has no HTTP/2 session for the proxy to close", async () => {
  const versions: string[] = [];
  const server = createServer((req, res) => {
    versions.push(req.httpVersion);
    assert.equal(req.headers.authorization, "Bearer viewer");
    const asked = new URL(String(req.url), "http://local");
    const range = asked.pathname.endsWith("/query_range");
    const kinds = (asked.searchParams.get("query") ?? "").includes("by (kind)");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { resultType: range ? "matrix" : "vector", result: range ? [] : kinds ? [{ metric: { kind: "output" }, value: [now / 1000, "640"] }] : [] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const local = join(mkdtempSync(join(tmpdir(), "usage-lgtm-h1-")), "grafana-alerts.json");
  writeFileSync(local, JSON.stringify({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, token: "viewer" }));
  try {
    const reading = await new Usage(grafanaPrometheus(local), () => now).reading();
    assert.equal(reading.state === "error" ? reading.error : "ok", "ok");
    assert.equal(reading.state === "error" ? 0 : reading.perSecond.output, 640);
    assert.ok(versions.length > 0 && versions.every(version => version === "1.1"));
  } finally { server.close(); }
});
