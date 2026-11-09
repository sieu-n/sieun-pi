// Guards slack green guy's d6 run of 11-09 00:07Z: one connection drop on us-metal02 failed /en/pricing (net::ERR_CONNECTION_ABORTED), gh run
// list ("error connecting to api.github.com") and POST /api/teams/heartbeat (fetch failed), and a rerun minutes later read every metric on target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { retryingExec, retryingFetch } from "../scripts/duties/connection-retry.ts";
import { PAGES, pageFailure, readRoutes, walkPages } from "../scripts/duties/slack-green-services.ts";

const NOW = Date.parse("2026-11-09T00:07:34Z");
const ok = JSON.stringify({ status: 200, finalUrl: "", pageErrors: [], consoleErrors: [], api5xx: [] });
const rendered = (code: string) => JSON.stringify({ ...JSON.parse(ok), finalUrl: /p\.goto\("([^"]+)"/.exec(code.split("if (!read.error)")[1]!)![1] });

test("a page whose load drops the connection once reads again and renders", async () => {
  const runs: string[] = [];
  const browser = { run: async (code: string) => {
    runs.push(code);
    if (code.includes("/en/pricing") && runs.filter(item => item.includes("/en/pricing")).length === 1)
      return JSON.stringify({ pageErrors: [], consoleErrors: [], api5xx: [], error: "page.goto: net::ERR_CONNECTION_ABORTED at https://slack.green/en/pricing" });
    return rendered(code);
  } };
  const reads = await walkPages(browser, new Error("no Supabase key"), 0);
  const pricing = reads.find(read => read.key === "pricing")!;
  assert.equal(pageFailure(pricing), null);
  assert.equal(runs.length, PAGES.length);
});

test("a page that answers 5xx, throws or shows an error screen counts on the first read", async () => {
  let runs = 0;
  const browser = { run: async (code: string) => { runs++; return JSON.stringify({ ...JSON.parse(rendered(code)), status: 503, errorScreen: "Internal Server Error" }); } };
  const reads = await walkPages(browser, new Error("no Supabase key"), 0);
  assert.equal(runs, PAGES.length - 1);
  assert.match(pageFailure(reads.find(read => read.key === "home")!)!, /HTTP 503/);
});

test("a route call that throws fetch failed once calls again and reads its 401", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/teams/heartbeat") && calls.filter(item => item === url).length === 1) throw new TypeError("fetch failed");
    return new Response(url.endsWith("/heartbeat") ? '{"error":"unlinked"}' : '{"valid":false,"error":"invalid_session"}', { status: 401 });
  }) as typeof fetch;
  const routes = await readRoutes(retryingFetch(fetcher, 0), NOW);
  assert.deepEqual(routes.map(route => route.ok), [true, true]);
  assert.equal(calls.length, 3);
});

test("a route that answers HTTP 5xx counts at once and is not called again", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response("upstream down", { status: 502 }); }) as unknown as typeof fetch;
  const routes = await readRoutes(retryingFetch(fetcher, 0), NOW);
  assert.deepEqual(routes.map(route => [route.ok, route.status]), [[false, 502], [false, 502]]);
  assert.equal(calls, 2);
});

test("a gh call that cannot connect runs once more, and a gh call that ran and failed does not", async () => {
  let calls = 0;
  const flaky = retryingExec(async (file: string) => {
    calls++;
    if (calls === 1) throw new Error(`${file} run: Command failed: gh run list\nerror connecting to api.github.com\ncheck your internet connection`);
    return "[]";
  }, 0);
  assert.equal(await flaky("gh"), "[]");
  assert.equal(calls, 2);
  let failing = 0;
  const broken = retryingExec(async () => { failing++; throw new Error("gh run: HTTP 404: Not Found"); }, 0);
  await assert.rejects(broken(), /HTTP 404/);
  assert.equal(failing, 1);
});
