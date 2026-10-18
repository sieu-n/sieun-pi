// Guards the 10-18 owner ask for a "clean, snappy" chat from the Mac: the live daemon sent 13.3 roster updates a second, the catalog ran 4.45 projections a second, and each built all 18 chats' agents again, 6.8 s of 100 s of a scratch serve's main thread, while an update touched about 9 agents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACT_WINDOW_MS, keptChatAgents, type AgentRow, type AgentSources } from "../src/chat-agents.ts";
import type { ChatBoard, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user", lastActivityAt: "2026-10-18T10:00:00.000Z", ...extra });

test("a chat's agents are built again only when a row they name, their inputs or the contact window change", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  let planReads = 0;
  const plain: ChatBoard = { v: 2, rev: 1, plan: [{ id: "p1", text: "crawl", status: "doing", job: "crawler ops", children: [] }], todos: [], updatedAt: "2026-10-18T10:00:00.000Z" };
  const board = new Proxy(plain, { get(target, key, receiver) { if (key === "plan") planReads++; return Reflect.get(target, key, receiver); } });
  const contactAt = now - CONTACT_WINDOW_MS + 60_000;
  const messages: ThreadMessage[] = [{ role: "custom", customType: "agent_message", timestamp: contactAt, content: "[agent-message from chat render]\nare you done?" } as unknown as ThreadMessage];
  const rows = (working: boolean): AgentRow[] => [{ row: row("s1", "crawler ops", { working }) }, { row: row("s2", "chat render") }, { row: row("s3", "unrelated") }];
  const input = (extra: Partial<AgentSources> = {}): AgentSources => ({ self: { id: "chat-kept", name: "chat" }, children: [], childSessions: [], board, roots: [], messages, rows: rows(false), now, ...extra });
  const states = (agents: ReturnType<typeof keptChatAgents>) => agents.map(agent => `${agent.sessionId}:${agent.state}`).sort();

  assert.deepEqual(states(keptChatAgents(input())), ["s1:idle", "s2:waiting"]);
  const built = planReads;
  const again = keptChatAgents(input({ rows: [...rows(false), { row: row("s4", "new thread") }], now: now + 1000 }));
  assert.deepEqual(states(again), ["s1:idle", "s2:waiting"]);
  assert.equal(planReads, built, "new rows that the agents do not name and a later time build nothing");
  again[0]!.subagentsTotal = 99;
  assert.equal(keptChatAgents(input()).some(agent => agent.subagentsTotal === 99), false, "each call gets its own agent objects");

  assert.deepEqual(states(keptChatAgents(input({ rows: rows(true) }))), ["s1:working", "s2:waiting"], "a named row that starts working is built again");
  assert.ok(planReads > built);
  assert.deepEqual(states(keptChatAgents(input({ rows: rows(true), now: now + 120_000 }))), ["s1:working"], "a contact that leaves the window is built again");
  assert.deepEqual(states(keptChatAgents(input({ rows: rows(true), now: now + 120_000, childSessions: [{ sessionId: "c1", childId: "kid", name: "kid job", running: true, failed: false }] }))),
    ["c1:working", "s1:working"], "a new child session is built again");
});
