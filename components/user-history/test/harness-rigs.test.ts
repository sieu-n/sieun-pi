// The harness side's CPU, split into its own work and the rigs jobs start (rig-cpu.ts). us-metal02 read 10 CPU minutes unusable from 11:23Z to
// 11:32Z on 10-18 at load 111 on 80 cores, when scratch chat services (scratch-cpu-b with --cpu-prof at 168%, scratch-A-base at 148%), a tsgo
// --noEmit of an iso build at 489% and release builds of jobs held most of the harness's cores, and d7 could only say "the harness".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DAEMON_UNIT, harnessSplit, NO_OWNER, ownerOf, parseProcStat, type Proc, shortCommand, snapshot, type Snapshot } from "../../prime-relay/rig-cpu.ts";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import { measure } from "../scripts/duties/whole-system.ts";
import { parseUsableRaw, type UsableReading, type WatchLine } from "../src/mac-usable-watch.ts";

const proc = (ticks: number, extra: Partial<Proc> = {}): Proc => ({ start: 1, ticks, unit: DAEMON_UNIT, own: false, command: "node", ...extra });
const snap = (at: number, daemonUsec: number, isoUsec: number, procs: [number, Proc][]): Snapshot => ({
  at, units: new Map([[DAEMON_UNIT, { role: "split" as const, usec: daemonUsec }], ["p8iso-ABC-d.service", { role: "rig" as const, usec: isoUsec }],
    ["sieun-pi-chat.service", { role: "own" as const, usec: 0 }]]), procs: new Map(procs) });

test("rigs are the rig units' cores plus the daemon unit's cores less its workers' and kernels', named by owner", () => {
  // A 10 s window at 100 ticks a second: the daemon unit used 300 s (30 cores), its worker and kernel 20 s, the iso unit 50 s.
  const before = snap(0, 0, 0, [[10, proc(0, { own: true, command: "prime-agent --mode daemon" })], [11, proc(0, { own: true, command: "python -m rlm.repl" })],
    [20, proc(0, { owner: "01a14d31/scratch-cpu-b", command: "node src/chat-service-cli.mjs serve --data-dir" })]]);
  const after = snap(10_000, 300e6, 50e6, [[10, proc(1500, { own: true })], [11, proc(500, { own: true })],
    [20, proc(16_000, { owner: "01a14d31/scratch-cpu-b", command: "node src/chat-service-cli.mjs serve --data-dir" })],
    [21, proc(4000, { start: 9, owner: "01a14eb0/tsgo-check", command: "tsgo --noEmit -p ." })], [22, proc(300, { owner: NO_OWNER, command: "vite dev" })]]);
  const split = harnessSplit(before, after, 40);
  assert.deepEqual(split, { own: 7, rigs: 33, top: [
    { owner: "01a14d31/scratch-cpu-b", cores: 16, command: "node src/chat-service-cli.mjs serve --data-dir" },
    { owner: "01a14eb0/tsgo-check", cores: 4, command: "tsgo --noEmit -p ." },
    { owner: NO_OWNER, cores: 0.3, command: "vite dev" },
  ] });
  assert.equal(harnessSplit(after, after, 40), null, "an empty window reads nothing");
  assert.equal(harnessSplit(before, after, 20)?.rigs, 20, "rigs never pass the harness side's cores");
});

test("a job's owner is its root's short id and its job name, and a stat line parses past a command with spaces", () => {
  const dir = "/home/sieun/.prime/agent/session-artifacts/01a14d31-6ec0-7005-bbe8-c38b7ae73cfb/sub-9b81aed2/sub-f29d565c";
  assert.equal(ownerOf(dir, "scratch A"), "01a14d31/scratch A");
  assert.equal(ownerOf(dir, undefined), "01a14d31/sub-f29d565c");
  assert.equal(ownerOf("/home/sieun/.prime/agent/session-artifacts/01a1164b-4a2d-742d-b27a-82f086ed0200", "x"), "01a1164b");
  assert.equal(shortCommand(["/usr/bin/node", "--cpu-prof", "--cpu-prof-dir=/x", "components/user-history/src/chat-service-cli.mjs", "serve", "--port", "5390"].join("\0")), "node components/user-history/src/chat-service-cli.mjs serve 5390");
  assert.deepEqual(parseProcStat("42 (node a) b) S 7 42 42 0 -1 4194304 1 0 0 0 250 50 0 0 20 0 11 0 9001 1 1"), { ppid: 7, start: 9001, ticks: 300 });
});

const RUN = Date.parse("2026-10-18T11:33:10Z");
const linux = (runnablePerCore: number, extra: Partial<LinuxUsable> = {}): LinuxUsable =>
  ({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore, allowedCpus: 80, ...extra });
const mac: UsableReading = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 20 };
const line = (minute: number, box: LinuxUsable): WatchLine => ({
  at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box,
  workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: mac, workers: 1, workerGb: 1, top: [], live: 1, working: 1, swapGb: 0 }] });

test("d7 names a CPU minute's job rigs by chat and job, and counts the harness minutes rigs led", () => {
  const cpuCores = { harness: 60, apps: 3, owner: 0, ci: 9, system: 1 };
  const rigs = linux(1.4, { cpuCores, harnessSplit: { own: 12, rigs: 48, top: [
    { owner: "01a14d31/scratch-cpu-b", cores: 17, command: "node src/chat-service-cli.mjs serve" },
    { owner: "p8iso-PVXA-d.service", cores: 5, command: "tsgo --noEmit" }] } });
  const own = linux(1.3, { cpuCores, harnessSplit: { own: 40, rigs: 20, top: [] } });
  const lines = Array.from({ length: 30 }, (_, minute) => minute === 28 ? { ...line(minute, rigs), chat: { readMs: 2400, read: "api/threads", loopMs: 900 } }
    : line(minute, minute === 29 ? own : linux(0.5, { cpuCores })));
  const chats = [{ id: "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb", name: "AI harness developer environment VP", duties: [], runs: [] }];
  const { metrics, flagged } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats });
  assert.equal(metrics.harness_unusable_min_30, 1);
  assert.equal(metrics.harness_rig_unusable_min_30, 1);
  assert.equal(metrics.cpu_busy_min_30, 1, "11:32Z, when the harness stayed fast");
  assert.match(flagged?.find(slice => slice.kind === "minutes")?.excerpt ?? "", /and 1 harness minutes went mostly to job rigs\)/);
  assert.match(flagged?.find(slice => slice.kind === "busy_minutes")?.excerpt ?? "", /11:32Z us-metal02 busy at 1\.3 runnable a core, harness 60 cores, 40 its own and 20 in job rigs/);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /11:31Z us-metal02 unusable \(cpu: the chat answered api\/threads in 2\.4 s; harness 60 cores, 12 its own and 48 in job rigs: AI harness developer environment VP, job scratch-cpu-b 17 \(node src\/chat-service-cli\.mjs serve\), p8iso-PVXA-d\.service 5 \(tsgo --noEmit\)\)/);
  assert.equal(parseUsableRaw({ platform: "linux", reading: rigs }, RUN) && (parseUsableRaw({ platform: "linux", reading: rigs }, RUN) as LinuxUsable).harnessSplit?.rigs, 48);
  assert.equal((parseUsableRaw({ platform: "linux", reading: { ...rigs, harnessSplit: { own: -1 } } }, RUN) as LinuxUsable).harnessSplit, undefined);
});

const cgroup = process.platform === "linux" ? readFileSync("/proc/self/cgroup", "utf8") : "";
const app = /^0::\/(user\.slice\/user-\d+\.slice\/user@\d+\.service\/app\.slice)\/prime-agent-daemon\.service(?:\/|$)/m.exec(cgroup)?.[1];
test("on a box, a command a kernel ran is a rig of that kernel's job, and the kernel is the harness's own", { skip: !app && "not run from a Prime kernel" }, async () => {
  const read = await snapshot(app!, new Set(), process.getuid!());
  assert.equal(read.units.get(DAEMON_UNIT)?.role, "split");
  const self = read.procs.get(process.pid);
  assert.equal(self?.own, false);
  assert.match(self?.owner ?? "", /^[0-9a-f]{8}(\/|$)/);
  assert.ok([...read.procs.values()].some(entry => entry.own && /rlm\.repl/.test(entry.command)), "a kernel reads as own");
});
