// Guards d7's 22:16Z minute on 11-01: the supervisor answered no call from 22:16:36Z to 22:16:55Z while it serialized 350 MB of passive
// schedule rows, and the outbox's send_message to rg37-convex timed out at 30 s. d7 booked the minute on the box's CPU and read 0 Prime faults.
// From load.3.9-test.20 the supervisor logs its own stall, and a call whose wait overlapped one is a Prime fault.
// ~/work/d7-send-timeout-rg37-1102/README.md has the measurements.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { blameSupervisorStalls, readServiceFaults, readSupervisorStalls } from "../src/daemon-faults.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const SERVICE = [
  "2026-11-01T22:16:59.770Z outbox 01a19888: m-6a66c309-b59b-4c1f-a181-ddbc5369673a try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock",
  "2026-11-01T22:40:10.000Z outbox 01a19921: m-11111111-2222-3333-4444-555555555555 try 1 (may have gone): Timed out after 30000ms waiting for the Prime Agent daemon response to \"send_message\". Socket: /tmp/prime-agent-1001/daemon.sock",
];
const SUPERVISOR = [
  "[2026-11-01T22:16:33.603Z] supervisor: event loop stalled 19300 ms since 2026-11-01T22:16:14.053Z",
  "[2026-11-01T22:16:55.114Z] supervisor: event loop stalled 18700 ms since 2026-11-01T22:16:36.164Z",
  "[2026-11-01T22:16:55.200Z] supervisor: Session worker 69753e0d21ba stderr: event loop stalled 6000 ms since 2026-11-01T22:16:49.000Z",
];

test("a send whose wait overlapped a supervisor stall is a Prime fault, and one outside any stall is not", () => {
  const stalls = readSupervisorStalls(SUPERVISOR);
  assert.equal(stalls.length, 2);
  const faults = blameSupervisorStalls(readServiceFaults(SERVICE, "us-metal02"), stalls, "us-metal02");
  assert.deepEqual(faults.map(fault => [fault.session, fault.prime]), [
    ["01a19888", "the supervisor's event loop stalled 19 s"],
    ["01a19921", undefined],
  ]);
  assert.equal(blameSupervisorStalls(readServiceFaults(SERVICE, "us-metal02"), stalls, "mac")[0]!.prime, undefined);
});

test("d7 names the 22:16Z minute as a Prime fault", () => {
  const RUN = Date.parse("2026-11-01T22:24:02Z");
  const start = Math.floor(RUN / 60_000) * 60_000 - 30 * 60_000;
  const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
  const watch = Array.from({ length: 30 }, (_, minute) => ({ host: "us-metal02", at: new Date(start + minute * 60_000 + 30_000).toISOString(), usable: box,
    workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0 }) as WatchLine);
  const daemonFaults = blameSupervisorStalls(readServiceFaults(SERVICE.slice(0, 1), "us-metal02"), readSupervisorStalls(SUPERVISOR), "us-metal02");
  const out = measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults });
  assert.equal(out.metrics.clean_min_30, 29);
  assert.equal(out.metrics.prime_fault_min_30, 1);
  const dirty = out.flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /^22:16Z a Prime fault, the supervisor's event loop stalled 19 s: daemon calls failed or ran over 30 s for /);
});
