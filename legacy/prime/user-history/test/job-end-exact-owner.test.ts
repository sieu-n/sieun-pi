// AI harness chat 10-27: at 02:49Z it was told "[job] harness ended its turn, and these open steps name it: p1097, p1106, p1108" and at 02:51Z
// "[job] daemon ended its turn ... p1108, p1113". harness and daemon were subagents of the job pi extension migration research, and no step
// named them in its job or sessionId field: p1108's job was harness fix resume copy check, and its note said "straight to the daemon twice".
// The notice matched a job's name as a word anywhere in a step's job, note or text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leftOpenSteps, rootLeftSteps } from "../src/chat-checkin.ts";
import type { ChatAgent, ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

const at = "2026-10-27T02:49:09Z";
const daemonSession = "01a17b29-570d-70d5-a7df-b0953c9b3516";
const p1108 = (fields: Partial<PlanItem> = {}): PlanItem => ({ id: "p1108", status: "doing", children: [], job: "harness fix resume copy check",
  sessionId: "01a17acc-88a0-7479-a871-29173a9c13e7", text: "Job resume continues go through the outbox copy check (option B)",
  note: "A timed-out sweep 'continue' now goes through the outbox once instead of straight to the daemon twice.", ...fields });
const p1113: PlanItem = { id: "p1113", status: "doing", children: [], sessionId: "01a14210-4e7d-72c3-aa67-e3d476f4e728",
  text: "Prime's own fixes are built and installed: supervisor speed, queue counts, durable input", note: "C (a log line per daemon call)" };
const board = (...plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: at, todos: [], plan }) as unknown as ChatBoard;
const daemon: ChildAgent = { id: "sub-bc336459", label: "daemon", sessionName: "daemon", sessionId: daemonSession, status: "done", lastActivityAt: Date.parse(at) };
const daemonRoot: ChatAgent = { key: `thread:${daemonSession}`, sessionId: daemonSession, name: "daemon", job: `session:${daemonSession}`, sender: "daemon",
  link: "root", state: "idle", steps: [], lastActivityAt: at };

test("a job named daemon is not tied to steps whose note or text says daemon", () => {
  assert.deepEqual(leftOpenSteps(daemon, [daemon], board(p1108(), p1113)).map(step => step.id), []);
  assert.deepEqual(rootLeftSteps(daemonRoot, [daemonRoot], board(p1108(), p1113)).map(step => step.id), []);
});

test("a step is tied to the ended job by its exact job name or session id", () => {
  const step = (id: string, link: Pick<PlanItem, "job"> | Pick<PlanItem, "sessionId">): PlanItem =>
    ({ id, status: "doing", children: [], text: "Fix the daemon", note: "daemon", ...link });
  const byJob = step("p1", { job: "daemon" });
  const bySession = step("p2", { sessionId: daemonSession });
  const byChildId = step("p3", { job: "sub-bc336459" });
  const longer = step("p4", { job: "daemon fixes" });
  assert.deepEqual(leftOpenSteps(daemon, [daemon], board(byJob, bySession, byChildId, longer)).map(step => step.id), ["p1", "p2", "p3"]);
  assert.deepEqual(rootLeftSteps(daemonRoot, [daemonRoot], board(byJob, bySession, longer)).map(step => step.id), ["p1", "p2"]);
});
