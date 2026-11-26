// 11-27: staging GET /v1/search/bing answered 502 scrape_blocked after 20.2 s, and d2 read staging_working_pct 99.5% and routes_failing_crawler 1,
// while the portal tells the caller "The platform blocked this read. Retry it. You are not charged."
import assert from "node:assert/strict";
import { test } from "node:test";
import { againOnRetry, parityMetrics, probe, type OpenApi, type Route } from "../scripts/duties/portal-parity.ts";

const BING: Route = { crawler: "GET /api/search/bing", group: "search", portal: ["GET /v1/search/bing"] };
const openapi = (op: string): OpenApi => { const [method, path] = op.split(" ") as [string, string]; return { paths: { [path]: { [method.toLowerCase()]: {} } } }; };
const blocked = () => new Response(JSON.stringify({ error: { code: "scrape_blocked", message: "The platform blocked this read. Retry it. You are not charged." } }), { status: 502 });
const page = () => new Response(JSON.stringify({ data: { items: [] }, meta: {} }), { status: 200 });
const bing = () => probe("https://api.test", { id: "org_1", key: "kb_live_x" }, "GET /v1/search/bing", { method: "GET", path: "/v1/search/bing", query: { q: "virev" } }, "docs example", 10_000, [0, 0]);
const score = async (answer: Awaited<ReturnType<typeof bing>>) => parityMetrics({ routes: [BING], at: 1, sourceErrors: [],
  crawler: { prod: null, staging: openapi(BING.crawler) }, docs: { prod: null, staging: openapi("GET /v1/search/bing") },
  probes: { prod: [], staging: [answer] } }).output;

test("a first-try scrape_blocked and a second-try 200 scores the route working, and the first try stays a flag", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => ++sent === 1 ? blocked() : page());
  const answer = await againOnRetry(bing);
  assert.equal(sent, 2);
  const { metrics, flagged = [] } = await score(answer);
  assert.equal(metrics.staging_working_pct, 100);
  assert.equal(metrics.routes_failing_crawler, 0);
  assert.deepEqual(flagged.filter(slice => slice.kind === "retried_staging").map(slice => slice.excerpt), [
    `GET /v1/search/bing on staging: first try 502 scrape_blocked after ${answer.firstTry!.ms} ms, second try 200 after ${answer.ms} ms`]);
});

test("a second block fails the route and its flag names both tries", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => { sent++; return blocked(); });
  const { metrics, flagged = [] } = await score(await againOnRetry(bing));
  assert.equal(sent, 2);
  assert.equal(metrics.routes_failing_crawler, 1);
  const broken = flagged.find(slice => slice.kind === "broken_crawler_staging")!;
  assert.match(broken.excerpt, /502 scrape_blocked .*on a second try after 502 scrape_blocked/);
});

test("a failure whose message does not say retry goes out once", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => { sent++; return new Response(JSON.stringify({ error: { code: "upstream_error", message: "Bing answered 500" } }), { status: 502 }); });
  const answer = await againOnRetry(bing);
  assert.equal(sent, 1);
  assert.equal(answer.firstTry, undefined);
});
