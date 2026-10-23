// Guards d1's Mac metrics: mac_servers_not_answering from ssh, and mac_unusable_min from the Mac usable watch, which replaced the one-sample
// load-under-20 check on 10-23 (~/work/mac-load-root-cause/metric-findings.md on us-metal02).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { macDown, macUnusableMinutes, measureMac, parseMacReading } from "../scripts/duties/local-dev-uptime.ts";

const reading = (load: string, free: number, codes: [string, string]) =>
  `{ ${load} 6.95 7.77 }\nThe system has 34359738368 (2097152 pages with a page size of 16384).\nSystem-wide memory free percentage: ${free}%\nport 5174 ${codes[0]}\nport 5180 ${codes[1]}\n`;
const minute = (kernelTaskPct: number, swapoutsPerS = 0): WatchLine => ({ host: "us-metal02", at: "2026-10-23T04:39:00.000Z", usable: null, workers: 0, workerGb: 0, top: [],
  hosts: [{ name: "mac", usable: { pressureLevel: 1, swapoutsPerS, kernelTaskPct }, workers: 0, workerGb: 0, top: [] }] } as unknown as WatchLine);

test("parses load, free memory and each dev server's code", () => {
  assert.deepEqual(parseMacReading(reading("7.26", 37, ["200", "200"])), { load1: 7.26, freePct: 37, ports: { 5174: "200", 5180: "200" } });
  assert.throws(() => parseMacReading("ssh banner only\n"), /unparsed Mac reading/);
});

test("a high load is detail, and only a dev server with no 200 counts", () => {
  assert.deepEqual(macDown(parseMacReading(reading("38.59", 43, ["200", "200"]))), []);
  assert.deepEqual(macDown(parseMacReading(reading("7.26", 37, ["200", "000"]))), ["design demo :5180 gave no answer"]);
});

test("counts the watched minutes that read unusable, by cause", () => {
  assert.deepEqual(macUnusableMinutes([minute(25), minute(123, 11971), minute(108)]), { read: 3, unusable: 2, by: { swapouts: 1, kernel_task: 2 } });
});

test("a Mac ssh cannot reach is unreachable, and its watched minutes still count", async () => {
  const asleep = Object.assign(new Error("Command failed: ssh mac"), { code: 255 });
  const result = await measureMac({ platform: "linux", exec: async () => { throw asleep; }, watch: async () => [minute(25)] }, 0);
  assert.deepEqual(result.metrics, { mac_unusable_min: 0, mac_unreachable: 1 });
  const awake = await measureMac({ platform: "linux", exec: async () => reading("38.59", 43, ["200", "000"]), watch: async () => [minute(25), minute(140)] }, 0);
  assert.deepEqual(awake.metrics, { mac_unusable_min: 1, mac_servers_not_answering: 1, mac_unreachable: 0 });
});
