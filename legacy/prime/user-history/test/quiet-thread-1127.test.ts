// d7 run 261127-0214 read quiet_agent_gb_us_metal02 18.68 GB at 17:01Z on 11-26, 16 min into a stretch with no session working that began by
// 16:45Z. In that stretch the sw factory thread 7850f13e ("CRM developer VP") ran tsc and vitest in auto-sns-agent from its kernel scopes on
// 10 to 18 cores, and pi-pool held 8 to 23 turns at work, but the Linux reading had no busy thread list, so `threadsAtWork` read 0 there.
// GBS is us-metal02's Agent sessions GB from 16:44:30Z to 17:01:30Z and CORES the thread's rig cores in each line's harnessSplit
// (browser-chat/mac-usable/2026-11-27.jsonl); a Prime session streamed at 16:44:30Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { kernelCores } from "../../../../components/prime-relay/host-stats.ts";
import type { Snapshot } from "../../../../components/prime-relay/rig-cpu.ts";
import { measure, quietAgents } from "../scripts/duties/whole-system.ts";
import { type Footprints, parseLinuxReading, threadsAtWork, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";

const MIN = 60_000;
const GB = 1024 ** 3;
const START = Date.parse("2026-11-26T16:44:30Z");
const GBS = [26.48, 23.98, 24.21, 23.94, 28.17, 26.96, 27.24, 27.83, 27.75, 27.92, 20.81, 20.53, 20.57, 20.76, 20.74, 19.59, 18.63, 18.68];
const CORES = [16.11, 15.59, 12.77, 12.31, 17.67, 15.56, 14.66, 10.85, 9.97, 10.25, 12.61, 11.87, 12.7, 12.24, 14.23, 10.19, 9.85, 11.91];
const footprints: Footprints = { workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
const PRIME = "01a11d25-4c00-7613-9039-7a8377db04bb";
const prime = (working: boolean) => ({ sessionId: PRIME, activeSessionId: PRIME, lifecycle: "live", activity: working ? "working" : "idle", isSessionActive: working,
  isStreaming: working, workerPid: 1, lastActivityAt: "2026-11-26T16:44:00Z" });
const linux = (kernelCores: Record<string, number>) => ({ kind: "linux" as const, memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 5, swapoutsPerS: 17,
  runnablePerCore: 0.9, allowedCpus: 80, kernelCores });

const lineAt = (index: number, threadCores: number): WatchLine => ({ host: "us-metal02", ...watchLine({ now: START + index * MIN, rows: [prime(index === 0)], footprints,
  queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: linux({ "7850f13e": threadCores, "36846f8e": 0.02 }),
  memory: { groups: [{ id: "agents", label: "Agent sessions", bytes: GBS[index]! * GB, top: [] }] } }) });

test("a sw factory thread whose kernel scopes ran a build on us-metal02 breaks the quiet stretch, so its 18.68 GB minute is no idle agent memory", () => {
  const watch = GBS.map((_, index) => lineAt(index, CORES[index]!));
  assert.equal(watch.at(-1)!.agents!.threadsWorking, 1);
  assert.deepEqual(quietAgents(watch, START, START + GBS.length * MIN, 15 * MIN), []);
  const idle = GBS.map((_, index) => lineAt(index, 0.02));
  assert.equal(idle.at(-1)!.agents!.threadsWorking, undefined, "a thread under PROGRESS_CORES is idle, and its kernels keep counting");
  const quiet = quietAgents(idle, START, START + GBS.length * MIN, 15 * MIN);
  assert.deepEqual(quiet.map(minute => minute.agents.gb), [18.63, 18.68], "the old count read these minutes, as d7 did at 17:01Z");
  assert.equal(measure({ now: START + GBS.length * MIN, watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN }).metrics.quiet_agent_gb_us_metal02 ?? 0, 0);
});

test("a busy kernel scope whose id prefix is a Prime session's is left to that session's row", () => {
  assert.equal(threadsAtWork(linux({ "01a11d25": 3, "7850f13e": 0.1 }), [prime(false)]), 1);
  assert.equal(threadsAtWork(linux({}), []), 0);
});

test("kernelCores sums a thread's kernel scopes over the window and leaves out the other units and the idle threads", () => {
  const snap = (at: number, units: Record<string, number>): Snapshot => ({ at, procs: new Map(),
    units: new Map(Object.entries(units).map(([unit, usec]) => [unit, { role: "rig" as const, usec }])) });
  const before = snap(0, { "pi-rlm-kernel-7850f13e-mwxmqb97.scope": 1_000_000, "pi-rlm-kernel-12ebf3bd-mwxrt0bf.scope": 5_000_000, "duty-x.service": 0 });
  const after = snap(60_000, { "pi-rlm-kernel-7850f13e-mwxmqb97.scope": 601_000_000, "pi-rlm-kernel-7850f13e-mwxtde6e.scope": 120_000_000,
    "pi-rlm-kernel-12ebf3bd-mwxrt0bf.scope": 5_000_000, "duty-x.service": 60_000_000 });
  assert.deepEqual(kernelCores(before, after), { "7850f13e": 12 });
  assert.deepEqual(parseLinuxReading({ ...linux({ "7850f13e": 12, bad: -1 }) })?.kernelCores, { "7850f13e": 12 });
});
