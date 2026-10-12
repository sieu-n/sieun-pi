import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { childrenByParent, projectRow, subtreeOf } from "../src/chat-catalog.ts";
import { activeAgents } from "../src/client/active-agents.ts";

type Status = "running" | "idle" | "inactive";
const summary = (sessionId: string, status: Status, extra: Record<string, unknown> = {}) => ({ sessionId, cwd: "/w", lifecycle: status === "inactive" ? "inactive" : "live",
  activity: status === "running" ? "working" : "idle", isSessionActive: status === "running", rosterStatus: status, isStreaming: status === "running", isCompacting: false,
  attachedClients: 0, messageCount: 4, ...(status === "inactive" ? {} : { activeSessionId: sessionId }), sessionActions: { queuedCount: 0, steering: [], followUps: [] }, ...extra }) as unknown as SessionSummary;
const child = (sessionId: string, parent: string, depth: number, status: Status) => summary(sessionId, status, { parentSessionId: parent, rlmChildId: "sub-" + sessionId, runtimeKind: "subagent", rlmDepth: depth });

test("active agents: every running session counts once, top-level or a subagent at any depth; idle, saved and archived ones do not", () => {
  const top = [
    summary("chat", "running"),
    summary("idle-chat", "idle", { hasRunningRlmChildren: true }),
    summary("duty-job", "running"),
    summary("saved", "inactive"),
    summary("archived", "inactive", { lifecycle: "archived" }),
  ];
  const children = [
    child("job-a", "chat", 1, "running"),
    child("job-b", "chat", 1, "idle"),
    child("helper-b1", "job-b", 2, "running"),
    child("helper-b2", "job-b", 2, "inactive"),
    child("job-c", "idle-chat", 1, "idle"),
    child("helper-c1", "job-c", 2, "running"),
    child("deep-c1", "helper-c1", 3, "running"),
    child("job-d", "saved", 1, "inactive"),
    child("job-a", "chat", 1, "inactive"),
  ];
  const tree = childrenByParent(children);
  const rows = top.map(row => projectRow(row, undefined, 0, { subtree: subtreeOf(row, tree) }));
  const daemon = new Set([...top, ...children].filter(row => row.rosterStatus === "running").map(row => row.sessionId)).size;
  assert.equal(daemon, 6);
  assert.deepEqual(activeAgents(rows), { total: 6, threads: 2, subagents: 4 });
});

test("active agents: an archived row's own turn is left out, and no rows count zero", () => {
  assert.deepEqual(activeAgents([{ status: "running", archived: true, subagentsRunning: 0 }, { status: "idle", archived: false, subagentsRunning: 2 }]), { total: 2, threads: 0, subagents: 2 });
  assert.deepEqual(activeAgents([]), { total: 0, threads: 0, subagents: 0 });
});
