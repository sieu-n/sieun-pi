// Guards d1's slowest_page_ms, which replaced health_ms on 10-19: /health answered in 25 ms while the owner found switching "infuriatingly slow"
// (10-09) and Creators slow to load (10-19 13:06Z, 2.3 to 2.5 s of long tasks before 7966ebbfd), so the duty saw neither.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boxLoadLine, measureSandbox, PAGE_TIMEOUT_MS, pageMs, readWalk, slowestPage, WALK_FILE, type BoxLoad, type PageTiming, type WalkReport } from "../scripts/duties/demo-sandbox.ts";

/** One page with one try of each: a 300 ms switch and a 4 s load with 100 ms of long tasks, unless `over` says otherwise. */
const timing = (path: string, over: Partial<PageTiming> = {}): PageTiming =>
  ({ scenario: "kbeauty-brand", path, switches: [{ ms: 300, long_ms: 0 }], loads: [{ ms: 4000, long_ms: 100 }], ...over });
const load = (long_ms: number) => ({ ms: 4000, long_ms });
const scenario = (name: string, timings: PageTiming[], status = "passed", boxLoads: BoxLoad[] = []) => ({
  title: `${name}: every browser and server request stays on localhost`,
  file: "demo-sandbox-walk.ts",
  tests: [{ results: [{ status, annotations: [
    ...timings.map(entry => ({ type: "page-timing", description: JSON.stringify(entry) })),
    ...boxLoads.map(entry => ({ type: "box-load", description: JSON.stringify(entry) })),
  ] }] }],
});
const START = "2026-10-19T16:28:33.775Z";
const report = (...specs: ReturnType<typeof scenario>[]): WalkReport => ({ stats: { startTime: START }, suites: [{ file: "demo-sandbox-walk.ts", specs }] });

test("a page's time is the slower of its in-app switch and its load's long tasks, and the load's wall time through the link does not count", () => {
  assert.equal(pageMs(timing("/app/inbox")), 300);
  assert.equal(pageMs(timing("/app/analytics/creators", { loads: [load(2400)] })), 2400, "Creators before 7966ebbfd");
  assert.equal(pageMs(timing("/app/search", { switches: [{ ms: null, long_ms: 0 }] })), PAGE_TIMEOUT_MS, "a switch that never showed");
  assert.equal(pageMs(timing("/app/search", { loads: [{ ms: null, long_ms: 0 }] })), PAGE_TIMEOUT_MS, "a load that never showed");
  assert.equal(pageMs(timing("/app/search", { switches: [], loads: [] })), PAGE_TIMEOUT_MS, "a page the walk never timed");
});

// 10-20: with us-metal02 at load 242 on 80 cores, two walks back to back read 7.1 s and then 12.7 s of load long tasks, so one try measured the box.
test("a page's time takes its fastest switch and its lowest load long tasks of up to 3 tries, since a busy box only adds time", () => {
  const campaigns = timing("/app/campaigns", {
    switches: [{ ms: 3416, long_ms: 1012 }, { ms: 1191, long_ms: 688 }, { ms: 1400, long_ms: 700 }],
    loads: [load(12692), load(850), load(900)],
  });
  assert.equal(pageMs(campaigns), 1191, "the fastest switch beats the load's lowest long tasks");
  assert.equal(pageMs({ ...campaigns, switches: [{ ms: 400, long_ms: 0 }] }), 850, "the lowest load long tasks, not the 12.7 s try");
  assert.equal(pageMs(timing("/app/inbox", { switches: [{ ms: null, long_ms: 0 }, { ms: 900, long_ms: 10 }, { ms: null, long_ms: 0 }] })), 900,
    "a try that never showed is passed over when another try showed");
  assert.equal(pageMs(timing("/app/inbox", { loads: [{ ms: null, long_ms: 5 }, load(7100)] })), 7100,
    "the long tasks of a load that never showed do not count as its fastest");
  assert.equal(pageMs(timing("/app/inbox", { switches: [{ ms: null, long_ms: 0 }, { ms: null, long_ms: 0 }, { ms: null, long_ms: 0 }] })), PAGE_TIMEOUT_MS);
});

test("a walk from before the tries were kept reads as pages that never showed", () => {
  const old = { scenario: "kbeauty-brand", path: "/app/search", switch_ms: 300, switch_long_ms: 0, load_ms: 4000, load_long_ms: 100 };
  const walk = readWalk(report(scenario("kbeauty-brand", [old as unknown as PageTiming])));
  assert.deepEqual(walk.pages, [{ scenario: "kbeauty-brand", path: "/app/search", switches: [], loads: [] }]);
  assert.equal(slowestPage(walk.pages, walk.untimed).ms, PAGE_TIMEOUT_MS);
});

test("the box load line names the walk's browser host, its cores and the load range, and says when no read came back", () => {
  const read = (round: number, load1: number): BoxLoad => ({ scenario: "kbeauty-brand", pass: `switch ${round}`, host: "us-metal02", load1, cores: 80 });
  assert.equal(boxLoadLine([read(1, 180.5), read(2, 242.1), read(3, 201)]),
    "the walk's browser ran on us-metal02 (80 cores) at 1-min load 180.5 to 242.1 over 3 reads, one at the start of each timed pass");
  assert.equal(boxLoadLine([read(1, 12)]), "the walk's browser ran on us-metal02 (80 cores) at 1-min load 12 over 1 read, one at the start of each timed pass");
  assert.equal(boxLoadLine([read(1, 12), { scenario: "fresh-start", pass: "switch 1", host: "us-metal02", error: "ssh: connect to host us-metal02 port 22: Operation timed out" }]),
    "the walk's browser ran on us-metal02 (80 cores) at 1-min load 12 over 1 read, one at the start of each timed pass; 1 read failed: ssh: connect to host us-metal02 port 22: Operation timed out");
  assert.equal(boxLoadLine([]), "no load read of the walk's browser host in the walk report");
});

test("slowest_page_ms names the slowest page and scenario, and a scenario with no timings reads as the timeout", () => {
  const walk = readWalk(report(
    scenario("kbeauty-brand", [timing("/app/analytics/home", { switches: [{ ms: 1597, long_ms: 0 }] }), timing("/app/search", { switches: [{ ms: 50, long_ms: 0 }] })]),
    scenario("fresh-start", [timing("/app/analytics/home", { scenario: "fresh-start", switches: [{ ms: 1004, long_ms: 0 }] })]),
  ));
  const slowest = slowestPage(walk.pages, walk.untimed);
  assert.equal(slowest.ms, 1597);
  assert.equal(slowest.name, "/app/analytics/home (kbeauty-brand)");
  assert.deepEqual(slowest.perPage.map(page => page.path), ["/app/analytics/home", "/app/search"]);
  const failed = readWalk(report(scenario("kbeauty-brand", [timing("/app/search")]), scenario("fresh-start", [], "failed")));
  assert.deepEqual(failed.untimed, ["fresh-start: every browser and server request stays on localhost"]);
  assert.equal(slowestPage(failed.pages, failed.untimed).ms, PAGE_TIMEOUT_MS);
});

test("the precheck reports slowest_page_ms from the walk's fastest tries in place of health_ms, names the box load, and the duty judges only metrics it writes", async () => {
  const boxLoads: BoxLoad[] = [{ scenario: "kbeauty-brand", pass: "switch 1", host: "us-metal02", load1: 242, cores: 80 }, { scenario: "kbeauty-brand", pass: "load 2", host: "us-metal02", load1: 96, cores: 80 }];
  const walkText = JSON.stringify(report(
    scenario("kbeauty-brand", [timing("/app/analytics/creators", { loads: [load(12692), load(2400), load(2600)] })], "passed", boxLoads),
    scenario("fresh-start", [timing("/app/inbox")]),
  ));
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
    startWalk: () => 4242,
  });
  assert.equal(run.metrics.slowest_page_ms, 2400);
  assert.ok(!("health_ms" in run.metrics));
  assert.ok(!fetched.includes("http://localhost:5180/health"), "no /health probe");
  const slice = (kind: string) => (run.flagged ?? []).find(entry => entry.kind === kind)!.excerpt;
  assert.match(slice("slowest_page"), /\/app\/analytics\/creators \(kbeauty-brand\): 2400 ms/);
  assert.match(slice("slowest_page"), /\/app\/analytics\/creators 2400 \(switch 300, load long tasks 12692\/2400\/2600\)/);
  assert.equal(slice("box_load"), "the walk's browser ran on us-metal02 (80 cores) at 1-min load 96 to 242 over 2 reads, one at the start of each timed pass");
  const duty = JSON.parse(readFileSync(new URL("../scripts/duties/demo-sandbox.duty.json", import.meta.url), "utf8")) as { metrics: { key: string }[] };
  for (const metric of duty.metrics) assert.ok(metric.key in run.metrics, `${metric.key} is judged but the precheck never writes it`);
});
