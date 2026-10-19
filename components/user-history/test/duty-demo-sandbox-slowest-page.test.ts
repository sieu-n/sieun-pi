// Guards d1's slowest_page_ms, which replaced health_ms on 10-19: /health answered in 25 ms while the owner found switching "infuriatingly slow"
// (10-09) and Creators slow to load (10-19 13:06Z, 2.3 to 2.5 s of long tasks before 7966ebbfd), so the duty saw neither.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { measureSandbox, PAGE_TIMEOUT_MS, pageMs, readWalk, slowestPage, WALK_FILE, type PageTiming, type WalkReport } from "../scripts/duties/demo-sandbox.ts";

const timing = (path: string, over: Partial<PageTiming> = {}): PageTiming =>
  ({ scenario: "kbeauty-brand", path, switch_ms: 300, switch_long_ms: 0, load_ms: 4000, load_long_ms: 100, ...over });
const scenario = (name: string, timings: PageTiming[], status = "passed") => ({
  title: `${name}: every browser and server request stays on localhost`,
  file: "offline.spec.ts",
  tests: [{ results: [{ status, annotations: timings.map(entry => ({ type: "page-timing", description: JSON.stringify(entry) })) }] }],
});
const START = "2026-10-19T16:28:33.775Z";
const report = (...specs: ReturnType<typeof scenario>[]): WalkReport => ({ stats: { startTime: START }, suites: [{ file: "offline.spec.ts", specs }] });

test("a page's time is the slower of its in-app switch and its load's long tasks, and the load's wall time through the link does not count", () => {
  assert.equal(pageMs(timing("/app/inbox")), 300);
  assert.equal(pageMs(timing("/app/analytics/creators", { load_long_ms: 2400 })), 2400, "Creators before 7966ebbfd");
  assert.equal(pageMs(timing("/app/discover", { switch_ms: null })), PAGE_TIMEOUT_MS, "a switch that never showed");
  assert.equal(pageMs(timing("/app/discover", { load_ms: null })), PAGE_TIMEOUT_MS, "a load that never showed");
});

test("slowest_page_ms names the slowest page and scenario, and a scenario with no timings reads as the timeout", () => {
  const walk = readWalk(report(
    scenario("kbeauty-brand", [timing("/app/analytics/home", { switch_ms: 1597 }), timing("/app/search", { switch_ms: 50 })]),
    scenario("fresh-start", [timing("/app/analytics/home", { scenario: "fresh-start", switch_ms: 1004 })]),
  ));
  const slowest = slowestPage(walk.pages, walk.untimed);
  assert.equal(slowest.ms, 1597);
  assert.equal(slowest.name, "/app/analytics/home (kbeauty-brand)");
  assert.deepEqual(slowest.perPage.map(page => page.path), ["/app/analytics/home", "/app/search"]);
  const failed = readWalk(report(scenario("kbeauty-brand", [timing("/app/search")]), scenario("fresh-start", [], "failed")));
  assert.deepEqual(failed.untimed, ["fresh-start: every browser and server request stays on localhost"]);
  assert.equal(slowestPage(failed.pages, failed.untimed).ms, PAGE_TIMEOUT_MS);
});

test("the precheck reports slowest_page_ms from the walk in place of health_ms, and the duty judges only metrics it writes", async () => {
  const walkText = JSON.stringify(report(scenario("kbeauty-brand", [timing("/app/analytics/creators", { load_long_ms: 2400 })]), scenario("fresh-start", [timing("/app/inbox")])));
  const fetched: string[] = [];
  const run = await measureSandbox({
    fetch: (async (url: string) => { fetched.push(String(url)); return new Response("ok"); }) as unknown as typeof fetch,
    exec: async file => file === "ps" ? "" : "[]",
    now: () => Date.parse(START) + 3_600_000,
    read: async path => { if (path.endsWith(WALK_FILE)) return walkText; if (path.endsWith(".log")) return ""; throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); },
    mtime: async () => 0,
    repo: "/repo",
    platform: "darwin",
    pm2: { bin: "pm2", home: "/pm2", zone: "UTC" },
  });
  assert.equal(run.metrics.slowest_page_ms, 2400);
  assert.ok(!("health_ms" in run.metrics));
  assert.ok(!fetched.includes("http://localhost:5180/health"), "no /health probe");
  assert.match((run.flagged ?? []).find(slice => slice.kind === "slowest_page")!.excerpt, /\/app\/analytics\/creators \(kbeauty-brand\): 2400 ms/);
  const duty = JSON.parse(readFileSync(new URL("../scripts/duties/demo-sandbox.duty.json", import.meta.url), "utf8")) as { metrics: { key: string }[] };
  for (const metric of duty.metrics) assert.ok(metric.key in run.metrics, `${metric.key} is judged but the precheck never writes it`);
});
