import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { chatJobs, projectRow } from "../src/chat-catalog.ts";

const summary = (over: Partial<SessionSummary>): SessionSummary => ({ id: "x", lifecycle: "live", activity: "idle", isSessionActive: false, sessionId: "x", cwd: "/r", isStreaming: false, isCompacting: false,
  attachedClients: 0, messageCount: 2, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, ...over } as unknown as SessionSummary);

test("chatJobs lists a chat's subagent sessions, running first, then newest", () => {
  const jobs = chatJobs([
    summary({ sessionId: "s1", rlmChildId: "sub-1", sessionName: "ux-email", lastActivityAt: "2026-10-06T01:00:00Z" }),
    summary({ sessionId: "s2", rlmChildId: "sub-2", sessionName: "ux-monitor", activeSessionId: "a2", activity: "working", summary: "Reading routes", lastActivityAt: "2026-10-06T00:30:00Z" }),
    summary({ sessionId: "s3", rlmChildId: "sub-3", sessionName: "w7", activeSessionId: "a3", lastActivityAt: "2026-10-06T02:00:00Z", statusLabel: "failed", summary: "Model request failed: x", taskState: "error" } as Partial<SessionSummary>),
  ]);
  assert.deepEqual(jobs.map(job => [job.id, job.status, job.activity ?? "", job.failed ?? false]), [
    ["s2", "running", "Reading routes", false],
    ["s3", "idle", "Model request failed: x", true],
    ["s1", "saved", "", false],
  ]);
  assert.equal(jobs[0]?.childId, "sub-2");
  assert.equal(jobs[0]?.name, "ux-monitor");
});

test("a chat row carries its jobs and stays unread while it works; a plain row does not", () => {
  const base = summary({ activeSessionId: "live", hasRunningRlmChildren: true, lastActivityAt: "2026-10-06T02:00:00Z" });
  const chat = projectRow(base, Date.parse("2026-10-06T01:00:00Z"), 0, { chat: true, jobs: chatJobs([summary({ sessionId: "s1", rlmChildId: "sub-1", sessionName: "job" })]) });
  assert.equal(chat.working, true);
  assert.equal(chat.unread, true);
  assert.deepEqual(chat.jobs?.map(job => job.name), ["job"]);
  const plain = projectRow(base, Date.parse("2026-10-06T01:00:00Z"), 0);
  assert.equal(plain.unread, false);
  assert.equal(plain.jobs, undefined);
});
