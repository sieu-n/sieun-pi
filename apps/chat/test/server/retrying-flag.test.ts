/**
 * pi-host's "retrying since HH:MM: <kind>" flag reaches an agent's summary: its comm thread's for the room's working line, and its own
 * turn's from the work thread's root node, or from the row while the thread has no jobs (`rootRetrying` in server/agents.ts).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { agentSummary, rootRetrying } from "../../server/agents.ts";
import type { AgentRecord } from "../../server/agent-store.ts";
import type { DurableThread, TreeNode } from "../../server/host/types.ts";

const FLAG = "retrying since 08:22: pi-pool token hook lock_wait_timeout";
const record: AgentRecord = { id: "ag_vent", slug: "vent", name: "vent", room: "dm_vent", workThread: "W", host: "us-metal02", home: "/tmp", createdAt: 1, archived: false };
const row = (id: string, extra: Partial<DurableThread> = {}): DurableThread => ({
  id, name: id, provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/tmp", createdAt: 1, updatedAt: 2, failed: false,
  archived: false, preview: "", children: 0, status: "sleeping", ...extra,
});
const node = (id: number, extra: Partial<TreeNode> = {}): TreeNode => ({ id, parent: id === 1 ? null : 1, ownerTask: null, name: `n${id}`, depth: id === 1 ? 0 : 1, status: "idle", model: null, createdAt: null, ...extra });
const extra = { model: null, rooms: [] };

test("a comm thread's flag shows on its room's comm entry, and the agent's own flag stays off", () => {
  const summary = agentSummary(record, { row: row("W"), tree: [], jobs: [], comm: [{ room: "ch_relay", thread: "C", row: row("C", { retrying: FLAG }) }] }, extra);
  assert.deepEqual(summary.comm, [{ room: "ch_relay", thread: "C", status: "sleeping", retrying: FLAG }]);
  assert.equal(summary.retrying, undefined);
});

test("the agent's own flag comes from its root node, so a retrying job conversation does not mark the agent", () => {
  assert.equal(rootRetrying({ row: row("W", { retrying: FLAG, children: 1 }), tree: [node(1), node(2, { retrying: FLAG })] }), undefined);
  assert.equal(rootRetrying({ row: row("W", { retrying: FLAG, children: 1 }), tree: [node(1, { retrying: FLAG }), node(2)] }), FLAG);
  assert.equal(rootRetrying({ row: row("W", { retrying: FLAG }), tree: [] }), FLAG, "a thread with no jobs reads its row");
  assert.equal(agentSummary(record, { row: row("W", { retrying: FLAG }), tree: [], jobs: [] }, extra).retrying, FLAG);
});
