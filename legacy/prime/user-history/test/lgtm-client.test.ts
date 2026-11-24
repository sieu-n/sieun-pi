// The PromQL client behind the Agents card's tok/s and the duties: how a failed or dropped LGTM query reaches the caller.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { grafanaPrometheus } from "../src/usage/lgtm.ts";

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
  return { asked, fetcher, prometheus: grafanaPrometheus(config, fetcher) };
}

test("a query goes through the Grafana proxy of the staging Prometheus with the Viewer token", async () => {
  const { asked, prometheus } = stub({ output: "1234.5", input: "10" });
  const samples = await prometheus.query('sum by (kind) (rate(prime_agent_tokens_total{job="prime-agent"}[1m]))');
  assert.deepEqual(samples.find(sample => sample.labels.kind === "output")?.value, 1234.5);
  assert.ok(asked.every(url => url.pathname.startsWith("/api/datasources/proxy/uid/estate_prometheus_stg/api/v1/")));
});

test("a failed LGTM query throws its status, never answers zeros", async () => {
  const { prometheus } = stub({}, 502);
  await assert.rejects(prometheus.query("up"), /HTTP 502/);
});

test("an unreachable LGTM names the network cause, not only fetch failed", async () => {
  const fetcher = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); }) as typeof fetch;
  await assert.rejects(grafanaPrometheus(config, fetcher).query("up"), { message: "LGTM unreachable: fetch failed (ECONNRESET: read ECONNRESET)" });
});

test("a query on an HTTP/2 session that LGTM's proxy closed is asked again on a new one", async () => {
  const good = stub({ output: "812", input: "1", cache_read: "2", cache_write: "3" });
  let calls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("New streams cannot be created after receiving a GOAWAY"), { code: "ERR_HTTP2_GOAWAY_SESSION" }) });
    return good.fetcher(input, init);
  }) as typeof fetch;
  const samples = await grafanaPrometheus(config, fetcher).query("sum by (kind) (x)");
  assert.equal(samples.find(sample => sample.labels.kind === "output")?.value, 812);
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
    const samples = await grafanaPrometheus(local).query("sum by (kind) (x)");
    assert.equal(samples.find(sample => sample.labels.kind === "output")?.value, 640);
    assert.ok(versions.length > 0 && versions.every(version => version === "1.1"));
  } finally { server.close(); }
});
