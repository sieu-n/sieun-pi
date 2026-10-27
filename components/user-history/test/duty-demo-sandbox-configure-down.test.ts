// Guards frontend bro's d1 run of 10-23 06:25 KST: the 21:25Z precheck on 10-22 found /configure timing out after 30 s, yet read walk_problems 0,
// because the walk it read had started at 06:47Z, before the demo pin move broke /configure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureSandbox, WALK_FILE, type WalkReport } from "../scripts/duties/demo-sandbox.ts";

const NOW = Date.parse("2026-10-22T21:25:18Z");
const cleanWalk: WalkReport = {
  stats: { startTime: "2026-10-22T06:47:56Z" },
  suites: [{ file: "demo-sandbox-walk.ts", specs: [{ title: "kbeauty-brand: every browser and server request stays on localhost", file: "demo-sandbox-walk.ts", tests: [{ results: [{ status: "passed", annotations: [
    { type: "page-timing", description: JSON.stringify({ scenario: "kbeauty-brand", path: "/app/analytics/home", switches: [{ ms: 2083, long_ms: 0 }], loads: [] }) },
  ] }] }] }] }],
};
const run = (configure: () => Promise<Response>) => measureSandbox({
  fetch: (async (url: string) => String(url).includes("/configure") ? configure() : new Response("{}")) as unknown as typeof fetch,
  exec: async file => file === "ps" ? "" : "[]",
  now: () => NOW,
  read: async path => {
    if (path.endsWith(WALK_FILE)) return JSON.stringify(cleanWalk);
    if (path.endsWith(".log")) return "";
    throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  },
  mtime: async () => 0,
  repo: "/repo",
  platform: "darwin",
  pm2: { bin: "pm2", home: "/pm2", zone: "UTC" },
  startWalk: () => 2564,
});

test("a /configure probe that times out counts in walk_problems though the last walk was clean", async () => {
  const output = await run(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
  assert.equal(output.metrics.walk_problems, 1);
  assert.equal(output.metrics.outside_requests, 0);
  assert.equal(output.flagged?.filter(slice => slice.kind === "down").length, 1);
});

test("a /configure 500 counts too, and a 200 adds nothing", async () => {
  assert.equal((await run(async () => new Response("boom", { status: 500 }))).metrics.walk_problems, 1);
  assert.equal((await run(async () => new Response("ok"))).metrics.walk_problems, 0);
});
