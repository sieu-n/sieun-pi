import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { ANSWER_TIMEOUT_MS, type Exec, footprintMb, measureUptime, parseEnv, restartsSince, target, treePids, type UptimeDeps } from "../scripts/duties/local-dev-uptime.ts";

const NOW = Date.parse("2026-10-10T05:00:00Z");
const ENV = { PUBLIC_CONVEX_URL: "http://127.0.0.1:3210", CRAWLER_API_URL: "http://localhost:8787" };
const jlist = (wiki: number, search: number) => "pm2 warning\n" + JSON.stringify([
  { name: "llm-wiki", pid: 100, pm2_env: { restart_time: wiki, status: "online" } }, { name: "search", pid: 9, pm2_env: { restart_time: search, status: "online" } }]);

function deps(options: { answers?: Record<string, number | Error>; jlist?: string; footprintMb?: number; env?: Record<string, string> }): UptimeDeps & { urls: string[] } {
  const urls: string[] = [];
  const exec: Exec = async (file, args) => {
    if (file.endsWith("pm2")) { if (options.jlist === undefined) throw new Error("connect ENOENT rpc.sock"); return options.jlist; }
    if (file === "ps") return "  100 1\n  200 100\n";
    if (file === "sysctl") return "{ 31.2 25.0 21.0 }\ntotal = 22528.00M  used = 22286.31M  free = 241.69M  (encrypted)\n";
    if (file === "footprint") return args.filter((_, index) => args[index - 1] === "-p").map(() => `phys_footprint: ${(options.footprintMb ?? 0) * 1024 * 1024 / 2} B\n`).join("");
    throw new Error(`unexpected ${file}`);
  };
  const fetcher = (async (url: string) => {
    urls.push(url);
    const answer = options.answers?.[url] ?? 200;
    if (answer instanceof Error) throw answer;
    return new Response("ok", { status: answer });
  }) as unknown as typeof fetch;
  return { fetch: fetcher, exec, now: () => NOW, env: options.env ?? ENV, pm2: { bin: "/repo/node_modules/.bin/pm2", home: "/repo/.cache/pm2-dev" }, urls };
}

test("local dev uptime: probes the 4 URLs, takes Convex and crawler URLs from the search app's env", async () => {
  const run = deps({ jlist: jlist(0, 2), footprintMb: 1500 });
  const { output, state } = await measureUptime(run, undefined);
  assert.deepEqual(run.urls.sort(), ["http://127.0.0.1:3210/version", "http://localhost:5174/", "http://localhost:5176/", "http://localhost:8787/health"]);
  assert.deepEqual(output.metrics, { servers_not_answering: 0, wiki_footprint_mb: 1500, restarts: 0 });
  assert.deepEqual(output.flagged?.map(item => item.kind), ["answer", "answer", "answer", "answer", "baseline", "baseline"]);
  assert.match(output.flagged![0]!.excerpt, /^wiki: GET http:\/\/localhost:5176\/ gave 200 in 0 ms$/);
  assert.deepEqual(state?.restarts.search?.restartTime, 2);
});

test("local dev uptime: a non-200, a network error and repeated restarts are flagged; a remote crawler is off by design", async () => {
  const previous = { restarts: { "llm-wiki": { restartTime: 0, at: NOW - 600_000 }, search: { restartTime: 2, at: NOW - 600_000 } } };
  const run = deps({ jlist: jlist(3, 4), footprintMb: 5000, env: { PUBLIC_CONVEX_URL: "http://127.0.0.1:3210", CRAWLER_API_URL: "https://crawler-staging.example.com" },
    answers: { "http://localhost:5174/": 502, "http://127.0.0.1:3210/version": new Error("connect ECONNREFUSED") } });
  const { output } = await measureUptime(run, previous);
  assert.deepEqual(output.metrics, { servers_not_answering: 2, wiki_footprint_mb: 5000, restarts: 5 });
  assert.ok(!run.urls.some(url => url.includes("crawler")));
  const kinds = output.flagged?.map(item => item.kind).sort();
  assert.deepEqual(kinds, ["answer", "by_design", "down", "down", "mac", "memory", "restarts", "restarts"]);
  assert.match(output.flagged!.find(item => item.kind === "mac")!.excerpt, /^Mac at the probe: load \{ 31\.2 25\.0 21\.0 \} total = 22528\.00M/);
});

test("local dev uptime: a 200 slower than 5 s counts as not answering", async () => {
  let clock = NOW;
  const run = deps({ jlist: jlist(0, 0) });
  const slowFetch = (async (url: string, init?: RequestInit) => {
    if (url !== "http://localhost:5176/") return run.fetch(url, init);
    clock += 1;
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("late")), 60_000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); clock += ANSWER_TIMEOUT_MS; reject(init.signal!.reason); });
    });
  }) as unknown as typeof fetch;
  const { output } = await measureUptime({ ...run, fetch: slowFetch, now: () => clock }, undefined);
  assert.equal(output.metrics.servers_not_answering, 1);
  assert.match(output.flagged!.find(item => item.kind === "down")!.excerpt, /^wiki: GET http:\/\/localhost:5176\/ gave .*after 5001 ms$/);
});

test("local dev uptime: pm2 down still reports every metric, and an encrypted env value is a down service", async () => {
  const { output, state } = await measureUptime(deps({ env: { PUBLIC_CONVEX_URL: "encrypted:abc" } }), undefined);
  assert.equal(output.metrics.servers_not_answering, 2);
  assert.equal(state, undefined);
  assert.equal(output.flagged?.filter(item => item.kind === "pm2").length, 1);
});

test("local dev uptime: tree pids, footprint sum and restart deltas", () => {
  const ps = "  100     1\n  200   100\n  300   200\n  301   200\n  400     1\n";
  assert.deepEqual(treePids(ps, 100).sort(), [100, 200, 300, 301]);
  assert.deepEqual(treePids(ps, 999), []);
  assert.equal(footprintMb("    phys_footprint: 1048576000 B\n    phys_footprint_peak: 1 B\n    phys_footprint: 209715200 B\n"), 1200);
  assert.equal(restartsSince(undefined, 88), 0);
  assert.equal(restartsSince({ restartTime: 80 }, 88), 8);
  assert.equal(restartsSince({ restartTime: 80 }, 3), 3, "a pm2 count that went down means pm2 started over");
});

test("env parsing and targets", () => {
  assert.deepEqual(parseEnv('A=1\nB="x y" # note\n# C=3\nD=http://127.0.0.1:3210 # local\n'), { A: "1", B: "x y", D: "http://127.0.0.1:3210" });
  assert.deepEqual(target({ key: "convex", envKey: "PUBLIC_CONVEX_URL", path: "/version" }, { PUBLIC_CONVEX_URL: "http://127.0.0.1:3210/" }), { url: "http://127.0.0.1:3210/version" });
});

test("local dev uptime duty file parses, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "local-dev-uptime.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "08:08" });
  const { output } = await measureUptime(deps({ jlist: jlist(0, 0) }), undefined);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});

test("add.ts stores each checked-in duty with its relative precheck cwd resolved to this component, so no duty file names a home path", async () => {
  const component = join(import.meta.dirname, "..");
  const dataDir = await mkdtemp(join(tmpdir(), "duty-add-"));
  try {
    for (const name of ["local-dev-uptime", "whole-system", "wiki-dream", "limits-evidence"]) {
      const file = join(component, "scripts", "duties", `${name}.duty.json`);
      assert.equal(JSON.parse(await readFile(file, "utf8")).precheck.cwd, "../..");
      await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", "chat1", file, "--data-dir", dataDir], { cwd: component });
    }
    const duties = await new DutyStore(dataDir).list("chat1");
    assert.deepEqual(duties.map(duty => duty.precheck.cwd), [component, component, component, component]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
