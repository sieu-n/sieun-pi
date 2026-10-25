// Replays 01:49Z to 02:20Z on 10-25 on us-metal02, the run d7 flagged at 02:19:52Z with clean_min_30 at 26. Prime worker a0bc1b3cb58e
// (pid 2403602, the one worker of "dev branch skipped alert") sent no frame from about 02:00:56Z, grew from 0.65 to 24.3 GB, and the
// supervisor killed it at 02:03:56Z. Each cron_list poll from the chat in that span waited its 5 s for that one worker while the other 59
// answered, and the chat read pages in about 60 ms. d7 booked the four minutes as "cpu: N worker polls went unanswered" on the apps' side.
// The watch lines keep only the hung worker in byWorker and the first 3 waiting trees of each queue; the daemon lines are verbatim.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readSupervisorFaults, readWorkerHangs } from "../src/daemon-faults.ts";
import { workerMisses } from "../src/harness-slow.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const watch = fixture("worker-hang-1025-0200.watch.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line) as WatchLine);
const daemon = fixture("worker-hang-1025-0200.daemon.txt").split("\n").filter(Boolean);
const RUN = Date.parse("2026-10-25T02:19:52.491Z");

test("the supervisor's kill of a hung worker reads as one hang from its last frame", () => {
  assert.deepEqual(readWorkerHangs(daemon), [{ worker: "a0bc1b3cb58e", pid: 2403602, from: Date.parse("2026-10-25T02:00:56.627Z"), to: Date.parse("2026-10-25T02:03:56.627Z") }]);
  assert.deepEqual(workerMisses(daemon), [], "all 7 cron_list misses fall inside the hang");
});

test("d7 books 02:00Z to 02:03Z on 10-25 as a hung Prime worker, not CPU lag on the apps' side", () => {
  const { metrics, flagged } = measure({ now: RUN, watch, log: { holds: [] }, chats: [], workerMisses: workerMisses(daemon),
    daemonFaults: readSupervisorFaults(daemon, "us-metal02") });
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.equal(metrics.clean_min_30, 26, "the worker answered nothing in 4 minutes, so they stay dirty");
  assert.equal(metrics.prime_fault_min_30, 4);
  assert.equal(metrics.other_unusable_min_30, 0, "no minute goes to the apps' side for the CI and app cores");
  assert.doesNotMatch(dirty, /worker polls? went unanswered/);
  for (const minute of ["02:00Z", "02:01Z", "02:02Z", "02:03Z"]) {
    assert.match(dirty, new RegExp(`${minute} a Prime fault, a worker hung: daemon calls failed or ran over 30 s for dev branch skipped alert on us-metal02 \\(Prime worker a0bc1b3cb58e sent nothing for 180 s until the supervisor killed it, after it grew from 0\\.65 to 24\\.3 GB\\)`));
  }
});

test("a hung worker makes its minutes dirty on a box that is not CPU-busy too", () => {
  const idle = watch.map((line): WatchLine => line.usable && "runnablePerCore" in line.usable ? { ...line, usable: { ...line.usable, runnablePerCore: 0.3, cpuSomeAvg10: 2 } } : line);
  const { metrics } = measure({ now: RUN, watch: idle, log: { holds: [] }, chats: [], workerMisses: workerMisses(daemon),
    daemonFaults: readSupervisorFaults(daemon, "us-metal02") });
  assert.equal(metrics.prime_fault_min_30, 4);
  assert.equal(metrics.clean_min_30, 26);
});
