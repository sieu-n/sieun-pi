// Guards d1's Mac metrics: mac_servers_not_answering from ssh, and mac_unusable_min from the Mac usable watch, which replaced the one-sample
// load-under-20 check on 10-23 (~/work/mac-load-root-cause/metric-findings.md on us-metal02). Vent :8791 and the crawler API :8787 joined the servers on 10-27, and
// mac_convex_push_stale reads the Mac's Convex watcher, whose pushes all failed from 10-22 to 10-27 while its status read healthy.
// store_box_swap_used_mb joined on 10-27, after the M2 Air store box reached 8.5 GB of swap and local Convex schema evals passed 1 s.
// convex_push_stale reads us-metal02's own watcher, whose pushes all failed from 10-24 to 10-27 while a retry kept its newest push at running.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { convexCommand, convexPushStale, LOCAL_CONVEX_COMMAND, MAC_COMMAND, measureLocalConvex, MAC_RETRY_MS, MAC_WINDOW_MS, macDown, macUnusableMinutes, measureMac, measureStoreBox, parseConvexReading, parseMacReading, parseStoreBox, STORE_BOX, STORE_COMMAND } from "../scripts/duties/local-dev-uptime.ts";

const push = (outcome: string, at: string, lastGoodAt: string | null) =>
  `convex-push {  "count": 1,  "watchers": [],  "push": {    "outcome": "${outcome}",    "at": "${at}",    "reason": ${outcome === "failed" ? '"schema eval timed out (1s)"' : "null"},    "lastGoodAt": ${lastGoodAt ? `"${lastGoodAt}"` : "null"}  }}\n`;
const reading = (load: string, free: number, codes: [string, string, string?, string?], convex = push("ok", "2026-10-28T02:44:38", "2026-10-28T02:44:38") + "convex-src 2026-10-28T02:40:00\n") =>
  `{ ${load} 6.95 7.77 }\nThe system has 34359738368 (2097152 pages with a page size of 16384).\nSystem-wide memory free percentage: ${free}%\nport 5174 ${codes[0]}\nport 5180 ${codes[1]}\nport 8791 ${codes[2] ?? "200"}\nport 8787 ${codes[3] ?? "200"}\n${convex}`;
const minute = (kernelTaskPct: number, swapoutsPerS = 0, at = "2026-10-23T04:39:00.000Z"): WatchLine => ({ host: "us-metal02", at, usable: null, workers: 0, workerGb: 0, top: [],
  hosts: [{ name: "mac", usable: { pressureLevel: 1, swapoutsPerS, kernelTaskPct }, workers: 0, workerGb: 0, top: [] }] } as unknown as WatchLine);

test("parses load, free memory and each dev server's code", () => {
  assert.deepEqual(parseMacReading(reading("7.26", 37, ["200", "200"], "")), { load1: 7.26, freePct: 37, ports: { 5174: "200", 5180: "200", 8791: "200", 8787: "200" } });
  assert.throws(() => parseMacReading("ssh banner only\n"), /unparsed Mac reading/);
});

test("a high load is detail, and only a dev server with no 200 counts", () => {
  assert.deepEqual(macDown(parseMacReading(reading("38.59", 43, ["200", "200"]))), []);
  assert.deepEqual(macDown(parseMacReading(reading("7.26", 37, ["200", "000"]))), ["design demo :5180 gave no answer"]);
});

test("Vent :8791 is probed on /healthz, and a Vent with no answer counts as a server down", () => {
  assert.match(MAC_COMMAND, /http:\/\/localhost:8791\/healthz/);
  assert.match(MAC_COMMAND, /http:\/\/localhost:5174\/;/);
  assert.deepEqual(macDown(parseMacReading(reading("7.26", 37, ["200", "200", "000"]))), ["Vent :8791 gave no answer"]);
});

test("the crawler API :8787 is probed on /health, and a crawler with no 200 counts as a server down", () => {
  assert.match(MAC_COMMAND, /http:\/\/localhost:8787\/health;/);
  assert.deepEqual(macDown(parseMacReading(reading("7.26", 37, ["200", "200", "200", "000"]))), ["crawler API :8787 gave no answer"]);
});

test("the Convex push is stale only when the newest push failed and no good push came after the newest convex/ change", () => {
  const stale = (convex: string) => convexPushStale(parseMacReading(reading("7.26", 37, ["200", "200"], convex)))?.stale;
  assert.equal(stale(push("ok", "2026-10-28T02:44:38", "2026-10-28T02:44:38") + "convex-src 2026-10-28T02:50:00\n"), false);
  assert.equal(stale(push("failed", "2026-10-27T09:00:00", "2026-10-23T02:49:00") + "convex-src 2026-10-27T08:59:58\n"), true);
  assert.equal(stale(push("failed", "2026-10-27T09:00:00", null) + "convex-src 2026-10-27T08:59:58\n"), true);
  assert.equal(stale(push("failed", "2026-10-27T09:00:00", "2026-10-27T08:00:00") + "convex-src 2026-10-27T07:00:00\n"), false);
  assert.equal(stale(push("running", "2026-10-27T09:00:00", "2026-10-23T02:49:00") + "convex-src 2026-10-27T08:59:58\n"), false);
  assert.equal(stale("convex-push \nconvex-src 2026-10-27T08:59:58\n"), undefined);
  assert.equal(stale("convex-push {not json\nconvex-src \n"), undefined);
});

test("counts the watched minutes that read unusable, by cause", () => {
  assert.deepEqual(macUnusableMinutes([minute(25, 0, "2026-10-23T04:39:30.000Z"), minute(123, 11971, "2026-10-23T04:40:30.000Z"), minute(108, 0, "2026-10-23T04:41:30.000Z")]),
    { read: 3, unusable: 2, by: { swapouts: 1, kernel_task: 2 }, lastAt: Date.parse("2026-10-23T04:41:30.000Z") });
});

test("two watch lines in one clock minute count as one minute, as at 20:16:10Z and 20:16:30Z on 10-27", () => {
  assert.deepEqual(macUnusableMinutes([minute(94, 10758, "2026-10-27T20:16:10.870Z"), minute(114, 4364, "2026-10-27T20:16:30.013Z"), minute(25, 0, "2026-10-27T20:17:30.000Z")]),
    { read: 2, unusable: 1, by: { swapouts: 1, kernel_task: 1 }, lastAt: Date.parse("2026-10-27T20:16:30.013Z") });
});

test("mac_unusable_min reports its 24 h window and its newest unusable minute, so d9 reads old red minutes as a lagging window", async () => {
  const deps = { platform: "linux", exec: async () => reading("7.26", 37, ["200", "200"]), wait: async () => {} } as const;
  const red = await measureMac({ ...deps, watch: async () => [minute(113, 0, "2026-10-28T01:17:30.013Z"), minute(98, 10969, "2026-10-28T03:13:30.038Z"), minute(40, 0, "2026-10-28T06:24:30.000Z")] }, 0);
  assert.equal(red.metrics.mac_unusable_min, 2);
  assert.deepEqual({ lastEventAt: red.lastEventAt, windowMs: red.windowMs }, { lastEventAt: { mac_unusable_min: Date.parse("2026-10-28T03:13:30.038Z") }, windowMs: { mac_unusable_min: MAC_WINDOW_MS } });
  const clean = await measureMac({ ...deps, watch: async () => [minute(40)] }, 0);
  assert.deepEqual({ lastEventAt: clean.lastEventAt, windowMs: clean.windowMs }, { lastEventAt: undefined, windowMs: { mac_unusable_min: MAC_WINDOW_MS } });
});

test("a Mac ssh cannot reach is unreachable, and its watched minutes still count", async () => {
  const asleep = Object.assign(new Error("Command failed: ssh mac"), { code: 255 });
  const result = await measureMac({ platform: "linux", exec: async () => { throw asleep; }, watch: async () => [minute(25)], wait: async () => {} }, 0);
  assert.deepEqual(result.metrics, { mac_unusable_min: 0, mac_unreachable: 1 });
  const awake = await measureMac({ platform: "linux", exec: async () => reading("38.59", 43, ["200", "000"]), watch: async () => [minute(25), minute(140)], wait: async () => {} }, 0);
  assert.deepEqual(awake.metrics, { mac_unusable_min: 1, mac_servers_not_answering: 1, mac_unreachable: 0, mac_convex_push_stale: 0 });
  const failing = await measureMac({ platform: "linux", exec: async () => reading("7.26", 37, ["200", "200"], push("failed", "2026-10-27T09:00:00", "2026-10-23T02:49:00") + "convex-src 2026-10-27T08:59:58\n"), watch: async () => [], wait: async () => {} }, 0);
  assert.deepEqual(failing.metrics, { mac_servers_not_answering: 0, mac_unreachable: 0, mac_convex_push_stale: 1 });
  assert.match(failing.flagged.find(item => item.kind === "mac_convex_stale")!.excerpt, /newest push failed at 2026-10-27T09:00:00: schema eval timed out \(1s\), last good push 2026-10-23T02:49:00/);
  const unread = await measureMac({ platform: "linux", exec: async () => reading("7.26", 37, ["200", "200"], "convex-push \n"), watch: async () => [], wait: async () => {} }, 0);
  assert.deepEqual(unread.metrics, { mac_servers_not_answering: 0, mac_unreachable: 0 });
});

test("a dev server that answers on the read 30 s later, as :5180 does after a pm2 restart, is no miss", async () => {
  const codes: [string, string][] = [["200", "000"], ["200", "200"]];
  const waits: number[] = [];
  const result = await measureMac({ platform: "linux", exec: async () => reading("7.26", 37, codes.shift()!), watch: async () => [], wait: async ms => { waits.push(ms); } }, 0);
  assert.deepEqual(result.metrics, { mac_servers_not_answering: 0, mac_unreachable: 0, mac_convex_push_stale: 0 });
  assert.deepEqual(waits, [MAC_RETRY_MS]);
});

const store = (used: string, level: number) => `total = 9216.00M  used = ${used}M  free = 690.56M  (encrypted)\n${level}\ncom.docker.krun  7995M 6458M\nsandboxd         5424M 5420M\nSystem Events    1186M 1184M\n`;

test("parses the store box's swap use, pressure level and top processes", () => {
  assert.deepEqual(parseStoreBox(store("8525.44", 2)), { swapUsedMb: 8525, pressureLevel: 2, top: ["com.docker.krun 7995M 6458M", "sandboxd 5424M 5420M", "System Events 1186M 1184M"] });
  assert.throws(() => parseStoreBox("Permission denied\n"), /unparsed store box reading/);
});

test("the store box over its swap line is flagged, under it is detail, and an unreachable box leaves the metric unmeasured", async () => {
  const calls: string[][] = [];
  const full = await measureStoreBox({ exec: async (file, args) => { calls.push([file, ...args]); return store("8525.44", 2); } }, 0);
  assert.deepEqual(calls, [["ssh", "-o", "BatchMode=yes", STORE_BOX, STORE_COMMAND]]);
  assert.deepEqual(full.metrics, { store_box_swap_used_mb: 8525 });
  assert.equal(full.flagged[0]!.kind, "store_box_swap");
  assert.match(full.flagged[0]!.excerpt, /8525 MB swap used, over the 6000 MB line.*memory pressure warn, top com.docker.krun 7995M 6458M; sandboxd/);
  const freed = await measureStoreBox({ exec: async () => store("1431.06", 2) }, 0);
  assert.deepEqual(freed.metrics, { store_box_swap_used_mb: 1431 });
  assert.equal(freed.flagged[0]!.kind, "store_box");
  const away = await measureStoreBox({ exec: async () => { throw Object.assign(new Error("Command failed: ssh"), { code: 255 }); } }, 0);
  assert.deepEqual(away.metrics, {});
  assert.equal(away.flagged[0]!.kind, "store_box_unreachable");
});

const localPush = (push: Record<string, string | null>, src: string) => `convex-push {"count": 1, "watchers": [], "push": ${JSON.stringify(push)}}\nconvex-src ${src}\n`;

test("this host's watcher is stale while a retry runs after a failed push and no push succeeded after the newest convex/ change", async () => {
  const calls: string[][] = [];
  const read = (text: string) => measureLocalConvex({ platform: "linux", exec: async (file, args) => { calls.push([file, ...args]); return text; } }, 0);
  const retrying = await read(localPush({ outcome: "running", at: "2026-10-27T20:37:13", reason: "Schema validation failed.", lastGoodAt: "2026-10-24T07:24:28", lastFailedAt: "2026-10-27T20:37:13" }, "2026-10-27T20:30:00"));
  assert.deepEqual(calls[0], ["sh", "-c", LOCAL_CONVEX_COMMAND]);
  assert.deepEqual(retrying.metrics, { convex_push_stale: 1 });
  assert.equal(retrying.flagged[0]!.kind, "convex_stale");
  assert.match(retrying.flagged[0]!.excerpt, /newest push running at 2026-10-27T20:37:13 after a push failed at 2026-10-27T20:37:13: Schema validation failed\., last good push 2026-10-24T07:24:28/);
  const healed = await read(localPush({ outcome: "running", at: "2026-10-27T20:41:04", reason: null, lastGoodAt: "2026-10-27T20:41:03", lastFailedAt: "2026-10-27T20:39:32" }, "2026-10-27T20:30:00"));
  assert.deepEqual(healed.metrics, { convex_push_stale: 0 });
  const unread = await read("convex-push \nconvex-src \n");
  assert.deepEqual(unread.metrics, {});
  assert.equal(unread.flagged[0]!.kind, "convex_read");
  assert.deepEqual(await measureLocalConvex({ platform: "darwin", exec: async () => { throw new Error("not called"); } }, 0), { metrics: {}, flagged: [] });
});

test("the local read lists GNU find mtimes cut to the pm2 stamp's 19 characters", () => {
  assert.match(LOCAL_CONVEX_COMMAND, /scripts\/repo\/agent\/convex-watcher\.mjs status --json/);
  assert.match(LOCAL_CONVEX_COMMAND, /-printf '%TY-%Tm-%TdT%TT\\n' \| cut -c1-19 \| sort \| tail -1/);
});

test("the shell line keeps a failed push's multi-line reason on one convex-push line", () => {
  const repo = mkdtempSync(join(tmpdir(), "d1-convex-"));
  try {
    mkdirSync(join(repo, "scripts/repo/agent"), { recursive: true });
    mkdirSync(join(repo, "convex"));
    writeFileSync(join(repo, "convex/a.ts"), "");
    const status = { push: { outcome: "running", at: "2026-10-28T07:19:41", reason: "TypeScript typecheck via `tsc` failed.\nconvex/x.ts:1:1 - error", lastGoodAt: "2026-10-28T07:16:44", lastFailedAt: "2026-10-28T07:18:18" } };
    writeFileSync(join(repo, "scripts/repo/agent/convex-watcher.mjs"), `console.log(${JSON.stringify(JSON.stringify(status, null, 2))});`);
    const text = execFileSync("/bin/sh", ["-c", convexCommand(process.execPath, repo, "-printf '%TY-%Tm-%TdT%TT\\n' | cut -c1-19")], { encoding: "utf8" });
    const parsed = parseConvexReading(text);
    assert.deepEqual(parsed.convexPush, status.push);
    assert.match(parsed.convexSrc ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
