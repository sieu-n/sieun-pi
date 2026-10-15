import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { headlineMetric, parseDutyInput } from "../src/shared/chat-duties.ts";
import { ANSWER_TIMEOUT_MS, editsBefore, type Exec, guardKills, logTime, measureSandbox, readWalk, restarts, type SandboxDeps, ssrTimeouts, type WalkReport, WALK_FILE } from "../scripts/duties/demo-sandbox.ts";

const NOW = new Date(2026, 9, 15, 18, 20, 0).getTime();
/** A pm2 log line at `msAgo` before NOW, in the local time pm2 writes. */
function logLine(msAgo: number, text: string): string {
  const at = new Date(NOW - msAgo);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}: ${text}`;
}
const GUARD = "[dev-guard] virev-demo: dev tree memory 4188 MB > cap 4096 MB, restarting the process group before the GC death spiral";
const TIMEOUT = "Error: transport invoke timed out after 60000ms (data: {\"type\":\"custom\",\"event\":\"vite:invoke\"})";
const EXIT = (code: number) => `PM2 log: App [virev-demo:4] exited with code [${code}] via signal [SIGINT]`;
const START = "PM2 log: App [virev-demo:4] starting in -fork mode-";
const CONFIG = "5:28:45 PM [vite] config changed, exiting so pm2 starts a fresh dev server";
const STOP = "PM2 log: Stopping app:virev-demo id:4";
const EDIT = "5:26:10 PM [vite] (ssr) page reload variants/creators/deck/posts.ts";
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function walkReport(startTime: string, results: { title: string; status: string; message?: string }[]): WalkReport {
  return { stats: { startTime }, suites: [{ file: "offline.spec.ts", specs: results.map(result => ({ title: result.title, file: "offline.spec.ts",
    tests: [{ results: [{ status: result.status, errors: result.message ? [{ message: result.message }] : [] }] }] })) }] };
}

interface Options { answers?: Record<string, number | Error>; ms?: number; errorLog?: string | Error; outLog?: string | Error; pm2Log?: string | Error; jlist?: string; footprintMb?: number; walk?: WalkReport | Error }
function deps(options: Options): SandboxDeps {
  const exec: Exec = async (file, args) => {
    if (file.endsWith("pm2")) { if (options.jlist === undefined) throw new Error("connect ENOENT rpc.sock"); return options.jlist; }
    if (file === "ps") return "  100 1\n  200 100\n";
    if (file === "footprint") return args.filter((_, index) => args[index - 1] === "-p").map(() => `phys_footprint: ${(options.footprintMb ?? 0) * 1024 * 1024 / 2} B\n`).join("");
    throw new Error(`unexpected ${file}`);
  };
  let clock = NOW;
  const fetcher = (async (url: string) => {
    const answer = options.answers?.[new URL(url).pathname] ?? 200;
    await Promise.resolve();
    clock = NOW + (options.ms ?? 0);
    if (answer instanceof Error) throw answer;
    return new Response("ok", { status: answer });
  }) as unknown as typeof fetch;
  const read = async (path: string) => {
    const value = path.endsWith(WALK_FILE) ? options.walk : path.endsWith("virev-demo-error.log") ? options.errorLog : path.endsWith("virev-demo-out.log") ? options.outLog : path.endsWith("pm2.log") ? options.pm2Log : undefined;
    if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if (value instanceof Error) throw value;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return { fetch: fetcher, exec, now: () => clock, read, repo: "/repo", pm2: { bin: "/repo/node_modules/.bin/pm2", home: "/repo/.cache/pm2-dev" } };
}
const JLIST = "pm2 warning\n" + JSON.stringify([{ name: "virev-demo", pid: 100, pm2_env: { status: "online" } }]);
const freshWalk = () => walkReport(new Date(NOW - 2 * HOUR).toISOString(), [{ title: "kbeauty-brand", status: "passed" }, { title: "fresh-start", status: "passed" }, { title: "marketing", status: "passed" }]);

test("demo sandbox: pm2 log times are local; SSR timeout lines close together are one event, and guard kills count over 24 h", () => {
  assert.equal(logTime(logLine(0, "x")), NOW);
  assert.equal(logTime("no time here"), null);
  // 10-15 17:26 KST: 4 timeout lines in 53 s were one hung page load.
  const log = [logLine(25 * HOUR, TIMEOUT), logLine(23 * HOUR, TIMEOUT), logLine(54 * MIN, TIMEOUT), logLine(54 * MIN, TIMEOUT), logLine(53 * MIN, TIMEOUT), "  at stack frame",
    logLine(25 * HOUR, GUARD), logLine(12 * HOUR, GUARD), logLine(11 * HOUR, GUARD)].join("\n");
  const events = ssrTimeouts(log, NOW);
  assert.deepEqual(events.map(event => event.lines), [1, 3]);
  assert.equal(guardKills(log, NOW).length, 2);
  const out = [logLine(57 * MIN, EDIT), logLine(56 * MIN, EDIT), logLine(55 * MIN, EDIT), logLine(2 * HOUR, EDIT), logLine(55 * MIN, "warm /configure 200 in 300 ms")].join("\n");
  assert.equal(editsBefore(out, events[1]!.first), 3);
});

test("demo sandbox: restarts group a crash loop into one, name guard and hand restarts, and leave out vite config restarts", () => {
  const loop = Array.from({ length: 30 }, (_, index) => [logLine(14 * HOUR - index * 1500, EXIT(2)), logLine(14 * HOUR - index * 1500 - 500, START)]).flat();
  const pm2 = [logLine(30 * HOUR, EXIT(97)), ...loop, logLine(12 * HOUR, EXIT(97)), logLine(11 * HOUR, EXIT(97)),
    logLine(5 * HOUR + 5 * SEC, STOP), logLine(5 * HOUR, EXIT(0)), logLine(HOUR, EXIT(0)), logLine(30 * MIN, EXIT(0))].join("\n");
  const out = [logLine(HOUR + 2 * SEC, CONFIG), logLine(31 * MIN, "page reload x")].join("\n");
  const counted = restarts(pm2, out, NOW);
  assert.deepEqual(counted.events.map(event => event.kinds.join("+")), ["crash", "guard", "guard", "command", "crash"]);
  assert.equal(counted.events[0]!.exits.length, 30);
  assert.equal(counted.config.length, 1);
  // With no out log, a config restart cannot be told apart, so it counts.
  assert.equal(restarts(pm2, undefined, NOW).events.length, 6);
});

test("demo sandbox: the offline walk report gives each outside request; another failure is not counted as 0 outside", () => {
  const outsideMessage = 'Error: expect(received).toEqual(expected)\n\n- Expected  - 1\n+ Received  + 4\n\n- Array []\n+ Array [\n+   "http://localhost:5180/app -> https://fonts.googleapis.com/css2",\n+   "http://localhost:5180/app/inbox -> https://cdn.example.com/a.png",\n+ ]';
  const walk = readWalk(walkReport("2026-10-12T05:00:00.000Z", [
    { title: "kbeauty-brand: every browser request stays on localhost", status: "failed", message: outsideMessage },
    { title: "fresh-start: every browser request stays on localhost", status: "timedOut", message: "Test timeout of 480000ms exceeded." },
    { title: "marketing pages", status: "passed" },
  ]));
  assert.equal(walk.tests, 3);
  assert.deepEqual(walk.outside, ["http://localhost:5180/app -> https://fonts.googleapis.com/css2", "http://localhost:5180/app/inbox -> https://cdn.example.com/a.png"]);
  assert.equal(walk.otherFailures.length, 1);
  assert.match(walk.otherFailures[0]!, /^fresh-start.*timedOut/);
});

test("demo sandbox: 10-15 after the appIcons fix, a fresh clean walk and a fast 5180 meet the headline, and the edit-burst hang misses ssr_timeouts_24h", async () => {
  const errorLog = [logLine(54 * MIN, TIMEOUT), logLine(53 * MIN, TIMEOUT)].join("\n");
  const outLog = Array.from({ length: 36 }, (_, index) => logLine(55 * MIN + index * 3 * SEC, EDIT)).join("\n");
  const output = await measureSandbox(deps({ ms: 50, jlist: JLIST, footprintMb: 2200, errorLog, outLog, pm2Log: "", walk: freshWalk() }));
  assert.equal(output.metrics.walk_problems, 0);
  assert.equal(output.metrics.health_ms, 50);
  assert.equal(output.metrics.restarts_24h, 0);
  assert.equal(output.metrics.ssr_timeouts_24h, 1);
  assert.equal(output.metrics.dev_tree_mb, 2200);
  assert.equal(output.metrics.source_errors, 0);
  assert.match(output.flagged!.find(item => item.kind === "ssr_timeout")!.excerpt, /36 file changes in the 3 min before/);
});

test("demo sandbox: a hung server reads as the full wait, and unread logs and a missing walk count in the metrics they feed", async () => {
  const output = await measureSandbox(deps({ answers: { "/health": new Error("The operation was aborted due to timeout"), "/configure": 502 }, errorLog: new Error("EACCES"), pm2Log: new Error("EACCES") }));
  assert.equal(output.metrics.health_ms, ANSWER_TIMEOUT_MS);
  assert.equal(output.metrics.configure_ms, ANSWER_TIMEOUT_MS);
  assert.equal(output.metrics.walk_problems, 1);
  assert.equal(output.metrics.ssr_timeouts_24h, 1);
  assert.equal(output.metrics.restarts_24h, 1);
  // The out log, the error log, pm2.log and pm2 itself.
  assert.equal(output.metrics.source_errors, 4);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["down", "down", "source", "source", "source", "source", "walk_missing"]);
});

test("demo sandbox: a 404 from /health is no answer, a slow 200 misses health_ms, and a stale walk with an outside request and a failed page adds 3", async () => {
  assert.equal((await measureSandbox(deps({ answers: { "/health": 404 } }))).metrics.health_ms, ANSWER_TIMEOUT_MS);
  const stale = walkReport(new Date(NOW - 30 * HOUR).toISOString(), [
    { title: "a", status: "failed", message: '+   "http://localhost:5180/app -> https://fonts.gstatic.com/x.woff2",' },
    { title: "b", status: "failed", message: "page.goto: net::ERR_CONNECTION_REFUSED" },
  ]);
  const output = await measureSandbox(deps({ ms: 3500, jlist: JLIST, footprintMb: 3500, errorLog: "", outLog: "", pm2Log: "", walk: stale }));
  assert.equal(output.metrics.health_ms, 3500);
  assert.equal(output.metrics.outside_requests, 1);
  assert.equal(output.metrics.walk_problems, 3);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["memory", "outside_request", "slow", "slow", "walk_failed", "walk_stale"]);
});

test("demo sandbox duty file parses with one headline and 3 supporting metrics, each a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "demo-sandbox.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "06:25" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.equal(headlineMetric(duty.metrics)?.key, "walk_problems");
  assert.equal(duty.metrics.length, 4);
  const output = await measureSandbox(deps({}));
  for (const metric of duty.metrics) assert.ok(metric.key in output.metrics, metric.key);
});
