// On 10-19 three tool calls hung for 9 to 13 h on us-metal02 and read working on Settings > Hosts the whole time, so the box never read 0
// working from 01:43Z and d7's quiet_agent_gb had no quiet minute to judge; they were killed by hand at 11:10Z. A fourth, an ssh to the Mac,
// sat 148 min at 11:40Z. The watch now names each hung call (src/hung-calls.ts), d7's hung_calls counts them and Hosts reads them as hung.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, quietAgents } from "../scripts/duties/whole-system.ts";
import { agentCounts } from "../src/agent-states.ts";
import { hostGlance } from "../src/client/hosts.ts";
import { hostsView } from "../src/chat-hosts.ts";
import { callMarks, CallWatch, type KernelCpu } from "../src/hung-calls.ts";
import { type Footprints, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import type { MachineView } from "../../prime-relay/host-stats.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const NOW = Date.parse("2026-10-19T11:06:30Z");

interface Case { id: string; name: string; root: string; since: string; kernelCores: number; workCores: number; command: string | null }
/** The three calls of 10-19, with the CPU they used as read on the box (ps TIME, harnessSplit), and the busy call b2-pack-writer from the 11:40Z sample. */
const CASES: Case[] = [
  { id: "01a150f1-5231-71cd-ae83-0911bf1d9f7a", name: "restart-cold-start", root: "01a14ff6-e911-7508-8f16-2d51528f55d5", since: "2026-10-18T21:41:24Z",
    kernelCores: 0, workCores: 0.01, command: "python3 rig.py base1 /home/sieun/scratch/d7-daemon-faults/start-cost 180" },
  { id: "01a151b0-f7a9-7132-a708-500f3879a9a8", name: "fix4-ops-d2", root: "01a14d72-63fa-776f-9d90-766b7ce76d30", since: "2026-10-19T01:19:07Z",
    kernelCores: 0, workCores: 0, command: "node --import tsx --test test/chat-server-early-listen.test.ts" },
  { id: "01a151e8-37a7-731f-95bc-90ab2e64c9d9", name: "p258-critical-path", root: "01a14ea9-739c-741d-b799-e865881abbf4", since: "2026-10-19T02:07:13Z",
    kernelCores: 0.99, workCores: 0, command: null },
  { id: "01a1534f-0000-7000-8000-000000000001", name: "b2-pack-writer", root: "01a1180e-6567-747f-bf44-452520ebdd1b", since: "2026-10-19T10:00:00Z",
    kernelCores: 0, workCores: 4.15, command: "node scripts/b2/pack-writer.mjs" },
];
const TREES: Record<string, string> = { "01a14ff6-e911-7508-8f16-2d51528f55d5": "d7 clean minutes daemon faults and slow agents 10-19",
  "01a14d72-63fa-776f-9d90-766b7ce76d30": "duties green push 10-18", "01a14ea9-739c-741d-b799-e865881abbf4": "verify-dev push to green", "01a1180e-6567-747f-bf44-452520ebdd1b": "VP of CI" };

const row = (id: string, fields: Record<string, unknown>) => ({ sessionId: id, activeSessionId: id, lifecycle: "live", activity: "working", isSessionActive: true,
  isStreaming: true, isRunningTools: true, isCompacting: false, hasRunningRlmChildren: false, workerPid: 1, ...fields });
const rows = [
  ...Object.keys(TREES).map(id => row(id, { sessionName: TREES[id], isStreaming: false, isRunningTools: false, hasRunningRlmChildren: true, lastActivityAt: "2026-10-19T11:00:00Z" })),
  ...CASES.map(item => row(item.id, { sessionName: item.name, parentSessionId: item.root, lastActivityAt: item.since })),
];
const kernelsAt = (at: number): KernelCpu[] => CASES.map(item => ({ session: item.id, cpu_s: item.kernelCores * (at - NOW + 3600_000) / 1000,
  work_cpu_s: 89 + item.workCores * (at - NOW + 3600_000) / 1000, biggest: item.command ? { command: item.command } : null }));
const footprints = (at: number): Footprints => ({ workers: { 1: { pids: 1, bytes: 1 * GB } }, swap_used_bytes: 0, pressure_level: null, cpu_s: 0,
  kernels: kernelsAt(at).map((kernel, index) => ({ pid: 100 + index, root: CASES[index]!.root, session: kernel.session, pids: 1, bytes: 0.1 * GB, own: 0.05 * GB,
    biggest: kernel.biggest ? { pid: 200 + index, bytes: 1, started: null, command: kernel.biggest.command } : null, cpu_s: kernel.cpu_s!, work_cpu_s: kernel.work_cpu_s! })) });
const name = (session: string) => {
  const item = CASES.find(entry => entry.id === session)!;
  return { name: item.name, root: item.root, tree: TREES[item.root]! };
};
const memory = { groups: [{ id: "agents" as const, label: "Agent sessions", bytes: 11.9 * GB, swapBytes: 0, top: [] }], cacheBytes: 50 * GB };

/** A watch running each minute from 10:36:30Z to 11:06:30Z on the four calls, as `sample` runs it. */
function watchMinutes(calls = new CallWatch(), from = NOW - 30 * MIN): WatchLine[] {
  const lines: WatchLine[] = [];
  for (let at = from; at <= NOW; at += MIN) {
    const marks = callMarks(rows, kernelsAt(at), at);
    const hung = calls.judge(marks, at, name);
    lines.push({ host: "us-metal02", ...watchLine({ now: at, rows, footprints: footprints(at), queue: null, chats: new Set(Object.keys(TREES)), title: id => TREES[id] ?? null,
      cpuMs: 0, usable: null, memory, hung: new Set(hung.map(call => call.session)) }), ...marks.length ? { calls: marks } : {}, ...hung.length ? { hung } : {} });
  }
  return lines;
}

test("the three hung calls of 10-19 are named with their chat, and the busy call is not", () => {
  const calls = new CallWatch();
  const latest = watchMinutes(calls).at(-1)!;
  assert.deepEqual(latest.hung!.map(call => [call.name, call.tree, call.why, call.silentMin]), [
    ["restart-cold-start", "d7 clean minutes daemon faults and slow agents 10-19", "no progress", 805],
    ["fix4-ops-d2", "duties green push 10-18", "no progress", 587],
    ["p258-critical-path", "verify-dev push to green", "kernel burning", 539],
  ]);
  assert.equal(latest.hung![2]!.kernelCores, 0.99);
  assert.deepEqual([...calls.hung()].sort(), CASES.slice(0, 3).map(item => item.id).sort());
});

test("a hung call counts as hung, not working, on the watch line, Settings > Hosts and quiet_agent_gb", async () => {
  const lines = watchMinutes();
  const agents = lines.at(-1)!.agents!;
  assert.equal(agents.hung, 3);
  assert.equal(agents.working, 1, "only the busy call still works");
  const card = (await hostsView({ title: () => null, picks: async () => ({ lastHost: null, lastWorkspace: {} }), rows: () => rows, hung: () => new Set(CASES.slice(0, 3).map(item => item.id)),
    load: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); },
    selfMachine: async (): Promise<MachineView> => ({ platform: "linux", cpu: { percent: 50, cores: 80, load: [1, 1, 1] }, memory: { usedBytes: 100 * GB, totalBytes: 247 * GB,
      swapUsedBytes: 0, swapTotalBytes: 16 * GB, pressure: "normal", groups: [], cacheBytes: 0 } }),
    selfQueue: async () => ({ state: "unread", error: "off" }) })()).hosts[0]!;
  assert.equal(hostGlance(card), "50% CPU · 100 of 247 GB · 1 working, 4 waiting, 3 hung");
  const quietRows = rows.filter(entry => entry.sessionId !== CASES[3]!.id);
  const quiet = Array.from({ length: 20 }, (_, minute) => NOW - (19 - minute) * MIN).map(at => ({ host: "us-metal02",
    ...watchLine({ now: at, rows: quietRows, footprints: footprints(at), queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory,
      hung: new Set(CASES.slice(0, 3).map(item => item.id)) }) }));
  assert.equal(quietAgents(quiet, NOW, NOW + MIN, 15 * MIN).length, 1, "with only the hung calls left, the box reads quiet");
  assert.deepEqual(agentCounts(rows), { working: 4, children: 4, retry: 0, idle: 0, hung: 0 }, "without the watch's reading every call reads working");
});

test("d7 counts hung_calls and names each call with its session and chat for the duty's job", () => {
  const output = measure({ now: NOW + 30_000, watch: watchMinutes(), log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.hung_calls, 3);
  const flagged = (output.flagged ?? []).filter(slice => slice.kind === "hung_call");
  assert.deepEqual(flagged.map(slice => [slice.chat, slice.item]), CASES.slice(0, 3).map(item => [item.root, item.id]));
  assert.match(flagged[0]!.excerpt, /^d7 clean minutes daemon faults and slow agents 10-19: restart-cold-start \(01a150f1-.*\) has run one tool call for 805 min with no output, its commands at 0\.01 cores \(python3 rig\.py/);
  assert.match(flagged[2]!.excerpt, /its kernel burning 0\.99 cores/);
  assert.equal(measure({ now: NOW, watch: [], log: { holds: [] }, chats: [] }).metrics.hung_calls, undefined, "no line from a watch that judges calls, no reading");
});

test("a call is judged only past an hour of silence on 20 min of marks, and a restart picks its marks back up from the lines", () => {
  const young = new CallWatch();
  const at = Date.parse("2026-10-19T10:50:00Z");
  young.judge(callMarks([row("x", { lastActivityAt: "2026-10-19T10:10:00Z" })], [{ session: "x", cpu_s: 0, work_cpu_s: 0, biggest: null }], at - 25 * MIN), at - 25 * MIN, name);
  assert.deepEqual(young.judge(callMarks([row("x", { lastActivityAt: "2026-10-19T10:10:00Z" })], [{ session: "x", cpu_s: 0, work_cpu_s: 0, biggest: null }], at), at, () => ({ name: "x", root: "x", tree: "x" })), [],
    "40 min of silence is not an hour");
  const lines = watchMinutes(new CallWatch(), NOW - 30 * MIN).slice(0, 25);
  const restarted = new CallWatch();
  assert.deepEqual(restarted.judge(callMarks(rows, kernelsAt(NOW), NOW), NOW, name), [], "a fresh watch has no marks to judge on");
  restarted.seed(lines);
  assert.equal(restarted.judge(callMarks(rows, kernelsAt(NOW + MIN), NOW + MIN), NOW + MIN, name).length, 3);
});
