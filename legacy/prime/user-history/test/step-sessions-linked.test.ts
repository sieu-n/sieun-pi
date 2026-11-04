// Guards the 11-04 cut of the chat's main thread: the catalog asked stepSessions for each of 14 chats on each of about 100 projections a minute,
// and each call read the steps of every agent of the chat (3,065 in all) to link the few steps that had no session id yet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepSessions } from "../src/chat-agents.ts";
import type { ChatAgent, ChatBoard, PlanItem } from "../src/shared/types.ts";

const agent = (index: number, steps: string[]): ChatAgent => ({ key: `thread:s${index}`, sessionId: `s${index}`, name: `job ${index}`, job: `job ${index}`,
  sender: `job ${index}`, link: "step", state: "idle", steps });
const step = (index: number, sessionId?: string): PlanItem => ({ id: `p${index}`, text: "step", status: "done", job: `job ${index}`, children: [], ...sessionId ? { sessionId } : {} });

test("a board whose steps all carry a session id reads no agent's steps, and a step without one is still linked to its owner", () => {
  let reads = 0;
  const agents = Array.from({ length: 500 }, (_, index) => new Proxy(agent(index, [`p${index}`]), { get(target, key, receiver) { if (key === "steps") reads++; return Reflect.get(target, key, receiver); } }));
  const linked: ChatBoard = { v: 2, rev: 1, updatedAt: "2026-11-04T08:00:00.000Z", todos: [], plan: Array.from({ length: 500 }, (_, index) => step(index, `s${index}`)) };
  for (let projection = 0; projection < 10; projection++) assert.equal(stepSessions(linked, agents).size, 0);
  assert.equal(reads, 0, `10 projections read agents' steps ${reads} times for a board with nothing to link`);
  const open: ChatBoard = { ...linked, rev: 2, plan: [...linked.plan.slice(1), step(0)] };
  assert.deepEqual([...stepSessions(open, agents)], [["p0", { job: "job 0", sessionId: "s0" }]]);
});
