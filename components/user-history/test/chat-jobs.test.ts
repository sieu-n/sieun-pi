import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { projectRow, subagentSessions } from "../src/chat-catalog.ts";

const summary = (over: Partial<SessionSummary>): SessionSummary => ({ id: "x", lifecycle: "live", activity: "idle", isSessionActive: false, sessionId: "x", cwd: "/r", isStreaming: false, isCompacting: false,
  attachedClients: 0, messageCount: 2, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, ...over } as unknown as SessionSummary);

test("subagentSessions carries the daemon status, the failure and the first task of each subagent session", () => {
  const sessions = subagentSessions([
    summary({ sessionId: "s1", rlmChildId: "sub-1", sessionName: "ux-email", lastActivityAt: "2026-10-06T01:00:00Z", firstMessage: "Audit the email flow" }),
    summary({ sessionId: "s2", rlmChildId: "sub-2", sessionName: "ux-monitor", activeSessionId: "a2", activity: "working", summary: "Reading routes", lastActivityAt: "2026-10-06T00:30:00Z" }),
    summary({ sessionId: "s3", rlmChildId: "sub-3", sessionName: "w7", activeSessionId: "a3", lastActivityAt: "2026-10-06T02:00:00Z", statusLabel: "failed", summary: "Model request failed: x", taskState: "error" } as Partial<SessionSummary>),
  ]);
  assert.deepEqual(sessions.map(session => [session.sessionId, session.childId, session.name, session.running, session.failed, session.activity ?? "", session.first ?? ""]), [
    ["s1", "sub-1", "ux-email", false, false, "", "Audit the email flow"],
    ["s2", "sub-2", "ux-monitor", true, false, "Reading routes", ""],
    ["s3", "sub-3", "w7", false, true, "Model request failed: x", ""],
  ]);
});

test("a chat row carries its agents and stays unread while it works; a plain row does not", () => {
  const base = summary({ activeSessionId: "live", hasRunningRlmChildren: true, lastActivityAt: "2026-10-06T02:00:00Z" });
  const agent = { key: "child:sub-1", sessionId: "s1", childId: "sub-1", name: "job", job: "job", sender: "job", link: "subagent" as const, state: "working" as const, steps: [] };
  const chat = projectRow(base, Date.parse("2026-10-06T01:00:00Z"), 0, { chat: true, agents: [agent] });
  assert.equal(chat.working, true);
  assert.equal(chat.unread, true);
  assert.deepEqual(chat.agents?.map(entry => entry.name), ["job"]);
  const plain = projectRow(base, Date.parse("2026-10-06T01:00:00Z"), 0);
  assert.equal(plain.unread, false);
  assert.equal(plain.agents, undefined);
});
