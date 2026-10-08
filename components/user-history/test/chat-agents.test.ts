import assert from "node:assert/strict";
import { test } from "node:test";
import { agentContacts, agentLines, chatAgents, derivedName, displayName, needsDisplayName, type AgentRow } from "../src/chat-agents.ts";
import type { ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-08T07:00:00Z");
const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...over });
const child = (over: Partial<ChildAgent> & { id: string }): ChildAgent => ({ label: "task", status: "done", ...over });
const received = (from: string, text: string, at: number): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from ${from}]\n\n${text}`, timestamp: at });
const receipt = (sessionId: string, name: string | undefined, at: number): ThreadMessage => ({ role: "toolResult", toolCallId: "t", toolName: "ipython", isError: false, timestamp: at,
  content: [{ type: "text", text: `{'id': 'agentmsg_1', 'source': 'agent_message', 'target': {'activeSessionId': 'abc', 'sessionId': '${sessionId}'${name ? `, 'sessionName': '${name}'` : ""}, 'runtimeKind': 'top-level'}, 'from': {'activeSessionId': 'x'}}` }] });
const board = (plan: ChatBoard["plan"]): ChatBoard => ({ v: 2, rev: 1, plan, scratch: [], todos: [], updatedAt: "2026-10-08T06:00:00Z" });
const step = (id: string, job: string, status: ChatBoard["plan"][number]["status"] = "doing") => ({ id, text: id, status, job, children: [] });

test("agentContacts reads received headers and sent receipts since a time", () => {
  const messages = [received("child:settings-reland-2", "CI green. Push now?", NOW - 60_000), receipt("01a10810-34b5-710f-88fe-3d369f89a8c9", undefined, NOW - 30_000),
    received("developer environment VP", "From the dev env thread", NOW - 2 * 86_400_000), { role: "user", content: "hi", timestamp: NOW } as ThreadMessage];
  assert.deepEqual(agentContacts(messages, NOW - 86_400_000), [
    { who: "child:settings-reland-2", at: NOW - 60_000, direction: "received", text: "CI green. Push now?" },
    { who: "01a10810-34b5-710f-88fe-3d369f89a8c9", at: NOW - 30_000, direction: "sent", text: "" },
  ]);
});

test("display names: plain names stay, empty, Untitled and kebab-case names derive from the first task", () => {
  assert.equal(needsDisplayName("stripe and payments"), false);
  assert.equal(needsDisplayName("**** main dev thread ***"), false);
  assert.equal(needsDisplayName("Untitled"), true);
  assert.equal(needsDisplayName(""), true);
  assert.equal(needsDisplayName("settings-reland-2"), true);
  assert.equal(needsDisplayName("w22_agents"), true);
  assert.equal(derivedName("[task from parent]\nOwner's words (verbatim):\n\"like im pretty sure there ARE agents\"\n# Fix the **Agents** card on the board panel, please"), "fix the agents card on");
  assert.equal(derivedName("> quoted\n`rg` the README Chats section against src"), "rg the readme chats section");
  assert.equal(derivedName("Owner's words (verbatim): \"hows the settings reland going\"\nMy read: the owner wants a status.\nCheck the re-land on staging and report."), "the owner wants a status", "the owner's quote is skipped; the chat's read is a topic");
  assert.equal(derivedName("<skill name=\"poteto-mode\" location=\"/x\">\nYou are Fable, the CI queue coordinator"), "you are fable, the ci");
  assert.equal(derivedName(""), "");
  assert.equal(displayName("stripe and payments", "anything"), "stripe and payments");
  assert.equal(displayName("chat-e15f", "Stripe webhook setup in general, step by step"), "stripe webhook setup in general");
  assert.equal(displayName("chat-e15f", undefined), "chat-e15f");
  assert.equal(displayName("", undefined), "untitled");
});

test("chatAgents lists subagents, created roots, open-step owners and message partners once each, working first", () => {
  const self = { id: "chat", name: "stripe and payments" };
  const rows: AgentRow[] = [
    { row: row({ id: "chat", name: self.name, chat: true }) },
    { row: row({ id: "01a0fc82", name: "**main thread** stripe clerk", kind: "saved", status: "saved", lastActivityAt: "2026-10-07T20:31:34Z" }) },
    { row: row({ id: "01a10810", name: "Look there are a bunch of prime agent threads", status: "idle", lastActivityAt: "2026-10-08T06:50:00Z" }), first: "Look there are a bunch of prime agent threads in the sep-launch tags." },
    { row: row({ id: "01a0cc5e", name: "Untitled", working: true, status: "running", statusLabel: "Checking land 25", lastActivityAt: "2026-10-08T06:59:00Z" }), first: "[task from parent]\nYou are Fable, the CI queue coordinator for the shared tip" },
    { row: row({ id: "01a0e729", name: "stripe check", kind: "saved", status: "saved", lastActivityAt: "2026-10-02T17:25:34Z" }) },
    { row: row({ id: "01a1root", name: "seo-daily", working: true, status: "running", origin: "agent", lastActivityAt: "2026-10-08T06:55:00Z" }), first: "Run the daily SEO program" },
    { row: row({ id: "01a1fail", name: "crawler ops", failure: "Model request failed: 429", lastActivityAt: "2026-10-08T05:00:00Z" }) },
  ];
  const children = [
    child({ id: "sub-f4b6", sessionName: "settings-reland-2", status: "done", activity: { kind: "waiting" }, repliedSinceTask: true, label: "Re-land the settings billing rounds", lastActivityAt: NOW - 50 * 60_000 }),
    child({ id: "sub-bfe0", sessionName: "grampo-refund-debit", status: "cancelled", answerPreview: "Took back $54.695", lastActivityAt: NOW - 3 * 3_600_000 }),
    child({ id: "sub-err", sessionName: "topup check", status: "error", error: "429 too many requests" }),
    child({ id: "sub-nested", parentId: "sub-f4b6", sessionName: "deep", status: "running" }),
  ];
  const messages: ThreadMessage[] = [
    received("child:settings-reland-2", "Plan fixes committed: e5b18ac68b. Land 25 next?", NOW - 40 * 60_000),
    receipt("01a10810", undefined, NOW - 20 * 60_000),
    received("01a10810", "[from 01a10810] ok (no pin probe running)", NOW - 10 * 60_000),
    received("Untitled", "From 01a0cc5e (Fable). LAND 24 DISPATCHED", NOW - 4 * 3_600_000),
    received("c1420332c8ee", "[watchdog] Your last turn was dropped", NOW - 60_000),
    received("child:gone", "I was deleted", NOW - 60_000),
    { role: "toolResult", toolCallId: "t2", toolName: "ipython", isError: false, timestamp: NOW - 3_600_000, content: [{ type: "text", text: "RLMCreateSessionHandle(active_session_id='a', session_id='01a1root', name='seo-daily', session_file=PosixPath('/x'))" }] },
  ];
  const plan = board([
    { id: "p1", text: "Stripe and Clerk webhooks", status: "blocked", children: [step("p2", "01a0fc82", "done"), step("p3", "01a0fc82", "blocked"), step("p4", "stripe check", "done")] },
    { id: "p7", text: "Top-ups", status: "doing", children: [step("p8", "settings-reland-2"), step("p9", "thread:01a1fail", "todo"), step("p10", "stripe and payments"), step("p11", "nobody-known")] },
  ]);
  const agents = chatAgents({ self, children, childSessions: [
    { sessionId: "01a11842", childId: "sub-f4b6", name: "settings-reland-2", first: "Re-land the settings billing rounds 4 and 5", running: false, failed: false, lastActivityAt: "2026-10-08T06:16:34Z" },
    { sessionId: "01a1new", childId: "sub-new", name: "prod topup check", running: true, failed: false, activity: "Reading Stripe events", lastActivityAt: "2026-10-08T06:58:00Z" },
  ], board: plan, roots: ["seo-daily"], messages, rows, now: NOW });

  assert.deepEqual(agents.map(agent => [agent.key, agent.name, agent.link, agent.state, agent.steps]), [
    ["thread:01a0cc5e", "you are fable, the ci", "message", "working", []],
    ["child:sub-new", "prod topup check", "subagent", "working", []],
    ["thread:01a1root", "run the daily seo program", "root", "working", []],
    ["thread:01a10810", "Look there are a bunch of prime agent threads", "message", "idle", []],
    ["child:sub-f4b6", "re-land the settings billing rounds", "subagent", "waiting", ["p8"]],
    ["thread:01a1fail", "crawler ops", "step", "failed", ["p9"]],
    ["child:sub-bfe0", "task", "subagent", "done", []],
    ["thread:01a0fc82", "**main thread** stripe clerk", "step", "idle", ["p2", "p3"]],
    ["child:sub-err", "topup check", "subagent", "failed", []],
  ]);
  const by = Object.fromEntries(agents.map(agent => [agent.key, agent]));
  assert.equal(by["child:sub-f4b6"]!.sessionId, "01a11842");
  assert.equal(by["child:sub-f4b6"]!.job, "settings-reland-2");
  assert.equal(by["child:sub-f4b6"]!.sender, "settings-reland-2");
  assert.equal(by["thread:01a0cc5e"]!.sender, "Untitled", "a derived display name still finds the thread's messages by its session name");
  assert.equal(by["child:sub-f4b6"]!.activity, "Plan fixes committed: e5b18ac68b. Land 25 next?");
  assert.equal(by["child:sub-f4b6"]!.lastActivityAt, new Date(NOW - 40 * 60_000).toISOString(), "the later of its activity and its last message");
  assert.equal(by["thread:01a10810"]!.job, "session:01a10810");
  assert.equal(by["thread:01a10810"]!.activity, "[from 01a10810] ok (no pin probe running)");
  assert.equal(by["thread:01a10810"]!.state, "idle", "its last message asked nothing");
  assert.equal(by["child:sub-new"]!.activity, "Reading Stripe events");
  assert.equal(by["child:sub-err"]!.activity, "429 too many requests");
  assert.equal(by["thread:01a1fail"]!.activity, "Model request failed: 429");
  assert.equal(by["thread:01a0cc5e"]!.activity, "Checking land 25");
  assert.ok(!agents.some(agent => agent.sessionId === "01a0e729"), "the owner of a done step only is left out");
  assert.ok(!agents.some(agent => agent.key === "child:sub-nested"), "a subagent's own subagent is left out");
  assert.ok(!agents.some(agent => agent.sessionId === "chat"), "the chat itself is left out");
});

test("chatAgents with nothing attached still lists the daemon's subagent sessions", () => {
  const agents = chatAgents({ self: { id: "c", name: "c" }, children: [], childSessions: [{ sessionId: "s1", childId: "sub-1", name: "ux-email", running: false, failed: false, lastActivityAt: "2026-10-06T01:00:00Z" }],
    board: null, roots: [], messages: [], rows: [], now: NOW });
  assert.deepEqual(agents.map(agent => [agent.key, agent.sessionId, agent.name, agent.job, agent.state]), [["child:sub-1", "s1", "ux-email", "ux-email", "done"]]);
});

test("agentLines gives the chat one line per agent, at most 15", () => {
  const agent = (name: string, state: "working" | "idle", minutesAgo: number, steps: string[] = []) =>
    ({ key: "thread:" + name, sessionId: name, name, job: "session:" + name, sender: name, link: "step" as const, state, lastActivityAt: new Date(NOW - minutesAgo * 60_000).toISOString(), steps });
  assert.deepEqual(agentLines([agent("prod topup check", "working", 2, ["p9"]), { ...agent("main stripe clerk", "idle", 150), state: "waiting" }], NOW),
    ["Agents:", "- prod topup check: working, 2 min ago (p9)", "- main stripe clerk: waiting for you, 3 h ago"]);
  assert.deepEqual(agentLines([], NOW), []);
  const many = agentLines(Array.from({ length: 20 }, (_, index) => agent("t" + index, "idle", index)), NOW);
  assert.equal(many.length, 15);
  assert.equal(many.at(-1), "- and 7 more");
});
