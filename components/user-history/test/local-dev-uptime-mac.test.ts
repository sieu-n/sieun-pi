// Guards d1's mac_checks_failing, which took over plan goal p53 on 10-19: the precheck gave no value for it at 15:09Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { macFailures, measureMac, parseMacReading } from "../scripts/duties/local-dev-uptime.ts";

const reading = (load: string, free: number, codes: [string, string]) =>
  `{ ${load} 6.95 7.77 }\nThe system has 34359738368 (2097152 pages with a page size of 16384).\nSystem-wide memory free percentage: ${free}%\nport 5174 ${codes[0]}\nport 5180 ${codes[1]}\n`;

test("parses load, free memory and each dev server's code", () => {
  assert.deepEqual(parseMacReading(reading("7.26", 37, ["200", "200"])), { load1: 7.26, freePct: 37, ports: { 5174: "200", 5180: "200" } });
  assert.throws(() => parseMacReading("ssh banner only\n"), /unparsed Mac reading/);
});

test("names each failing check in plain words", () => {
  assert.deepEqual(macFailures(parseMacReading(reading("7.26", 37, ["200", "200"]))), []);
  assert.deepEqual(macFailures(parseMacReading(reading("24.5", 12, ["200", "000"]))),
    ["load 24.5 is not under 20", "12% memory free is under 30%", "dev servers not answering 200: design demo :5180 gave no answer"]);
});

test("a Mac ssh cannot reach is unreachable, not failing", async () => {
  const asleep = Object.assign(new Error("Command failed: ssh mac"), { code: 255 });
  const result = await measureMac({ platform: "linux", exec: async () => { throw asleep; } }, 0);
  assert.deepEqual(result.metrics, { mac_unreachable: 1 });
  const awake = await measureMac({ platform: "linux", exec: async () => reading("21", 40, ["200", "200"]) }, 0);
  assert.deepEqual(awake.metrics, { mac_checks_failing: 1, mac_unreachable: 0 });
});
