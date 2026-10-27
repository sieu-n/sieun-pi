// The owner's Settings > Hosts screenshot of us-metal02 at about 17:00Z on 10-27 read "0 working, 0 waiting" at 93% CPU. The watch read the same
// at 16:48:56Z, the first minute after the reboot, and at 16:55:30Z, after a supervisor restart left daemon.sock missing from 16:55:11Z: the
// rows read no live session and pi-pool held 0 working and 0 queued, while CI guests, Docker and jobs' units kept the CPU busy.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineView } from "../../../../components/prime-relay/host-stats.ts";
import { hostCounts } from "../src/agent-states.ts";
import { hostsView } from "../src/chat-hosts.ts";
import { hostGlance } from "../src/client/hosts.ts";
import type { AgentQueuePool } from "../src/shared/types.ts";

const GB = 1024 ** 3;
const row = (id: string, fields: Record<string, unknown>) => ({ sessionId: id, activeSessionId: id, lifecycle: "live", activity: "idle", isSessionActive: false,
  isStreaming: false, isRunningTools: false, isCompacting: false, hasRunningRlmChildren: false, ...fields });
const streaming = (id: string) => row(id, { activity: "working", isSessionActive: true, isStreaming: true });
/** Rows a new supervisor lists before it loads them: stopped, so no state. */
const unloaded = (id: string) => ({ sessionId: id, lifecycle: "stopped" });
const queue = (working: number, queued: number): AgentQueuePool => ({ state: "read", enabled: true, workingMax: 20, workingMaxSet: null, treeWorkingMax: 60, rows: [],
  working: Array.from({ length: working }, (_, index) => ({ session: `w${index}`, tree: "t", since: 0, kind: "slot" })) as never,
  queued: Array.from({ length: queued }, (_, index) => ({ session: `q${index}`, tree: "t", since: 0, position: index + 1, total: queued, waitMs: 0 })) as never });
const machine: MachineView = { platform: "linux", cpu: { percent: 93, cores: 80, load: [80, 80, 80] },
  memory: { usedBytes: 186 * GB, totalBytes: 247 * GB, swapUsedBytes: 0, swapTotalBytes: 79 * GB, pressure: "normal", groups: [], cacheBytes: 0 } };
const card = async (rows: readonly unknown[], pool: AgentQueuePool, daemonUp = true) => (await hostsView({ title: () => null,
  picks: async () => ({ lastHost: null, lastWorkspace: {} }), rows: () => rows, selfDaemon: () => daemonUp,
  load: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, selfMachine: async () => machine, selfQueue: async () => pool })()).hosts[0]!;

test("rows that read no loaded session and an empty pool read sessions not read, not 0 working, 0 waiting", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => unloaded(`s${index}`));
  assert.equal(hostCounts(rows, { working: 0, queued: 0 }), null);
  assert.equal(hostGlance(await card(rows, queue(0, 0))), "93% CPU · 186 of 247 GB · sessions not read");
});

test("the pool's queue is a floor for working and waiting while the rows lag it", async () => {
  const rows = [...Array.from({ length: 30 }, (_, index) => unloaded(`s${index}`)), streaming("a")];
  assert.deepEqual(hostCounts(rows, { working: 20, queued: 15 }), { working: 20, children: 0, retry: 15, idle: 0, hung: 0 });
  assert.equal(hostGlance(await card(rows, queue(20, 15))), "93% CPU · 186 of 247 GB · 20 working, 15 waiting");
  const settled = [...Array.from({ length: 21 }, (_, index) => streaming(`w${index}`)),
    ...Array.from({ length: 19 }, (_, index) => row(`r${index}`, { activity: "working", isSessionActive: true, waitingFor: "a turn, place 2 of 19" }))];
  assert.deepEqual(hostCounts(settled, { working: 20, queued: 15 }), { working: 21, children: 0, retry: 19, idle: 0, hung: 0 }, "settled rows above the pool keep their own counts");
  assert.deepEqual(hostCounts(settled, null), { working: 21, children: 0, retry: 19, idle: 0, hung: 0 }, "an unread pool leaves the rows alone");
});

test("this box's card reads daemon down while its daemon link is down", async () => {
  assert.equal(hostGlance(await card([streaming("a")], queue(0, 0), false)), "93% CPU · 186 of 247 GB · daemon down");
});
