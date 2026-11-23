/**
 * A failed work thread reads failed on the agent ahead of a running job (`agentStatus` in server/agents.ts). On 11-23 agent factory's work
 * thread failed 11 turns in compaction while its jobs ran, and its Agents card read working all day.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { agentStatus } from "../../server/agents.ts";
import type { DurableThread, TreeNode } from "../../server/host/types.ts";

const row = (id: string, status: DurableThread["status"]): DurableThread => ({
  id, name: id, provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/tmp", createdAt: 1, updatedAt: 2,
  failed: status === "failed", archived: false, preview: "", children: 0, status,
});
const node = (id: number, status: TreeNode["status"]): TreeNode => ({ id, parent: id === 1 ? null : 1, ownerTask: null, name: `n${id}`, depth: id === 1 ? 0 : 1, status, model: null, createdAt: null });

test("a failed work thread reads failed while a job runs, and a sleeping one reads working", () => {
  assert.equal(agentStatus({ row: row("W", "failed"), tree: [node(1, "idle")], jobs: [row("J", "running")] }), "failed");
  assert.equal(agentStatus({ row: row("W", "sleeping"), tree: [node(1, "idle")], jobs: [row("J", "running")] }), "working");
  assert.equal(agentStatus({ row: row("W", "running"), tree: [node(1, "running")], jobs: [] }), "working");
  assert.equal(agentStatus({ row: row("W", "sleeping"), tree: [], jobs: [] }), "sleeping");
});
