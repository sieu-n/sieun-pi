// Guards d7's 13:54Z minute on 10-23: fresh Prime worker 0fd0ae876b09 segfaulted in Bun 5.7 s after it started, the create routed to it failed
// 1.4 s later with "Daemon worker socket closed", and d7 named the minute only as a failed create. A worker crash is a Prime fault, which the
// precheck names as its own cause (prime_fault_min_30); the minute stays dirty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readSupervisorFaults } from "../src/daemon-faults.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const CRASH_LOG = [
  "[2026-10-23T13:54:27.446Z] supervisor: Session worker 0fd0ae876b09 stderr: Prime Agent daemon listening on /tmp/prime-agent-1001/worker-ee92e1d8c39e-0fd0ae876b09.sock",
  "[2026-10-23T13:54:32.813Z] supervisor: Session worker 0fd0ae876b09 stderr: Bun v1.4.0 (34cbb9a40) Linux x64",
  "[2026-10-23T13:54:32.814Z] supervisor: Session worker 0fd0ae876b09 stderr: RSS: 0.45 GB | Peak: 8.0 GB | Commit: 1.11 GB | Faults: 0 | Machine: 0.27 TB",
  "[2026-10-23T13:54:32.814Z] supervisor: Session worker 0fd0ae876b09 stderr: panic(main thread): Segmentation fault at address 0x24459353BD6",
  "[2026-10-23T13:54:32.815Z] supervisor: Session worker 0fd0ae876b09 stderr: oh no: Bun has crashed. This indicates a bug in Bun, not your code.",
  "[2026-10-23T13:54:34.212Z] supervisor: Supervisor command create failed: Error: Daemon worker socket closed",
];

test("a Bun panic in a worker's stderr is a Prime worker crash beside the create it failed", () => {
  const faults = readSupervisorFaults(CRASH_LOG, "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.prime ? "prime " : ""}${fault.what}`), [
    "prime Prime worker 0fd0ae876b09 crashed in Bun, panic on its main thread: Segmentation fault at address 0x24459353BD6",
    "the supervisor's create failed, its worker's connection closed",
  ]);
});

test("d7 names a dirty minute with a Prime worker crash as a Prime fault", () => {
  const RUN = Date.parse("2026-10-23T14:23:25Z");
  const start = Math.floor(RUN / 60_000) * 60_000 - 30 * 60_000;
  const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
  const watch = Array.from({ length: 30 }, (_, minute) => ({ host: "us-metal02", at: new Date(start + minute * 60_000 + 30_000).toISOString(), usable: box,
    workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0 }) as WatchLine);
  const out = measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults: readSupervisorFaults(CRASH_LOG, "us-metal02") });
  assert.equal(out.metrics.clean_min_30, 29);
  assert.equal(out.metrics.prime_fault_min_30, 1);
  const dirty = out.flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /^13:54Z a Prime fault, a worker crashed: /);
});
