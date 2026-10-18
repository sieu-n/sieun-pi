// Guards the 10-18 thread opens that waited 6 to 52 s: the chat service's main thread was 98% busy, and a catalog projection over 2,582 rows took 560 ms, most of it a linear row search per plan step owner and file reads repeated on every pass.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatAgents, type AgentRow } from "../src/chat-agents.ts";
import { firstTask } from "../src/chat-catalog.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const row = (index: number): SessionRow => ({ id: `s${index}`, name: `thread number ${index}`, cwd: "/", kind: "saved", status: "saved", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user" });

test("chatAgents reads each row about once however many plan steps name an owner", () => {
  const rows: AgentRow[] = Array.from({ length: 2000 }, (_, index) => ({ row: row(index) }));
  let reads = 0;
  const counted = new Proxy(rows, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const plan: PlanItem[] = Array.from({ length: 500 }, (_, index) => ({ id: `p${index}`, text: "step", status: "doing", job: `thread number ${index * 3}`, children: [] }));
  const board: ChatBoard = { v: 2, rev: 1, plan, todos: [], updatedAt: "2026-10-18T06:00:00.000Z" };
  const agents = chatAgents({ self: { id: "chat", name: "chat" }, children: [], childSessions: [], board, roots: [], messages: [], rows: counted, now: Date.parse("2026-10-18T06:00:00Z") });
  assert.equal(agents.length, 500);
  assert.deepEqual(agents.find(agent => agent.sessionId === "s9")?.steps, ["p3"]);
  assert.ok(reads < 3 * rows.length, `${reads} row reads for ${rows.length} rows and ${plan.length} steps`);
});

test("firstTask reads a session file that had no task again only once its daemon row changes", t => {
  const dir = mkdtempSync(join(tmpdir(), "first-task-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "x" }) + "\n");
  const listed = { sessionFile, parentSessionId: "parent", firstMessage: "(no messages)", modified: "2026-10-18T06:00:00.000Z", messageCount: 0 };
  assert.equal(firstTask(listed), "");
  writeFileSync(join(dir, "rlm-subagent.json"), JSON.stringify({ prompt: "measure the catalog" }));
  assert.equal(firstTask(listed), "", "the same row reads nothing again");
  assert.equal(firstTask({ ...listed, modified: "2026-10-18T06:00:05.000Z", messageCount: 1 }), "measure the catalog");
});
