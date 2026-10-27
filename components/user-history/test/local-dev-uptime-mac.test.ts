// Guards d1's Mac metrics: mac_servers_not_answering from ssh, and mac_unusable_min from the Mac usable watch, which replaced the one-sample
// load-under-20 check on 10-23 (~/work/mac-load-root-cause/metric-findings.md on us-metal02). Vent :8791 and the crawler API :8787 joined the servers on 10-27, and
// mac_convex_push_stale reads the Mac's Convex watcher, whose pushes all failed from 10-22 to 10-27 while its status read healthy.
// store_box_swap_used_mb joined on 10-27, after the M2 Air store box reached 8.5 GB of swap and local Convex schema evals passed 1 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { convexPushStale, MAC_COMMAND, MAC_RETRY_MS, macDown, macUnusableMinutes, measureMac, measureStoreBox, parseMacReading, parseStoreBox, STORE_BOX, STORE_COMMAND } from "../scripts/duties/local-dev-uptime.ts";

const push = (outcome: string, at: string, lastGoodAt: string | null) =>
  `convex-push {  "count": 1,  "watchers": [],  "push": {    "outcome": "${outcome}",    "at": "${at}",    "reason": ${outcome === "failed" ? '"schema eval timed out (1s)"' : "null"},    "lastGoodAt": ${lastGoodAt ? `"${lastGoodAt}"` : "null"}  }}\n`;
const reading = (load: string, free: number, codes: [string, string, string?, string?], convex = push("ok", "2026-10-28T02:44:38", "2026-10-28T02:44:38") + "convex-src 2026-10-28T02:40:00\n") =>
  `{ ${load} 6.95 7.77 }\nThe system has 34359738368 (2097152 pages with a page size of 16384).\nSystem-wide memory free percentage: ${free}%\nport 5174 ${codes[0]}\nport 5180 ${codes[1]}\nport 8791 ${codes[2] ?? "200"}\nport 8787 ${codes[3] ?? "200"}\n${convex}`;
const minute = (kernelTaskPct: number, swapoutsPerS = 0): WatchLine => ({ host: "us-metal02", at: "2026-10-23T04:39:00.000Z", usable: null, workers: 0, workerGb: 0, top: [],
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
  assert.deepEqual(macUnusableMinutes([minute(25), minute(123, 11971), minute(108)]), { read: 3, unusable: 2, by: { swapouts: 1, kernel_task: 2 } });
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
