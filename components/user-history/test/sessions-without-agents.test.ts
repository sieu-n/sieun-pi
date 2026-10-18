// Guards the 10-18 sidebar fill on the Mac at 4 to 7 s: 385 KB of the 482 KB sessions frame was every chat's agents list (1,074 agents, 423 of them done), while the page shows the agents of the open chat and its unfolded rows only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsView, SessionsDiff, withoutAgents } from "../src/shared/sessions-delta.ts";
import type { ChatAgent, SessionRow, SessionsDelta, SessionsEvent } from "../src/shared/types.ts";

const agent = (n: number, state: ChatAgent["state"]): ChatAgent => ({ key: `child:k${n}`, sessionId: `job${n}`, childId: `k${n}`, name: `job number ${n} with a long name`, job: `job-${n}`,
  sender: `job-${n}`, link: n % 2 ? "subagent" : "root", state, activity: "read the crawler logs and fixed the retry".repeat(2), lastActivityAt: "2026-10-18T10:00:00.000Z", steps: [`p${n}`] });
const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: `thread ${id}`, cwd: "/", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user", ...extra });

test("the sessions feed leaves out chats' agents and counts them, and the agents feed gives one chat's list by its id or a job's", () => {
  const chats = Array.from({ length: 18 }, (_, c) => row(`chat${c}`, { chat: true, agents: Array.from({ length: 60 }, (_, n) => agent(c * 100 + n, n < 3 ? "working" : "done")) }));
  const plain = Array.from({ length: 400 }, (_, n) => row(`t${n}`));
  const event: SessionsEvent = { type: "sessions", sessions: [...chats, ...plain], tags: [], daemon: "up" };
  const slim = withoutAgents(event);
  const full = JSON.stringify(event).length, sent = JSON.stringify(slim).length;
  assert.ok(sent < full / 4, `${sent} bytes instead of ${full}`);
  assert.equal(withoutAgents(event), slim, "one view per event");
  const first = slim.sessions[0]!;
  assert.equal(first.agents, undefined);
  assert.deepEqual([first.agentsRunning, first.agentsTotal], [3, 60]);
  assert.equal(slim.sessions[20], event.sessions[20], "a row with no agents is the same object");

  assert.equal(agentsView(event.sessions, "chat2").agents.length, 60);
  assert.deepEqual(({ ...agentsView(event.sessions, "job205"), agents: [] }), { chat: "chat2", open: "job-205", agents: [] }, "a job's session finds its chat");
  assert.deepEqual(agentsView(event.sessions, "t3"), { chat: null, agents: [] });

  const diff = new SessionsDiff();
  diff.frame(slim);
  const next: SessionsEvent = { ...event, sessions: event.sessions.map((entry, n) => n === 0 ? { ...entry, agents: entry.agents!.map((a, i) => i === 10 ? { ...a, activity: "new" } : a) } : entry) };
  assert.equal(diff.frame(withoutAgents(next)), null, "an agent that changes in a chat's list sends no sessions frame");
  const started: SessionsEvent = { ...event, sessions: event.sessions.map((entry, n) => n === 0 ? { ...entry, agents: entry.agents!.map((a, i) => i === 10 ? { ...a, state: "working" as const } : a) } : entry) };
  const frame = diff.frame(withoutAgents(started)) as SessionsDelta;
  assert.deepEqual(frame.patch, [{ id: "chat0", set: { agentsRunning: 4 } }], "a count that moves goes out as one field");
});
