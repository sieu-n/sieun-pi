// Guards frontend bro's d1 run of 10-22 02:56Z: only a missed run's duty job ran the offline walk, so the 21:25Z run on 10-21 read a 19.6 h old
// walk, met its targets and started none, and the 02:56Z push run found the walk 25 h old. It read walk_problems 1 and slowest_page_ms 30000,
// though no page had been slow: the 30000 was the default a stale walk wrote, and the rerun walk at 06:47Z read 2083 ms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import { measureSandbox, runningWalks, WALK_COMMAND, WALK_FILE, WALK_REFRESH_MS, WALK_STALE_MS, type WalkReport } from "../scripts/duties/demo-sandbox.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-22T02:56:10Z");
const WALK_PS = "75411 75405 node --import tsx scripts/duties/demo-sandbox-walk.ts\n";
const walk = (startedAgoMs: number): WalkReport => ({
  stats: { startTime: new Date(NOW - startedAgoMs).toISOString() },
  suites: [{ file: "demo-sandbox-walk.ts", specs: [{ title: "kbeauty-brand: every browser and server request stays on localhost", file: "demo-sandbox-walk.ts", tests: [{ results: [{ status: "passed", annotations: [
    { type: "page-timing", description: JSON.stringify({ scenario: "kbeauty-brand", path: "/app/analytics/home", switches: [{ ms: 2083, long_ms: 0 }], loads: [{ ms: 4000, long_ms: 255 }] }) },
  ] }] }] }] }],
});
const run = async (report: WalkReport | null, ps = "") => {
  const started: number[] = [];
  const output = await measureSandbox({
    fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    exec: async file => file === "ps" ? ps : "[]",
    now: () => NOW,
    read: async path => {
      if (path.endsWith(WALK_FILE) && report) return JSON.stringify(report);
      if (path.endsWith(".log")) return "";
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    },
    mtime: async () => 0,
    repo: "/repo",
    platform: "darwin",
    pm2: { bin: "pm2", home: "/pm2", zone: "UTC" },
    startWalk: () => { started.push(NOW); return 4242; },
  });
  const kinds = (kind: string) => (output.flagged ?? []).filter(slice => slice.kind === kind).map(slice => slice.excerpt);
  return { output, started: started.length, kinds };
};
const duty = JSON.parse(readFileSync(new URL("../scripts/duties/demo-sandbox.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[]; onMiss: string };

test("a stale walk is its own state: walk_stale counts in walk_problems and slowest_page_ms has no reading, not 30000", async () => {
  const { output, kinds } = await run(walk(WALK_STALE_MS + HOUR));
  assert.equal(output.metrics.walk_problems, 1);
  assert.ok(!("slowest_page_ms" in output.metrics), `slowest_page_ms read ${output.metrics.slowest_page_ms}`);
  assert.equal(kinds("walk_stale").length, 1);
  assert.match(kinds("gap")[0]!, /^slowest_page_ms has no reading, since the last offline walk .* started 2026-10-21T00:56:10Z, over 25 h ago$/);
  const judged = judge(duty.metrics, output);
  assert.equal(judged.metrics.slowest_page_ms, undefined, "the duty shows it as not measured");
  assert.match(judged.summary, /^walk_problems 1 \(target at most 0\); not measured: the precheck gave no value for slowest_page_ms \(slowest_page_ms has no reading/);
});

test("a missing walk gives no slowest_page_ms reading either", async () => {
  const { output, kinds, started } = await run(null);
  assert.equal(output.metrics.walk_problems, 1);
  assert.ok(!("slowest_page_ms" in output.metrics));
  assert.match(kinds("gap")[0]!, /no offline walk result yet/);
  assert.equal(started, 1);
});

test("the precheck starts the next walk itself when the last one is over WALK_REFRESH_MS old, so a run on target refreshes it", async () => {
  const daily = await run(walk(19.6 * HOUR));
  assert.equal(daily.output.metrics.walk_problems, 0);
  assert.equal(daily.output.metrics.slowest_page_ms, 2083, "a fresh walk still reads its pages");
  assert.equal(daily.started, 1, "the 21:25Z run on 10-21 read a 19.6 h old walk and started none");
  assert.deepEqual(daily.kinds("walk_start"), ["started the next offline walk (pid 4242), detached, for the next run to read"]);
  const stale = await run(walk(WALK_STALE_MS + HOUR));
  assert.equal(stale.started, 1);
  const recent = await run(walk(WALK_REFRESH_MS - 60_000));
  assert.equal(recent.started, 0);
  assert.deepEqual(recent.kinds("walk_start"), []);
});

test("a walk that already runs is not started twice", async () => {
  assert.deepEqual(runningWalks(WALK_PS + "  501   1 /usr/sbin/sshd\n"), [75411]);
  const { started, kinds } = await run(walk(20 * HOUR), WALK_PS);
  assert.equal(started, 0);
  assert.deepEqual(kinds("walk_start"), ["an offline walk already runs (pids 75411), so this run started none"]);
});

test("the walk a daily run starts still counts at the next daily run, after the scheduler's lag", async () => {
  const next = await run(walk(24 * HOUR + 25_000));
  assert.equal(next.output.metrics.walk_problems, 0);
  assert.equal(next.output.metrics.slowest_page_ms, 2083);
  assert.ok(WALK_STALE_MS >= 24 * HOUR + WALK_REFRESH_MS + 25_000);
});

test("the walk command a fix job runs in onMiss is the one the precheck starts", () => {
  assert.ok(duty.onMiss.includes(WALK_COMMAND), "onMiss and WALK_COMMAND name the same walk");
});
