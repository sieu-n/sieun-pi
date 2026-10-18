// Guards the 10-18 projection cost at the live rate: the live daemon sent 13.3 roster updates a second that changed 39.7 agents, and on a scratch serve at that rate more than half the chats placed all their agents again on each projection, because a chat usually names a row whose clock or status had just changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keptChatAgents, type AgentRow, type AgentSources, type SubagentSession } from "../src/chat-agents.ts";
import type { ChatBoard, ChildAgent, SessionRow } from "../src/shared/types.ts";

const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user", lastActivityAt: "2026-10-18T10:00:00.000Z", ...extra });

test("a tick on a named row, a child session or a hub child updates the agents without placing them again", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  let planReads = 0;
  const plain: ChatBoard = { v: 2, rev: 1, plan: [{ id: "p1", text: "crawl", status: "doing", job: "crawler ops", children: [] }], todos: [], updatedAt: "2026-10-18T10:00:00.000Z" };
  const board = new Proxy(plain, { get(target, key, receiver) { if (key === "plan") planReads++; return Reflect.get(target, key, receiver); } });
  const rows = (extra: Partial<SessionRow> = {}): AgentRow[] => [{ row: row("s1", "crawler ops", extra) }, { row: row("s3", "unrelated") }];
  const session = (extra: Partial<SubagentSession> = {}): SubagentSession => ({ sessionId: "c1", childId: "kid", name: "kid job", running: true, failed: false, ...extra });
  const child = (extra: Partial<ChildAgent> = {}): ChildAgent => ({ id: "hub", label: "hub job", sessionName: "hub job", status: "running", lastActivityAt: now - 5000, ...extra }) as ChildAgent;
  const input = (extra: Partial<AgentSources> = {}): AgentSources => ({ self: { id: "chat-ticks", name: "chat" }, children: [child()], childSessions: [session()], board, roots: [],
    messages: [], rows: rows(), now, ...extra });
  const shown = (agents: ReturnType<typeof keptChatAgents>) => Object.fromEntries(agents.map(agent => [agent.key, `${agent.state}|${agent.activity ?? ""}|${agent.lastActivityAt ?? ""}`]));

  keptChatAgents(input());
  const placed = planReads;
  const ticked = shown(keptChatAgents(input({ rows: rows({ working: true, statusLabel: "reading", lastActivityAt: "2026-10-18T11:59:00.000Z" }),
    childSessions: [session({ activity: "step 2", lastActivityAt: "2026-10-18T11:59:30.000Z" })], children: [child({ status: "done", lastActivityAt: now - 1000 })] })));
  assert.equal(planReads, placed, "no plan walk for a tick");
  assert.deepEqual(ticked, {
    "child:hub": `done||${new Date(now - 1000).toISOString()}`,
    "child:kid": "working|step 2|2026-10-18T11:59:30.000Z",
    "thread:s1": "working|reading|2026-10-18T11:59:00.000Z",
  });
  keptChatAgents(input({ rows: rows({ name: "crawler ops renamed" }) }));
  assert.ok(planReads > placed, "a renamed row is placed again");
});
