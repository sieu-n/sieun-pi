// Guards the Linux CPU reading of the Whole system duty (d7) on us-metal02: every harness unit there runs on 32 of the box's 80 CPUs, with
// libvirt VMs on the other 48, and at 05:10Z on 10-18 the 1-minute loadavg over all 80 read 0.27 a core while the harness's 32 ran 0.45.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { test } from "node:test";
import { linuxUsable, parseCpusAllowed, parseSchedstat, runnablePerCore } from "../../prime-relay/host-stats.ts";
import { parseLinuxReading, parseUsableRaw, unusable } from "../src/mac-usable-watch.ts";

// The harness's CPU set on us-metal02 from /proc/<pid>/status, the same for prime-agent-daemon, sieun-pi-chat, pi-pool-serve and prime-relay.
const METAL_CPUS = "9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39,49,51,53,55,57,59,61,63,65,67,69,71,73,75,77,79";
// /proc/schedstat lines from us-metal02 at 05:12Z on 10-18; fields 1 to 6 read 0 there because kernel.sched_schedstats is off.
const SCHEDSTAT = ["version 17", "timestamp 4584167112", "cpu9 0 0 0 0 0 0 2814401489253 34470168093 23551202",
  "cpu10 0 0 0 0 0 0 1915252928162 18653768941 6442781", "cpu11 0 0 0 0 0 0 2956653641743 27833818595 23096819",
  "domain0 SMT 0000,00000100,00000001 0 0 0 0 0 0 0 0 0"].join("\n");
const SECOND = 1e9;

test("the CPU set parses from Cpus_allowed_list, with ranges, and a missing, malformed or unsafe-number line is no set", () => {
  assert.equal(parseCpusAllowed(`Name:\tnode\nCpus_allowed_list:\t${METAL_CPUS}\nMems_allowed_list:\t1\n`)?.length, 32);
  assert.deepEqual(parseCpusAllowed("Cpus_allowed_list:\t0-2,5\n"), [0, 1, 2, 5]);
  assert.deepEqual(parseCpusAllowed("Cpus_allowed_list:\t4,2-4,2\n"), [2, 3, 4], "each CPU once, sorted");
  assert.equal(parseCpusAllowed("Name:\tnode\n"), null);
  for (const bad of ["3-1", "-1", "1-", "1-2-3", "1,,2", ",1", "1,", "a", "1 2", "", "9007199254740992", "1-9007199254740992", "9".repeat(400), `0-${"9".repeat(400)}`]) assert.equal(parseCpusAllowed(`Cpus_allowed_list:\t${bad}\n`), null, bad);
});

test("schedstat gives each CPU's run plus wait time, and an unknown version is no reading", () => {
  const times = parseSchedstat(SCHEDSTAT);
  assert.equal(times?.get(9), 2814401489253 + 34470168093);
  assert.equal(times?.size, 3);
  assert.equal(parseSchedstat(SCHEDSTAT.replace("version 17", "version 14")), null);
  assert.equal(parseSchedstat("version 17\ntimestamp 1\n"), null);
});

test("runnable tasks a core count only the harness's CPUs, so busy harness CPUs beside idle VM CPUs read busy", () => {
  const window = 10 * SECOND;
  const oneRunningOneWaiting = 2 * window;
  const before = new Map([[1, 0], [2, 0], [3, 0], [4, 0]]);
  const after = new Map([[1, oneRunningOneWaiting], [2, oneRunningOneWaiting], [3, 0], [4, 0]]);
  assert.equal(runnablePerCore(before, after, [1, 2], window / 1e6), 2);
  assert.equal(runnablePerCore(before, after, [1, 2, 3, 4], window / 1e6), 1, "averaged over every CPU of the box the same load reads half");
});

test("a window with no time, a CPU gone, a counter reset or counters that never move is unknown, never 0", () => {
  const before = new Map([[1, 5 * SECOND], [2, 5 * SECOND]]);
  assert.equal(runnablePerCore(before, new Map([[1, 6 * SECOND], [2, 6 * SECOND]]), [1, 2], 0), null);
  assert.equal(runnablePerCore(before, new Map([[1, 6 * SECOND]]), [1, 2], 1_000), null, "CPU 2 went offline");
  assert.equal(runnablePerCore(before, new Map([[1, 1 * SECOND], [2, 6 * SECOND]]), [1, 2], 1_000), null, "CPU 1's counter went back");
  assert.equal(runnablePerCore(before, before, [1, 2], 1_000), null, "the reading process ran on these CPUs, so no time at all means no counting");
  assert.equal(runnablePerCore(before, new Map([[1, 6 * SECOND], [2, 6 * SECOND]]), [], 1_000), null);
});

test("the cpu mark stays one runnable task a core", () => {
  const reading = (runnable: number) => ({ kind: "linux" as const, memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: runnable, allowedCpus: 32 });
  assert.deepEqual(unusable(reading(0.99)), []);
  assert.deepEqual(unusable(reading(1)), ["cpu"]);
});

test("a relay answer with a negative or unbounded runnablePerCore, or allowedCpus that is not a whole number above 0, is no reading", () => {
  const good = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.45, allowedCpus: 32 };
  for (const bad of [{ runnablePerCore: -0.1 }, { runnablePerCore: Infinity }, { runnablePerCore: NaN }, { allowedCpus: 0 }, { allowedCpus: -4 }, { allowedCpus: 1.5 }, { allowedCpus: Infinity }, { memFullAvg10: -1 }])
    assert.equal(parseLinuxReading({ ...good, ...bad }), null, JSON.stringify(bad));
  assert.deepEqual(parseLinuxReading({ ...good, runnablePerCore: 0 }), { ...good, runnablePerCore: 0 }, "an idle set reads 0, which is a measurement");
});

test("a relay answer without runnablePerCore and allowedCpus, from a relay before this reading, is no reading, so its box is unknown", () => {
  const old = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, loadPerCore: 0.25 };
  assert.equal(parseUsableRaw({ platform: "linux", reading: old }, Date.now()), null);
  assert.deepEqual(parseUsableRaw({ platform: "linux", reading: { ...old, runnablePerCore: 0.45, allowedCpus: 32 } }, Date.now()),
    { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.45, allowedCpus: 32 });
});

// Restart lines at 05:38:44Z and 05:53:34Z on 10-18 read usable null, since the first call had no earlier schedstat reading, and each was the
// last line of its minute, so those minutes read unknown.
test("on a Linux box the first reading after a restart counts from the module's load, and the next one from the reading before", { skip: process.platform !== "linux" }, async () => {
  for (let spin = Date.now(); Date.now() - spin < 20;);
  const first = await linuxUsable(Date.now());
  assert.equal(first?.allowedCpus, availableParallelism());
  for (let spin = Date.now(); Date.now() - spin < 50;);
  const next = await linuxUsable(Date.now());
  assert.equal(next?.allowedCpus, availableParallelism());
  assert.ok(next && next.runnablePerCore > 0);
});
