// Guards d7's 15:03Z minute on 10-24: the create of chat "disk trend page 2" took 32.9 s inside Prime, whose new worker read every saved session
// file to check the name, and d7 named the minute only as a slow daemon call. A create Prime took over 30 s on is a Prime fault, which the
// precheck names as its own cause (prime_fault_min_30); the minute stays dirty. ~/work/d7-slow-creates-1025/README.md has the measurements.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const LOG = [
  "2026-10-24T15:00:41.545Z daemon create disk trend page: refused in 2.2 s: Agent name \"disk trend page\" is unavailable: an agent of that name already exists at depth 0 under this parent",
  "2026-10-24T15:02:55.207Z daemon create disk trend page 2: answered in 32.9 s",
  "2026-10-24T15:03:29.180Z daemon create disk sampler: answered in 4.8 s",
  "2026-10-24T15:05:12.000Z daemon resume 01a16e6f: answered in 31.0 s",
];

test("a create Prime took over 30 s to answer is a Prime fault, and a slow resume is not", () => {
  const faults = readServiceFaults(LOG, "us-metal02");
  assert.deepEqual(faults.map(fault => `${fault.prime ? `prime (${fault.prime}) ` : ""}${fault.title ?? fault.session} ${fault.what}`), [
    "prime (a create Prime answered late) disk trend page 2 its create was answered in 32.9 s",
    "01a16e6f its resume was answered in 31 s",
  ]);
});

test("d7 names a dirty minute with a slow create as a Prime fault", () => {
  const RUN = Date.parse("2026-10-24T15:31:24Z");
  const start = Math.floor(RUN / 60_000) * 60_000 - 30 * 60_000;
  const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
  const watch = Array.from({ length: 30 }, (_, minute) => ({ host: "us-metal02", at: new Date(start + minute * 60_000 + 30_000).toISOString(), usable: box,
    workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0 }) as WatchLine);
  const out = measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults: readServiceFaults(LOG.slice(0, 3), "us-metal02") });
  assert.equal(out.metrics.clean_min_30, 29);
  assert.equal(out.metrics.prime_fault_min_30, 1);
  const dirty = out.flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /^15:03Z a Prime fault, a create Prime answered late: daemon calls failed or ran over 30 s for disk trend page 2 /);
});
