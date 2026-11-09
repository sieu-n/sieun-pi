// d7 at 20:01 KST on 11-09 read quiet_agent_gb 6.68 GB and missed it 2 runs in a row. 5.08 GB of it was the worker of "korean sign-up staging
// metal" (pid 975297), with no session working since 10:39Z, while 4.38 GB of that tree was a svelte-check its job ko-last-english had started
// and still ran; the tree fell to 0.67 GB at 11:00Z when the check ended. The timeline below is that worker's footprint and work bytes from the
// watch lines of 11-09 (browser-chat/mac-usable/2026-11-09.jsonl), with the checks' CPU at 2 cores, beside a quiet tree that keeps a dev server
// nobody uses and a tree at work.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryGroup } from "../../../../components/prime-relay/host-stats.ts";
import { measure, quietReadings } from "../scripts/duties/whole-system.ts";
import { type Footprints, type RawKernel, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const KOREAN = 975297, DEV = 900001, BUSY = 900002;
const KERNEL_GB = 0.1;
/** 975297's footprint and the bytes its job's commands held, each minute at hh:mm:30 from 10:39:30Z to 10:56:30Z. */
const CHECK = [[4.19, 3.5], [4.52, 3.83], [4.66, 3.96], [4.7, 4.01], [4.78, 4.08], [5.01, 4.31], [5.24, 4.54], [5.24, 4.54], [5.2, 4.53], [1.47, 0.77],
  [2.88, 2.2], [3.54, 2.86], [3.71, 3.03], [3.82, 3.14], [3.86, 3.17], [4.12, 3.44], [4.69, 4], [5.08, 4.38]] as const;
const START = Date.parse("2026-11-09T10:39:30Z");
const live = (sessionId: string, workerPid: number, parentSessionId?: string, working = false) => ({ sessionId, workerPid, lifecycle: "live",
  activeSessionId: sessionId, sessionName: sessionId, activity: working ? "working" : "idle", isRunningTools: working, ...parentSessionId ? { parentSessionId } : {} });
const rows = [live("01a1bd13-korean", KOREAN), live("ko-last-english", KOREAN, "01a1bd13-korean"), live("dev-chat", DEV), live("busy-chat", BUSY, undefined, true)];
const kernel = (session: string, pid: number, workGb: number, workCpuS: number): RawKernel => ({ pid, root: session, session, pids: 2,
  bytes: (KERNEL_GB + workGb) * GB, own: KERNEL_GB * GB, biggest: null, cpu_s: 30, work_cpu_s: workCpuS });
const memory = { groups: [{ id: "agents", label: "Agent sessions", bytes: 11.32 * GB, swapBytes: 0, top: [] }] satisfies MemoryGroup[] };

/** One watch line: 975297 at `gb` with its job's commands at `workGb` and `workCpuS`, the dev server's tree flat at 1.2 GB, the busy tree at work. */
function lineAt(at: number, gb: number, workGb: number, workCpuS: number): WatchLine {
  const footprints: Footprints = { workers: { [KOREAN]: { pids: 9, bytes: gb * GB }, [DEV]: { pids: 4, bytes: 1.2 * GB }, [BUSY]: { pids: 4, bytes: 2 * GB } },
    kernels: [kernel("ko-last-english", 1500001, workGb, workCpuS), kernel("dev-chat", 1500002, 0.5, 40)], swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
  return { host: "us-metal02", ...watchLine({ now: at, rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory }) };
}
/** The check minutes, each 120 CPU seconds past the last, then `after` minutes with the job's commands gone and its CPU flat. */
const timeline = (after: number): WatchLine[] => [...CHECK.map(([gb, work], index) => lineAt(START + index * MIN, gb, work, 600 + 120 * index)),
  ...Array.from({ length: after }, (_, index) => lineAt(START + (CHECK.length + index) * MIN, 0.67, 0, 600 + 120 * CHECK.length))];

test("the watch carries each worker's work bytes and its commands' CPU seconds", () => {
  const korean = timeline(0).at(-1)!.byWorker!.find(worker => worker.pid === KOREAN)!;
  assert.deepEqual({ gb: korean.gb, working: korean.working, workGb: korean.workGb, workCpuS: korean.workCpuS }, { gb: 5.08, working: 0, workGb: 4.38, workCpuS: 2640 });
});

test("a tree whose job's svelte-check runs between turns is at work, so quiet_agent_gb reads only the quiet tree with its idle dev server", () => {
  const watch = timeline(0);
  const at = Date.parse("2026-11-09T10:56:30Z");
  const reading = quietReadings(watch, at, at + MIN, 15 * MIN)[0]!;
  assert.deepEqual(reading.trees.map(tree => tree.pid), [DEV], "975297 sat 17 min with no session working while its check used 2 cores");
  assert.equal(reading.gb, 1.2);
  const output = measure({ now: Date.parse("2026-11-09T10:57:00Z"), watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb, 1.2, "the old count read 5.08 GB of 975297 beside the 1.2 GB, as d7 read 6.68 GB on 11-09");
  assert.match(output.flagged?.find(slice => slice.kind === "quiet_agents")?.excerpt ?? "",
    /dev-chat \(pid 900001, 1\.2 GB, 0\.5 GB of it its sessions' commands, quiet since 10:39Z\)/);
});

test("once the check ends, the tree counts after its own quiet window", () => {
  const watch = timeline(17);
  const end = Date.parse("2026-11-09T10:57:30Z");
  const readings = quietReadings(watch, end, end + 17 * MIN, 15 * MIN);
  assert.ok(readings.slice(0, -1).every(reading => !reading.trees.some(tree => tree.pid === KOREAN)));
  const korean = readings.at(-1)!.trees.find(tree => tree.pid === KOREAN)!;
  assert.deepEqual({ gb: korean.gb, since: korean.since }, { gb: 0.67, since: end + MIN }, "the 10:57:30Z line still read the check's last CPU seconds");
});
