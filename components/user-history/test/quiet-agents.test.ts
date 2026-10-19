// The owner on 10-19 at 08:4x KST, with Settings > Hosts on us-metal02 showing "0 working, 0 waiting" and Agent sessions at 102.5 GB: "look,
// when everybody's asleep it should drop ram". At 23:46:30Z on 10-18 the watch read 220 of 228 live sessions as working and 101.26 GB in
// workers, while almost every one of them sat in a provider retry or pool slot wait, and d7's sleeping_gb read 0.72 GB against 0.25.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupGroups, heldBytes, type MachineView, type MemoryGroup } from "../../prime-relay/host-stats.ts";
import { measure, quietAgents } from "../scripts/duties/whole-system.ts";
import { agentCounts } from "../src/agent-states.ts";
import { hostGlance } from "../src/client/hosts.ts";
import { type Footprints, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { judge } from "../src/shared/chat-duties.ts";
import type { HostCard } from "../src/shared/types.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const RUN = Date.parse("2026-10-18T23:47:08Z");
const duty = JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/whole-system.duty.json"), "utf8")) as { metrics: Parameters<typeof judge>[0] };
const footprints: Footprints = { workers: {}, kernels: [], swap_used_bytes: 15.7 * GB, pressure_level: null, cpu_s: 0 };

const row = (id: string, fields: Record<string, unknown>) => ({ sessionId: id, activeSessionId: id, lifecycle: "live", activity: "idle", isSessionActive: false,
  isStreaming: false, isRunningTools: false, isCompacting: false, hasRunningRlmChildren: false, workerPid: 1, lastActivityAt: "2026-10-18T23:15:00Z", ...fields });
/** A session parked in Prime's provider retry loop: the daemon reads it working with a turn open and nothing streaming. */
const retrying = (id: string) => row(id, { activity: "working", isSessionActive: true, unfinishedActionCount: 1 });
const RETRY_ROWS = [...Array.from({ length: 220 }, (_, index) => retrying(`retry-${index}`)), ...Array.from({ length: 8 }, (_, index) => row(`idle-${index}`, {}))];
const streaming = row("vp", { activity: "working", isSessionActive: true, isStreaming: true });

/** The agents group as host-stats.ts `memoryByGroup` gives it, the reading Settings > Hosts draws. */
const memory = (agentGb: number) => ({ groups: [{ id: "agents", label: "Agent sessions", bytes: agentGb * GB, swapBytes: 6.6 * GB, top: [] },
  { id: "docker", label: "Docker", bytes: 12.1 * GB, top: [] }] satisfies MemoryGroup[], cacheBytes: 59.9 * GB });
const lineAt = (at: number, rows: readonly unknown[], agentGb: number): WatchLine => ({ host: "us-metal02",
  ...watchLine({ now: at, rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory: memory(agentGb) }) });
/** One line a minute at hh:mm:30 from `from` to 23:46:30Z, with a session streaming in the minutes `working` holds. */
const evening = (agentGb: number, working: (at: number) => boolean, from = Date.parse("2026-10-18T22:47:30Z")): WatchLine[] => {
  const lines: WatchLine[] = [];
  for (let at = from; at <= Date.parse("2026-10-18T23:46:30Z"); at += MIN) lines.push(lineAt(at, working(at) ? [...RETRY_ROWS, streaming] : RETRY_ROWS, agentGb));
  return lines;
};
const lastTurn = Date.parse("2026-10-18T23:20:30Z");

test("a session in a provider retry wait is not working: 220 retry rows read 0 working and 220 waiting", () => {
  assert.deepEqual(agentCounts(RETRY_ROWS), { working: 0, children: 0, retry: 220, idle: 8 });
  assert.deepEqual(agentCounts([streaming, row("parent", { activity: "working", isSessionActive: true, hasRunningRlmChildren: true }), row("stopped", { lifecycle: "archived" })]),
    { working: 1, children: 1, retry: 0, idle: 0 });
  const machine: MachineView = { platform: "linux", cpu: { percent: 18, cores: 80, load: [1, 1, 1] }, memory: { usedBytes: 124.5 * GB, totalBytes: 247.2 * GB,
    swapUsedBytes: 15.7 * GB, swapTotalBytes: 16 * GB, pressure: "normal", ...memory(101.26) } };
  const card: HostCard = { name: "us-metal02", address: "100.83.139.73", roles: [], self: true, state: "up", daemon: "answering", pingMs: null, machine,
    queue: { state: "unread", error: "pi-pool queue is off" }, sessions: agentCounts(RETRY_ROWS) };
  assert.equal(hostGlance(card), "18% CPU · 125 of 247 GB · 0 working, 220 waiting");
});

test("the 23:46Z state reads red: Agent sessions held 101 GB 26 min after the last turn ended with 220 sessions in retry wait", () => {
  const lines = evening(101.26, at => at <= lastTurn);
  const latest = lines.at(-1)!;
  assert.equal(latest.working, 220, "the daemon's own activity count still reads them working");
  assert.deepEqual(latest.agents, { gb: 101.26, swapGb: 6.6, cacheGb: 59.9, working: 0, children: 0, retry: 220, idle: 8 });
  const output = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb, 101.26);
  assert.equal(output.metrics.sleeping_gb, undefined);
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "missed");
  assert.equal(verdict.metrics.quiet_agent_gb?.met, false);
  assert.match(verdict.summary, /^quiet_agent_gb 101\.3 GB \(target at most 5 GB\)/);
  assert.match(output.flagged?.find(slice => slice.kind === "quiet_agents")?.excerpt ?? "",
    /^us-metal02's Agent sessions held 101\.26 GB \(6\.6 GB of it in swap\) with 59\.9 GB of file cache beside it, with 0 sessions working, 220 waiting on the provider or the pool, 0 on their subagents and 8 idle at 23:46Z, 25 min into a stretch with no session working that began by 23:21Z/);
});

test("a quiet stretch where the box dropped its agents' memory reads green", () => {
  const output = measure({ now: RUN, watch: evening(3.2, at => at <= lastTurn), log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb, 3.2);
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.metrics.quiet_agent_gb?.met, true);
  assert.match(verdict.summary, /^quiet_agent_gb 3\.2 GB \(on target\)/);
});

test("the quiet window is one setting: minutes inside it are not judged, and a box at work all window leaves the metric unmeasured", () => {
  const recent = evening(101.26, at => at <= Date.parse("2026-10-18T23:35:30Z"));
  assert.deepEqual(quietAgents(recent, RUN - 31 * MIN, RUN, 15 * MIN), [], "11 min after the last turn is inside the window");
  assert.equal(quietAgents(recent, RUN - 31 * MIN, RUN, 10 * MIN).length, 1, "a 10 min setting judges 23:46Z");
  const busy = measure({ now: RUN, watch: evening(101.26, () => true), log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(busy.metrics.quiet_agent_gb, undefined);
  assert.match(judge(duty.metrics, busy).summary, /not measured: the precheck gave no value for quiet_agent_gb \(No box went 15 min with no session working/);
  const gap = evening(101.26, at => at <= lastTurn).filter(line => Date.parse(line.at) < Date.parse("2026-10-18T23:30:00Z") || Date.parse(line.at) > Date.parse("2026-10-18T23:34:00Z"));
  assert.ok(quietAgents(gap, RUN - 31 * MIN, RUN, 15 * MIN).every(minute => minute.since >= Date.parse("2026-10-18T23:34:00Z")), "a watch gap restarts the stretch");
});

test("Hosts counts memory the box cannot take back: anon, shmem and swap, with file cache apart", () => {
  // The Prime daemon cgroup at 01:11Z on 10-19: memory.current 109.4 GB, of it 43.7 GB anon, 56.5 GB file (3.0 GB of that shmem) and 8.4 GB slab.
  const bytes = (gb: number) => Math.round(gb * GB);
  const stat = [`anon ${bytes(43.7)}`, `file ${bytes(56.5)}`, `kernel ${bytes(9.1)}`, `shmem ${bytes(3)}`, `slab_reclaimable ${bytes(8.4)}`].join("\n") + "\n";
  const held = heldBytes(stat, `${bytes(6.75)}\n`)!;
  assert.equal(Math.round(10 * held.bytes / GB) / 10, 53.5);
  assert.equal(held.swapBytes / GB, 6.75);
  assert.equal(Math.round(10 * held.cacheBytes / GB) / 10, 53.5);
  assert.equal(heldBytes("", ""), null);
  const groups = cgroupGroups([{ path: "user.slice/user-1001.slice/user@1001.service/app.slice/prime-agent-daemon.service", ...held },
    { path: "user.slice/user-1001.slice/user@1001.service/app.slice/sieun-pi-chat.service", bytes: 1.4 * GB, swapBytes: 0, cacheBytes: 0 }])!;
  assert.equal(groups[0]!.id, "agents");
  assert.equal(Math.round(10 * groups[0]!.bytes / GB) / 10, 54.9);
  assert.equal(groups[0]!.swapBytes, 6.75 * GB);
});
