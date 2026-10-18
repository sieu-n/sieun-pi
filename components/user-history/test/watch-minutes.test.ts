// Guards the 10-18 03:53Z dirty minute: the Whole system duty (d7) read 29 of 30 clean at 04:17:08Z because its sliding minute (03:52:08, 03:53:08]
// fell between watch lines at 03:52:07.717Z and 03:53:08.347Z, which the drifting once-a-minute interval wrote 60.63 s apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import { type Footprints, hostWatchLine, nextSampleAt, parseUsableRaw, type QueueReading, unusable, type UsableReading, type WatchLine, watchLine } from "../src/mac-usable-watch.ts";

// Every watch line stamp from 03:46Z to the d7 run at 04:17:08Z on 10-18, from mac-usable/2026-10-18.jsonl; the jumps after 03:55Z are chat restarts.
const STAMPS = ["03:46:06.734", "03:47:06.735", "03:48:06.734", "03:49:06.921", "03:50:07.210", "03:51:07.469", "03:52:07.717", "03:53:08.347",
  "03:54:08.346", "03:55:06.137", "03:56:00.576", "03:57:00.647", "03:57:12.652", "03:58:07.479", "03:58:28.937", "03:59:23.933", "04:00:23.939",
  "04:01:23.957", "04:02:18.705", "04:02:36.456", "04:03:31.463", "04:04:24.648", "04:05:19.648", "04:06:19.649", "04:07:19.649", "04:08:19.654",
  "04:09:19.654", "04:10:19.679", "04:11:19.693", "04:11:41.913", "04:12:31.911", "04:13:16.729", "04:14:06.728", "04:15:06.729", "04:16:06.731",
  "04:17:06.730"];
const RUN = Date.parse("2026-10-18T04:17:08Z");
const line = (clock: string): WatchLine => ({ at: `2026-10-18T${clock}Z`, usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 },
  workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 });
const run = (stamps: readonly string[]) => measure({ now: RUN, watch: stamps.map(line), log: { holds: [] }, chats: [] });

test("the 03:52:07.717Z and 03:53:08.347Z lines watch 03:53Z, so the 04:17:08Z run reads 30 clean minutes", () => {
  const { metrics } = run(STAMPS);
  assert.equal(metrics.unwatched_min_30, 0);
  assert.equal(metrics.clean_min_30, 30);
});

test("a minute with no line reads unwatched and unknown, neither clean nor dirty, when the watch stops for 2 minutes", () => {
  const result = run(STAMPS.filter(stamp => stamp !== "04:00:23.939" && stamp !== "04:01:23.957"));
  assert.equal(result.metrics.unwatched_min_30, 2);
  assert.equal(result.metrics.unknown_min_30, 2);
  assert.equal(result.metrics.clean_min_30, 28);
  assert.equal(result.flagged?.find(slice => slice.kind === "dirty_minutes"), undefined);
  assert.match(result.flagged?.find(slice => slice.kind === "unknown_minutes")?.excerpt ?? "", /^04:00Z no watch line; 04:01Z no watch line$/);
});

test("the watch samples at each wall-clock minute's middle, so a lagging tick stays in its minute and never drifts", () => {
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:07.717Z"))).toISOString(), "2026-10-18T03:52:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:52:30.000Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
  assert.equal(new Date(nextSampleAt(Date.parse("2026-10-18T03:53:29.999Z"))).toISOString(), "2026-10-18T03:53:30.000Z");
});

// From 04:22:55Z on 10-18 the chat ran on us-metal02, whose lines carried usable: null (the Mac's feed has no Linux side) and measured only the
// box's workers, so clean_min_30 counted every box minute dirty and the Mac's workers left sleeping_gb.
const BOX_RUN = Date.parse("2026-10-18T05:00:10Z");
const linux = (memFullAvg10: number, runnablePerCore: number): LinuxUsable => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore, allowedCpus: 32 });
const mac: UsableReading = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 20 };
const boxLine = (minute: number, box: LinuxUsable | null, other: UsableReading | null, sleeping = 0): WatchLine => ({
  at: new Date(BOX_RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box,
  workers: 4, workerGb: 2.6, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0,
  sleeping: { gb: 0, workers: 0, kernels: 0, trees: [] },
  hosts: [{ name: "mac", usable: other, workers: 19, workerGb: 9.68, top: [], live: 46, working: 27, swapGb: 7.8,
    sleeping: { gb: sleeping, workers: sleeping ? 1 : 0, kernels: 0, trees: sleeping ? [{ root: "lmb", tree: "launch main bro", gb: sleeping }] : [] },
    ...other ? {} : { error: "relay mac answered 502 to /v1/watch" } }] });

test("each box is judged on its own reading, a Linux box by memory stall and runnable tasks a core, and a box with no reading is unknown", () => {
  const lines = Array.from({ length: 30 }, (_, minute) => boxLine(minute, minute === 3 ? linux(72, 0.6) : minute === 4 ? linux(0, 1.2) : linux(0, 0.58),
    minute === 10 ? null : mac));
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.clean_min_30, 27);
  assert.equal(metrics.unknown_min_30, 1, "the minute the Mac's relay did not answer is neither clean nor dirty");
  assert.equal(metrics.usable_min_30_us_metal02, 28);
  assert.equal(metrics.unusable_min_30_us_metal02, 2);
  assert.equal(metrics.unknown_min_30_mac, 1);
  assert.equal(metrics.usable_min_30_mac, 29);
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /us-metal02 unusable \(pressure\).*us-metal02 unusable \(cpu\)/);
  assert.match(flagged?.find(slice => slice.kind === "unknown_minutes")?.excerpt ?? "", /mac unread \(relay mac answered 502/);
});

test("a kept Linux reading with loadPerCore and no runnablePerCore reads its box unknown, never clean, in its own line or through a relay", () => {
  // us-metal02's line at 05:06:30Z on 10-18, from before host-stats.ts read the CPU set: loadPerCore 0.25 was the loadavg over all 80 CPUs.
  const old = { kind: "linux", memSomeAvg10: 0.07, memFullAvg10: 0.07, cpuSomeAvg10: 0.12, swapoutsPerS: 736, loadPerCore: 0.25 } as unknown as LinuxUsable;
  const lines = Array.from({ length: 30 }, (_, minute) => {
    const line = boxLine(minute, minute < 20 ? old : linux(0, 0.58), mac);
    return minute === 25 ? { ...line, hosts: [{ ...line.hosts![0]!, usable: old }] } : line;
  });
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.unknown_min_30_us_metal02, 20);
  assert.equal(metrics.usable_min_30_us_metal02, 10);
  assert.equal(metrics.unknown_min_30_mac, 1, "an old Linux reading through a relay is checked the same way");
  assert.equal(metrics.usable_min_30_mac, 29);
  assert.equal(metrics.clean_min_30, 9);
  assert.equal(metrics.unknown_min_30, 21);
  assert.match(flagged?.find(slice => slice.kind === "unknown_minutes")?.excerpt ?? "", /us-metal02 unread \(an old-format or invalid Linux reading\)/);
});

test("sleeping_gb sums every box's sleeping sessions, and the flag names each box", () => {
  const lines = Array.from({ length: 30 }, (_, minute) => boxLine(minute, linux(0, 0.5), mac, 0.31));
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.sleeping_gb, 0.31);
  assert.match(flagged?.find(slice => slice.kind === "sleeping")?.excerpt ?? "", /mac 0.31 GB in 1 whole workers and 0 kernels \(launch main bro 0.31 GB\)/);
});

test("another box's watch line comes from its relay's answer, and a relay that fails leaves its numbers unknown", async () => {
  const GB = 1024 ** 3;
  const rows = [{ sessionId: "lmb", activeSessionId: "lmb", lifecycle: "live", activity: "idle", workerPid: 31, sessionName: "launch main bro", lastActivityAt: new Date(BOX_RUN - 40 * 60_000).toISOString() }];
  const footprints: Footprints = { workers: { 31: { pids: 2, bytes: 0.31 * GB } }, kernels: [], swap_used_bytes: 7.8 * GB, pressure_level: 2, cpu_s: 0 };
  const feed = { v: 1, ts: new Date(BOX_RUN - 5_000).toISOString(), pressure_level: 2, swapouts_per_s: 0, kernel_task_cpu_pct: 20 };
  const read = await hostWatchLine({ name: "mac", rows, read: async pids => { assert.deepEqual(pids, [31]); return { usable: { platform: "darwin", feed }, footprints }; } },
    { now: BOX_RUN, chats: new Set(["lmb"]), title: () => null, idleMs: 10 * 60_000 });
  assert.equal(read.workers, 1);
  assert.equal(read.workerGb, 0.31);
  assert.equal(read.sleeping?.gb, 0.31);
  assert.deepEqual(read.usable, { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 20 });
  const failed = await hostWatchLine({ name: "mac", rows, read: async () => { throw new Error("relay mac answered 404 to /v1/watch"); } }, { now: BOX_RUN, chats: new Set(), title: () => null });
  assert.equal(failed.usable, null);
  assert.match(failed.error ?? "", /404/);
  const box = parseUsableRaw({ platform: "linux", reading: linux(0, 0.58) }, BOX_RUN);
  assert.deepEqual(box && unusable(box), []);
});

// At 04:30Z on 10-18 d7 read "a turn queued with free slots" while the box held 12 of 16 slots: the queued turns were metal-management's, whose tree
// held 8 of tree_working_max 8, so pi-pool's own rule (admit_pass) had no slot it was allowed to give them. The old test compared only the machine
// count with a working_max it read as 15 from a config.json the box did not have.
const TREES: Record<string, string> = { mm: "metal-management", ci: "VP of CI", api: "api portal vp" };
const turn = (session: string, tree: string, kind: "slot" | "borrow" = "slot") => ({ session, tree, parent: null, priority: "normal" as const, since: BOX_RUN - 600_000, kind });
const waiter = (session: string, tree: string, waitS: number) => ({ session, tree, parent: null, priority: "normal" as const, since: BOX_RUN - waitS * 1000,
  basePriority: "normal" as const, position: 1, total: 2, waitMs: waitS * 1000 });
const queueAt = (reading: QueueReading, minute: number): WatchLine => {
  const now = BOX_RUN - 10_000 - (30 - minute) * 60_000 + 30_000;
  const footprints: Footprints = { workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
  const shifted = { ...reading, queued: reading.queued.map(entry => ({ ...entry, since: entry.since - BOX_RUN + now })) };
  return { ...watchLine({ now, rows: [], footprints, queue: shifted, chats: new Set(), title: id => TREES[id] ?? null, cpuMs: 0, usable: linux(0, 0.3) }), host: "us-metal02" };
};
const slots = (tree: string, count: number) => Array.from({ length: count }, (_, i) => turn(`${tree}${i}`, tree));

test("the 04:30Z case reads clean: 12 of 16 slots in use and the oldest queued turn's tree at 8 of 8 is pi-pool's tree cap, not a free slot", () => {
  const reading: QueueReading = { workingMax: 16, treeWorkingMax: 8, working: [...slots("mm", 8), ...slots("api", 4), turn("mm-child", "mm", "borrow")],
    queued: [waiter("mm-a", "mm", 167), waiter("mm-b", "mm", 40)] };
  const line = queueAt(reading, 0);
  assert.equal(line.queue?.working, 13);
  assert.equal(line.queue?.slots, 12);
  assert.deepEqual(line.queue?.waiting, [{ tree: "metal-management", oldestWaitS: 167, slots: 8 }]);
  const { metrics } = measure({ now: BOX_RUN, watch: Array.from({ length: 30 }, (_, minute) => queueAt(reading, minute)), log: { holds: [] }, chats: [] });
  assert.equal(metrics.queued_free_slot_min_30, 0);
  assert.equal(metrics.clean_min_30, 30);
});

test("a turn whose tree has free slots and waits while the machine has free slots still reads dirty, and a full machine does not", () => {
  const open: QueueReading = { workingMax: 16, treeWorkingMax: 8, working: [...slots("mm", 8), ...slots("ci", 4)], queued: [waiter("mm-a", "mm", 300), waiter("ci-a", "ci", 167)] };
  const { metrics, flagged } = measure({ now: BOX_RUN, watch: Array.from({ length: 30 }, (_, minute) => queueAt(open, minute)), log: { holds: [] }, chats: [] });
  assert.equal(metrics.queued_free_slot_min_30, 30);
  assert.equal(metrics.clean_min_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /a turn of VP of CI queued 167 s with free slots \(12 of 16 in use, its tree at 4 of 8\)/);
  const full: QueueReading = { ...open, working: [...open.working, ...slots("api", 3)] };
  assert.equal(measure({ now: BOX_RUN, watch: Array.from({ length: 30 }, (_, minute) => queueAt(full, minute)), log: { holds: [] }, chats: [] }).metrics.clean_min_30, 30);
});

// Guards the 04:48Z d7 run on 10-18: it took chat-057a's 3 stuck steps from its 04:32Z check-in, taken before the chat moved to us-metal02,
// while its live board had moved on with every open step owned by a box job that was working. The live board decides.
test("d7 reads a check-in snapshot older than the board's last write against the live board's owners", () => {
  const checkIn = Date.parse("2026-10-18T04:32:00Z");
  const now = Date.parse("2026-10-18T04:48:00Z");
  const chat = "01a1057a-0000-7000-8000-000000000000";
  const slice = (item: string) => ({ chat, at: checkIn, kind: "stuck_steps", excerpt: `${item} is stuck (no_owner)`, item });
  const runs = [{ duty: "checkin", at: checkIn, trigger: "schedule" as const, ms: 1, verdict: "missed" as const, summary: "",
    metrics: { stuck_steps: { value: 3, target: 0, op: "<=" as const, met: false } }, flagged: ["p4", "p5", "p6"].map(slice) }];
  const step = (id: string, status: "doing" | "done", sessionId?: string) => ({ id, text: id, status, children: [], ...(sessionId ? { sessionId } : {}) });
  const board = (updatedAt: string): ChatBoard => ({ v: 2, rev: 217, todos: [], updatedAt,
    plan: [{ ...step("p1", "doing"), children: [step("p4", "doing", "box-job-a"), step("p5", "done"), step("p6", "doing", "box-job-b")] }] });
  const read = (b: ChatBoard, activity: Record<string, number>) => measure({ now, watch: [], log: { holds: [] },
    chats: [{ id: chat, name: "chat-057a", duties: [], runs, everyMs: 30 * 60_000 }], boards: new Map([[chat, b]]),
    ownerActivity: new Map(Object.entries(activity)) }).metrics.stuck_steps_all;
  const wrote = Date.parse("2026-10-18T04:40:00Z");
  assert.equal(read(board("2026-10-18T04:41:00Z"), { "box-job-a": wrote, "box-job-b": wrote }), 0);
  assert.equal(read(board("2026-10-18T04:41:00Z"), { "box-job-a": wrote }), 1, "p6's owner has not written since the snapshot");
  assert.equal(read(board("2026-10-18T04:31:00Z"), { "box-job-a": wrote, "box-job-b": wrote }), 3, "a snapshot newer than the board counts as read");
});

// d7 at 06:21Z on 10-18 read us-metal02 CPU-unusable at 05:55-05:59, 06:02, 06:04, 06:05, 06:07 and 06:15Z and put every minute on the app and
// owner side with harness_unusable_min_30 0, since Linux readings never carry the Mac's memory groups. The runnable values are those lines'.
test("a Linux CPU minute goes to the side whose cgroups used the most cores, and a Linux minute with no cpuCores reads no cause, never the apps'", () => {
  const RUN_0621 = Date.parse("2026-10-18T06:21:10Z");
  const at = (clock: string) => `2026-10-18T${clock}Z`;
  const harness = { harness: 21.4, apps: 3.1, owner: 0, ci: 0.2, system: 0.9 };
  const apps = { harness: 4.2, apps: 9.8, owner: 0, ci: 0, system: 0.9 };
  const read = (runnablePerCore: number, cpuCores?: typeof harness): LinuxUsable => ({ ...linux(0, runnablePerCore), ...cpuCores ? { cpuCores } : {} });
  const dirty: Record<string, LinuxUsable> = { "05:55:44": read(2.17, harness), "05:56:30": read(6.06, harness), "05:57:31": read(5.61, harness),
    "05:58:30": read(2.06, harness), "05:59:30": read(2.73, harness), "06:02:30": read(1.74, harness), "06:04:30": read(2.78, harness),
    "06:05:30": read(2.49, harness), "06:07:39": read(1.48, apps), "06:15:49": read(1.43) };
  const lines: WatchLine[] = Array.from({ length: 30 }, (_, minute) => {
    const stamp = new Date(RUN_0621 - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString().slice(11, 19);
    const box = Object.entries(dirty).find(([clock]) => clock.slice(0, 5) === stamp.slice(0, 5))?.[1] ?? read(0.7, harness);
    return { ...boxLine(minute, box, mac), at: at(`${stamp}.000`) };
  });
  const { metrics, flagged } = measure({ now: RUN_0621, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.unusable_min_30_us_metal02, 10);
  assert.equal(metrics.harness_unusable_min_30, 8);
  assert.equal(metrics.other_unusable_min_30, 1, "06:07Z, when the apps' cgroups used the most cores");
  assert.equal(metrics.unattributed_unusable_min_30, 1, "06:15Z, a line from before cpuCores");
  assert.equal(metrics.clean_min_30, 20, "a CPU overload with no cause read is still a dirty minute");
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /06:15Z us-metal02 unusable \(cpu\)/);
  assert.match(flagged?.find(slice => slice.kind === "minutes")?.excerpt ?? "", /8 unusable minutes on the harness side, 1 on the app or owner side, 1 with no cause read/);
});

test("a Linux memory-only miss has no CPU cause to read and goes to no side", () => {
  const box: LinuxUsable = { ...linux(72, 0.6), cpuCores: { harness: 20, apps: 1, owner: 0, ci: 0, system: 1 } };
  const lines = Array.from({ length: 30 }, (_, minute) => boxLine(minute, minute === 3 ? box : linux(0, 0.58), mac));
  const { metrics } = measure({ now: BOX_RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.harness_unusable_min_30, 0);
  assert.equal(metrics.unattributed_unusable_min_30, 1);
});

// Guards d7's 06:54Z run on 10-18: it read stuck_steps_all 27 while ops guy's 06:49Z check-in job was giving its 26 new Grafana rule steps
// jobs; that check-in's after-job measure at 06:55Z read 0. A check-in job at work owns the steps it flagged.
test("d7 counts no stuck step of a check-in whose job still works, and reads the after-job count once it ended", () => {
  const checkIn = Date.parse("2026-10-18T06:49:00Z");
  const chat = "01a11af8-962e-773d-a19a-ee4104011987";
  const items = Array.from({ length: 27 }, (_, index) => `p${319 + index}`);
  const run = { duty: "checkin", at: checkIn, trigger: "schedule" as const, ms: 1, verdict: "missed" as const, summary: "",
    metrics: { stuck_steps: { value: 27, target: 0, op: "<=" as const, met: false } },
    flagged: items.map(item => ({ chat, at: checkIn, kind: "stuck_steps", excerpt: `${item} is stuck (no_owner)`, item })),
    job: { id: "01a14dc0-0000-7000-8000-000000000000", name: "check-in ops guy (+observability) 15:49" } };
  const read = (runs: DutyRunRecord[], now: string) => measure({ now: Date.parse(now), watch: [], log: { holds: [] },
    chats: [{ id: chat, name: "ops guy (+observability)", duties: [], runs, everyMs: 120 * 60_000 }] }).metrics.stuck_steps_all;
  assert.equal(read([run], "2026-10-18T06:54:00Z"), 0, "the check-in job is at work on them");
  const ended = (value: number) => ({ ...run, after: { at: Date.parse("2026-10-18T06:55:47Z"), verdict: "missed" as const, summary: "",
    metrics: { stuck_steps: { value, target: 0, op: "<=" as const, met: value === 0 } } } });
  assert.equal(read([ended(0)], "2026-10-18T07:00:00Z"), 0);
  assert.equal(read([ended(2)], "2026-10-18T07:00:00Z"), 2, "what the ended job left counts");
  const { job: _job, ...noJob } = run;
  assert.equal(read([noJob], "2026-10-18T06:54:00Z"), 27, "a check-in that started no job owns nothing");
});
