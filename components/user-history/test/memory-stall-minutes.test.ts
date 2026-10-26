// us-metal02 from 02:22Z to 02:26Z on 10-26: CI and RepoOps' job processes grew to 231 GB, swap read 80 of 80 GB, memory full stall rose from
// about 2% to 13.5 to 41.4%, and the chat's event loop stalled 1.6 to 6.4 s. d7 named the minutes "cpu" and booked 2 of the 5 to the apps by cores.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinuxUsable } from "../../prime-relay/host-stats.ts";
import { agentLine, type AgentLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { measure } from "../scripts/duties/whole-system.ts";

const RUN = Date.parse("2026-10-26T02:32:10Z");
const cpuCores = { harness: 25.82, apps: 26.49, owner: 0, ci: 18.86, system: 3.63 };
const linux = (memFullAvg10: number, swapoutsPerS: number): LinuxUsable => ({ kind: "linux", memSomeAvg10: memFullAvg10, memFullAvg10, cpuSomeAvg10: 48.91,
  swapoutsPerS, runnablePerCore: 2.49, allowedCpus: 80, cpuCores });
const agents = (largest: AgentLine["largest"]): AgentLine => ({ gb: 85.58, swapGb: 21.03, working: 45, children: 7, retry: 0, idle: 8, hung: 0, ...largest ? { largest } : {} });
const line = (minute: number, usable: LinuxUsable, extra: Partial<WatchLine> = {}): WatchLine => ({
  at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), host: "us-metal02", usable, workers: 24, workerGb: 182.29,
  top: [{ pid: 2023281, gb: 167.94, sessions: 4, root: "01a1180e-6567-747f-bf44-452520ebdd1b", tree: "CI and RepoOps", workGb: 167.07 },
    { pid: 2029648, gb: 1.44, sessions: 8, root: "01a115e2-9544-7204-b8db-8ce4d5319048", tree: "Crawler VP", workGb: 0.36 }],
  live: 60, working: 45, queue: null, mac: { swapGb: 80, pressureLevel: null }, cpuMs: 0, ...extra });
const stalled = (largest: AgentLine["largest"], memFull = 25.64) => Array.from({ length: 30 }, (_, minute) => minute === 28
  ? line(minute, linux(memFull, 39_887), { agents: agents(largest), chat: { readMs: 1, read: "api/slack", loopMs: 5335, gcMs: 5311, gc: "minor" } })
  : line(minute, { ...linux(1.96, 246), runnablePerCore: 0.5 }, { agents: agents(largest) }));
const run = (lines: WatchLine[]) => measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [] });

test("a memory stall names its pressure and the tree that held the most, and goes to the group that held the most memory", () => {
  const { metrics, flagged } = run(stalled("agents"));
  assert.equal(metrics.clean_min_30, 29);
  assert.equal(metrics.harness_unusable_min_30, 1, "agent sessions held the most memory, though the apps used more cores");
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /02:30Z us-metal02 unusable \(cpu: the chat's event loop stalled 5\.3 s \(a minor GC took 5\.3 s\); memory full 25\.64% of the last 10 s with 39887 swap-outs a second, the agents group held the most memory, the job processes of CI and RepoOps 167\.07 GB\)$/);
});

test("a memory stall another group held the most of is that group's, and a minute under the stall line keeps the CPU side", () => {
  assert.equal(run(stalled("docker")).metrics.harness_unusable_min_30, 0);
  const calm = run(stalled("agents", 3.7));
  assert.equal(calm.metrics.harness_unusable_min_30, 0, "3.7% is the highest calm minute of 10-26, so the cores decide");
  assert.doesNotMatch(calm.flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /memory full/);
});

test("the watch line names the group that held the most memory", () => {
  const groups = [{ id: "docker" as const, label: "", bytes: 25e9, top: [] }, { id: "agents" as const, label: "", bytes: 85e9, swapBytes: 21e9, top: [] }];
  assert.equal(agentLine({ groups }, []).largest, "agents");
  assert.equal(agentLine({ groups: null }, []).largest, undefined);
});
