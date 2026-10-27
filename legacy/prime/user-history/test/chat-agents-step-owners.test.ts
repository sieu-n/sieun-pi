// Guards the 10-18 owner ask for a "clean, snappy" chat from the Mac: after the kept rows, chatAgents still took 5.6 s of 100 s of a scratch serve's main thread, 1.2 s of it reading each plan step's owner again on every projection; a kept owner must still follow a step whose job changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatAgents, type AgentRow } from "../src/chat-agents.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const row = (id: string, name: string): SessionRow => ({ id, name, cwd: "/", kind: "saved", status: "saved", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user" });

test("a plan step's owner is read once per step and follows the step when its job, session id or note changes in place", () => {
  const rows: AgentRow[] = [{ row: row("s1", "crawler ops") }, { row: row("s2", "chat render") }, { row: row("s3", "noted thread") }];
  const step: PlanItem = { id: "p1", text: "fix the crawler", status: "doing", job: "crawler ops", children: [] };
  const board: ChatBoard = { v: 2, rev: 1, plan: [step], todos: [], updatedAt: "2026-10-18T10:00:00.000Z" };
  const agents = () => chatAgents({ self: { id: "chat", name: "chat" }, children: [], childSessions: [], board, roots: [], messages: [], rows,
    now: Date.parse("2026-10-18T10:00:00Z") }).map(agent => [agent.sessionId, agent.steps]);
  assert.deepEqual(agents(), [["s1", ["p1"]]]);
  assert.deepEqual(agents(), [["s1", ["p1"]]], "a second projection gives the same owner");
  step.job = "chat render";
  assert.deepEqual(agents(), [["s2", ["p1"]]], "a renamed job moves the step");
  delete step.job;
  step.note = "handed to thread:s3";
  assert.deepEqual(agents(), [["s3", ["p1"]]], "a note that names a thread moves the step");
});
