/**
 * A durable thread's ipython cell that ran rlm.spawn shows a job pill for each child it started, and a child's notice, which reaches the
 * parent as an agent message from `<thread>:<conversation>`, is drawn as that job's message.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/rlm-jobs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item, Principal } from "../../web/src/lib/api/types.ts";
import type { ContentBlock, EntryRecord, TreeNode } from "../../server/host/types.ts";
import { buildItems, type TimelineContext } from "../../server/timeline.ts";

let nextId = 1;
const user = (text: string): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: nextId }] });
const assistant = (...content: ContentBlock[]): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp: nextId }] });
const result = (callId: string, name: string, text: string, details?: Record<string, unknown>): EntryRecord => ({
  id: nextId++, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: nextId, ...(details ? { details } : {}) }],
});
const agentMessage = (from: string, via: string, text: string): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "agent.message", data: { from, via }, model: [{ role: "user", content: [{ type: "text", text }], timestamp: nextId }] });

const tree: TreeNode[] = [
  { id: 1, parent: null, ownerTask: null, name: "VP", depth: 0, status: "idle", model: null, createdAt: 1 },
  { id: 2, parent: 1, ownerTask: 5, name: "counter", depth: 1, status: "running", model: "anthropic/claude-opus-5-5", createdAt: 2 },
  { id: 3, parent: 1, ownerTask: 5, name: "replier", depth: 1, status: "idle", model: "anthropic/claude-opus-5-5", createdAt: 3 },
];
const principal = (id: string): Principal => {
  const node = tree.find(n => `t:${n.id}` === id);
  return node ? { id, kind: "job", name: node.name, avatar: { initials: node.name.slice(0, 2).toUpperCase(), hue: 2 } } : { id, kind: "owner", name: id, avatar: { initials: "?", hue: 0 } };
};
const ctx: TimelineContext = {
  thread: "t", conversation: 1, agent: { id: "t", kind: "chat", name: "VP", avatar: { initials: "VP", hue: 1 } }, principal, tree,
  jobStatus: id => (id === 2 ? "working" : "idle"), running: false,
};
const turn = (items: readonly Item[]) => items.find((i): i is Extract<Item, { kind: "turn" }> => i.kind === "turn")!;

test("an ipython cell that spawned two children shows a pill for each, and the step links the first", () => {
  const items = buildItems([
    user("Split the work."),
    assistant({ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "a = await rlm.spawn('count', name='counter')\nb = await rlm.spawn('reply', name='replier')" } }),
    result("c1", "ipython", "", { conversationId: 2, conversations: [2, 3] }),
    assistant({ type: "text", text: "Both started." }),
  ], ctx);
  const t = turn(items);
  assert.deepEqual(t.jobs.map(j => [j.conversation, j.name, j.status]), [["t:2", "counter", "working"], ["t:3", "replier", "idle"]]);
  const step = t.steps.find(s => s.kind === "tool");
  assert.equal(step?.kind === "tool" ? step.job : undefined, "t:2");
});

test("a child's notice and its reply are drawn as messages from the job", () => {
  const items = buildItems([
    agentMessage("t:2", "rlm.child", "[child-exited: no-reply child:counter]\n\nLast assistant text: seven"),
    agentMessage("t:3", "agent_message", "[agent-message from child:replier]\n\ndone: 5"),
  ], ctx);
  const messages = items.filter(i => i.kind === "message");
  assert.deepEqual(messages.map(m => [m.author.name, m.author.kind, m.text.split("\n")[0]]), [
    ["counter", "job", "[child-exited: no-reply child:counter]"],
    ["replier", "job", "[agent-message from child:replier]"],
  ]);
});
