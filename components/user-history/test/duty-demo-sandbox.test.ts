import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { countLog, type Exec, logTime, measureSandbox, readWalk, type SandboxDeps, type WalkReport, WALK_FILE } from "../scripts/duties/demo-sandbox.ts";

const NOW = new Date(2026, 9, 12, 23, 0, 0).getTime();
/** A pm2 log line at `msAgo` before NOW, in the local time pm2 writes. */
function logLine(msAgo: number, text: string): string {
  const at = new Date(NOW - msAgo);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}: ${text}`;
}
const GUARD = "[dev-guard] virev-demo: dev tree memory 4157 MB > cap 4096 MB, restarting the process group before the GC death spiral";
const TIMEOUT = "10:38:26 PM [vite] (ssr) Error when evaluating SSR module /src/app.css?inline: transport invoke timed out after 60000ms";
const HOUR = 3_600_000;

function walkReport(startTime: string, results: { title: string; status: string; message?: string }[]): WalkReport {
  return { stats: { startTime }, suites: [{ file: "offline.spec.ts", specs: results.map(result => ({ title: result.title, file: "offline.spec.ts",
    tests: [{ results: [{ status: result.status, errors: result.message ? [{ message: result.message }] : [] }] }] })) }] };
}

function deps(options: { answers?: Record<string, number | Error>; log?: string | Error; jlist?: string; footprintMb?: number; walk?: WalkReport | Error }): SandboxDeps {
  const exec: Exec = async (file, args) => {
    if (file.endsWith("pm2")) { if (options.jlist === undefined) throw new Error("connect ENOENT rpc.sock"); return options.jlist; }
    if (file === "ps") return "  100 1\n  200 100\n";
    if (file === "footprint") return args.filter((_, index) => args[index - 1] === "-p").map(() => `phys_footprint: ${(options.footprintMb ?? 0) * 1024 * 1024 / 2} B\n`).join("");
    throw new Error(`unexpected ${file}`);
  };
  const fetcher = (async (url: string) => {
    const answer = options.answers?.[new URL(url).pathname] ?? 200;
    if (answer instanceof Error) throw answer;
    return new Response("ok", { status: answer });
  }) as unknown as typeof fetch;
  const read = async (path: string) => {
    const value = path.endsWith(WALK_FILE) ? options.walk : options.log;
    if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if (value instanceof Error) throw value;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return { fetch: fetcher, exec, now: () => NOW, read, repo: "/repo", pm2: { bin: "/repo/node_modules/.bin/pm2", home: "/repo/.cache/pm2-dev" } };
}
const JLIST = "pm2 warning\n" + JSON.stringify([{ name: "virev-demo", pid: 100, pm2_env: { status: "online" } }]);

test("demo sandbox: pm2 log times are local, and guard restarts and SSR timeouts both count over the last 24 h", () => {
  assert.equal(logTime(logLine(0, "x")), NOW);
  assert.equal(logTime("no time here"), null);
  const log = [logLine(25 * HOUR, GUARD), logLine(23 * HOUR, GUARD), logLine(2 * HOUR, GUARD), logLine(25 * HOUR, TIMEOUT), logLine(23 * HOUR, TIMEOUT), logLine(2 * HOUR, TIMEOUT), logLine(60_000, TIMEOUT), "  at stack frame"].join("\n");
  const counted = countLog(log, NOW);
  assert.equal(counted.guardRestarts.length, 2);
  assert.equal(counted.ssrTimeouts.length, 3);
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

test("demo sandbox: a healthy 5180 with a fresh clean walk meets every target", async () => {
  const fresh = new Date(NOW - 2 * HOUR).toISOString();
  const output = await measureSandbox(deps({ jlist: JLIST, footprintMb: 2500, log: logLine(3 * HOUR, GUARD), walk: walkReport(fresh, [{ title: "a", status: "passed" }]) }));
  assert.deepEqual(output.metrics, { health_ok: 1, configure_ms: 0, guard_restarts_24h: 1, ssr_timeouts_24h: 0, dev_tree_mb: 2500, outside_requests: 0, source_errors: 0 });
});

test("demo sandbox: a hung server, a missing walk and a dead pm2 still give every metric, with the unread sources counted", async () => {
  const output = await measureSandbox(deps({ answers: { "/health": new Error("The operation was aborted due to timeout"), "/configure": 502 }, log: new Error("EACCES") }));
  assert.equal(output.metrics.health_ok, 0);
  assert.equal(output.metrics.source_errors, 3);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["down", "down", "source", "source", "walk"]);
});

test("demo sandbox: a stale walk and a walk that failed before its outside check are source errors, outside requests still count", async () => {
  const stale = walkReport(new Date(NOW - 30 * HOUR).toISOString(), [
    { title: "a", status: "failed", message: '+   "http://localhost:5180/app -> https://fonts.gstatic.com/x.woff2",' },
    { title: "b", status: "failed", message: "page.goto: net::ERR_CONNECTION_REFUSED" },
  ]);
  const output = await measureSandbox(deps({ jlist: JLIST, footprintMb: 3500, log: "", walk: stale }));
  assert.equal(output.metrics.outside_requests, 1);
  assert.equal(output.metrics.source_errors, 2);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["memory", "outside_request", "walk_failed", "walk_stale"]);
});

test("demo sandbox duty file parses, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "demo-sandbox.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "06:25" });
  assert.equal(duty.precheck.cwd, "../..");
  const output = await measureSandbox(deps({}));
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});
