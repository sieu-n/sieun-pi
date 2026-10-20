// Guards the Linux CPU reading of the Whole system duty (d7) on us-metal02: every harness unit there runs on 32 of the box's 80 CPUs, with
// libvirt VMs on the other 48, and at 05:10Z on 10-18 the 1-minute loadavg over all 80 read 0.27 a core while the harness's 32 ran 0.45.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuSides, linuxUsable, parseCpusAllowed, parseSchedstat, parseUsageUsec, runnablePerCore, loadedCgroups, schedstatMark, seedSchedstat, userSlice } from "../../prime-relay/host-stats.ts";
import { parseLinuxReading, parseUsableRaw, startMacUsableWatch, type Footprints, type WatchSource, unusable, watchFile } from "../src/mac-usable-watch.ts";

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

test("a restart's first window starts a cgroup the last process did not read at this module's load, so it never counts the cgroup's life since boot", { skip: process.platform !== "linux" || !userSlice(readFileSync("/proc/self/cgroup", "utf8")) }, async () => {
  await loadedCgroups;
  const mark = schedstatMark()!;
  assert.ok(mark.cgroups?.["system.slice"] !== undefined, "this box reads system.slice");
  const { "system.slice": _dropped, ...older } = mark.cgroups!;
  assert.equal(seedSchedstat({ at: mark.at - 60_000, times: mark.times, cgroups: older }), true);
  const reading = await linuxUsable(Date.now());
  assert.ok(reading?.cpuCores && reading.cpuCores.system <= availableParallelism(), JSON.stringify(reading?.cpuCores));
});

// us-metal02 on 10-18 after 07:45Z, when its slices lost their CPU pins: the harness, Virev's 24 cores of CI VMs and its prod VMs share all 80 CPUs.
test("CPU sides with no pins: Virev's CI and prod VMs count in full, so a minute when CI uses more cores than the harness is not the harness's", () => {
  const slice = userSlice("0::/user.slice/user-1001.slice/user@1001.service/app.slice/sieun-pi-chat.service\n")!;
  const before = new Map([[slice.slice, 0], ["virev.slice/virev-ci.slice", 0], ["virev.slice/virev-prod.slice", 0], ["dev.slice", 0], ["system.slice", 0]]);
  const after = new Map([[slice.slice, 200_000_000], ["virev.slice/virev-ci.slice", 240_000_000], ["virev.slice/virev-prod.slice", 20_000_000], ["dev.slice", 30_000_000], ["system.slice", 8_000_000]]);
  assert.deepEqual(cpuSides(before, after, slice, 10_000), { harness: 20, apps: 5, owner: 0, ci: 24, system: 0.8 });
});

test("runnable tasks a core with no pins average all 80 CPUs, VM vCPU time included", () => {
  const window = 10 * SECOND;
  const all = Array.from({ length: 80 }, (_, cpu) => cpu);
  const before = new Map(all.map(cpu => [cpu, 0]));
  const after = new Map(all.map(cpu => [cpu, cpu % 2 === 0 ? 2 * window : window]));
  assert.equal(runnablePerCore(before, after, all, window / 1e6), 1.5, "CI's queued vCPUs on the even CPUs count beside the harness's tasks on the odd ones");
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

test("a restart's first window starts at the last process's reading, unless that reading is newer, ahead of the counters or malformed", { skip: process.platform !== "linux" }, async () => {
  const mark = schedstatMark()!;
  const ahead = { at: mark.at - 1_000, times: Object.fromEntries(Object.entries(mark.times).map(([cpu, ns]) => [cpu, ns + 1e12])) };
  const missing = { at: mark.at - 1_000, times: Object.fromEntries(Object.entries(mark.times).slice(1)) };
  for (const bad of [null, { at: "x", times: mark.times }, { at: mark.at + 1, times: mark.times }, ahead, missing]) assert.equal(seedSchedstat(bad), false, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(seedSchedstat({ at: mark.at - 60_000, times: mark.times }), true);
  assert.equal(schedstatMark()!.at, mark.at - 60_000);
  const reading = await linuxUsable(Date.now());
  assert.ok(reading && reading.runnablePerCore >= 0);
});

function watchSource(dataDir: string, now: () => number): WatchSource {
  return { dataDir, now, rows: () => [{ sessionId: "s1", lifecycle: "live", activeSessionId: "a1", workerPid: 1, activity: "idle" }], chats: async () => new Set<string>(),
    title: () => null, queue: async () => { throw new Error("no queue"); }, log: line => { throw new Error(line); },
    footprints: async () => ({ workers: {} }) as unknown as Footprints, feed: async () => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 1.48, allowedCpus: 32 }) };
}
const lines = (dataDir: string, at: number): string[] => { try { return readFileSync(watchFile(dataDir, at), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

// 06:15:49Z on 10-18 read 1.43 from the service's boot alone, 19 s after the old process's 06:15:30Z line, and as the minute's last line it set it.
test("a restart in a minute the last process already wrote writes no start line; a restart in an unwritten minute fills it", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "usable-watch-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "mac-usable"), { recursive: true });
  const at = Date.parse("2026-10-18T06:15:49Z");
  writeFileSync(join(dataDir, "mac-usable", "last-sample.json"), JSON.stringify({ at: Date.parse("2026-10-18T06:15:30Z"), sched: null }));
  // Each stop is awaited: it waits for the sample in flight. A fixed 200 ms sleep and a stop left running failed under the release build's
  // load on 10-19 (build of 2e49a5b, 11:4xZ), when the sample landed after the assertion and after the folder was removed.
  await startMacUsableWatch(watchSource(dataDir, () => at))();
  assert.deepEqual(lines(dataDir, at), []);
  const later = Date.parse("2026-10-18T06:16:05Z");
  await startMacUsableWatch(watchSource(dataDir, () => later))();
  assert.equal(lines(dataDir, later).length, 1);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "mac-usable", "last-sample.json"), "utf8")).at, later);
});

// us-metal02 at 06:42Z on 10-18 over 10 s: user-1001.slice 20.4 cores, prime-agent-daemon.service 13.9 of them, auto-sns-dev-pm2.service 2.2,
// dev.slice's docker apps 5.6, system.slice 0.9.
test("CPU sides: the harness is the user slice less the apps', owner's and CI's units in it, and a restarted unit counts its new value", () => {
  const slice = userSlice("0::/user.slice/user-1001.slice/user@1001.service/app.slice/sieun-pi-chat.service\n")!;
  assert.deepEqual(slice, { slice: "user.slice/user-1001.slice", app: "user.slice/user-1001.slice/user@1001.service/app.slice" });
  assert.equal(userSlice("0::/system.slice/prime-relay.service\n"), null);
  assert.equal(parseUsageUsec("usage_usec 123\nuser_usec 100\n"), 123);
  const app = (unit: string) => `${slice.app}/${unit}`;
  const before = new Map([[slice.slice, 1_000_000_000], [app("auto-sns-dev-pm2.service"), 50_000_000], [app("ci-cache.service"), 9_000_000], ["dev.slice", 70_000_000], ["system.slice", 5_000_000]]);
  const after = new Map([[slice.slice, 1_204_000_000], [app("auto-sns-dev-pm2.service"), 72_000_000], [app("ci-cache.service"), 1_000_000], ["dev.slice", 126_000_000], ["system.slice", 14_000_000]]);
  assert.deepEqual(cpuSides(before, after, slice, 10_000), { harness: 18.1, apps: 7.8, owner: 0, ci: 0.1, system: 0.9 });
  assert.equal(cpuSides(new Map(), after, slice, 10_000), null);
});

test("on a Linux box in a user slice the reading carries each side's cores", { skip: process.platform !== "linux" || !userSlice(readFileSync("/proc/self/cgroup", "utf8")) }, async () => {
  for (let spin = Date.now(); Date.now() - spin < 50;);
  const reading = await linuxUsable(Date.now());
  assert.ok(reading?.cpuCores && reading.cpuCores.harness > 0, JSON.stringify(reading));
  assert.deepEqual(parseLinuxReading(reading), reading);
  assert.equal(parseLinuxReading({ ...reading, cpuCores: { harness: -1 } })?.cpuCores, undefined);
});
