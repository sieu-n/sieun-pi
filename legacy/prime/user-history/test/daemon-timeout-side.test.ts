// A CPU minute whose only harness slowness is daemon calls that timed out is the harness's, whoever used the most cores. From 15:09Z to 15:19Z
// on 11-13 the Prime supervisor held send_message calls 30 s and more behind a herd of `prime-agent list --all --json` reads (16 to 23 starts a
// minute, up to 139 in flight), and d7 booked those minutes on CI's side for its 35 to 47 of 80 cores, though the same CI level read clean
// for most of the afternoon. The fixture is the 15:11Z minute: its usable watch line and the four outbox timeouts service.log wrote in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { measure } from "../scripts/duties/whole-system.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-11-13T15:34:10Z");
const START = Date.parse("2026-11-13T15:04:00Z");
const usable: LinuxUsable = { kind: "linux", memSomeAvg10: 1.61, memFullAvg10: 0.79, cpuSomeAvg10: 73.58, swapoutsPerS: 568, runnablePerCore: 4.47,
  allowedCpus: 80, cpuCores: { harness: 31.78, apps: 7.39, owner: 0, ci: 38.48, system: 0.64 } };
const chat = { readMs: 63, read: "api/agent/siblings", loopMs: 173, gcMs: 37, gc: "minor" as const, poolMs: 65 };
const line = (minute: number, latency: NonNullable<WatchLine["chat"]> = chat): WatchLine => ({
  at: new Date(START + minute * 60_000 + 30_023).toISOString(), host: "us-metal02", usable, workers: 29, workerGb: 27.5, top: [], live: 44, working: 25,
  queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0, chat: latency });
const watch = (): WatchLine[] => Array.from({ length: 30 }, (_, minute) => line(minute));
// service.log on us-metal02, 15:11Z on 11-13.
const LOG = [
  "2026-11-13T15:11:16.286Z outbox 01a1d549: m-2bf2ec3d-d072-46cc-bdc0-78f02f3d43bf try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock",
  "2026-11-13T15:11:42.013Z outbox 01a05c09: m-3ff81c1d-6950-4b25-83a6-30b541d7838e try 146 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock",
  "2026-11-13T15:11:43.710Z outbox 230bbdbf: m-9d348172-6137-4042-83f7-af5ee3d21a92 try 2699 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock",
  "2026-11-13T15:11:52.012Z outbox 01a1d549: m-2bf2ec3d-d072-46cc-bdc0-78f02f3d43bf try 2 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock"];

test("the 15:11Z minute, dirty only from timed-out daemon sends, is the harness's though CI led its cores", () => {
  const daemonFaults = readServiceFaults(LOG, "us-metal02");
  assert.equal(daemonFaults.length, 4);
  const { metrics, flagged } = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [], daemonFaults });
  assert.equal(metrics.clean_min_30, 29);
  assert.equal(metrics.harness_unusable_min_30, 1);
  assert.equal(metrics.ci_unusable_min_30, 0);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /15:11Z us-metal02 unusable \(cpu: 4 sends or wakes timed out; CI 38\.48 of 80 cores/, "the flag still names CI's cores");
});

test("a loop stall with no major GC beside the timeouts keeps the minute with the cores", () => {
  const daemonFaults = readServiceFaults(LOG, "us-metal02");
  const lines = watch().map((watched, minute) => minute === 7 ? line(7, { ...chat, loopMs: 1400, gcMs: 125 }) : watched);
  const { metrics } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [], daemonFaults });
  assert.equal(metrics.ci_unusable_min_30, 1);
  assert.equal(metrics.harness_unusable_min_30, 0);
});
