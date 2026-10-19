// Guards d7's 14:12Z minute on 10-19: a release stopped the chat service at 14:12:29Z while the Mac's relay read was out, the stop wrote the Mac
// unread (UNREAD_AT_STOP), and the minute read unknown though the Mac read usable at 14:11:30Z and 14:13:30Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { UNREAD_AT_STOP, type WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-19T14:30:10Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const mac = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 };
const line = (minute: number, macRead: "usable" | "stop" | "dead"): WatchLine => ({ host: "us-metal02",
  at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: macRead === "usable" ? mac : null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null,
    ...macRead === "usable" ? {} : { error: macRead === "stop" ? UNREAD_AT_STOP : "relay mac did not answer in 10000 ms" } }] } as WatchLine);

test("a box written unread by a service stop reads usable when the lines before and after read it usable", () => {
  const watch = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 12 ? "stop" : "usable"));
  assert.equal(measure({ now: RUN, watch, log: { holds: [] }, chats: [] }).metrics.clean_min_30, 30);
});

test("a relay that did not answer, or a stop next to a minute the box went unread, still reads unknown", () => {
  const dead = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 12 ? "dead" : "usable"));
  assert.equal(measure({ now: RUN, watch: dead, log: { holds: [] }, chats: [] }).metrics.clean_min_30, 29);
  const twice = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 12 ? "stop" : minute === 13 ? "dead" : "usable"));
  assert.equal(measure({ now: RUN, watch: twice, log: { holds: [] }, chats: [] }).metrics.clean_min_30, 28);
});
