import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { chatAgents } from "../src/chat-agents.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childrenByParent, cutSources, spawnedSubagents, subagentFolder, subagentSessions } from "../src/chat-catalog.ts";
import { SessionCuts } from "../src/cut-end.ts";
import { agentSubagents } from "../src/client/board.ts";
import { clockTime } from "../src/checkin-settings.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

const summary = (over: Partial<SessionSummary>): SessionSummary => ({ id: "x", lifecycle: "live", activity: "idle", isSessionActive: false, sessionId: "x", cwd: "/r", isStreaming: false, isCompacting: false,
  attachedClients: 0, messageCount: 2, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, ...over } as unknown as SessionSummary);
const running = (sessionId: string, parentSessionId: string): SessionSummary => summary({ sessionId, parentSessionId, activeSessionId: "a-" + sessionId, activity: "working" } as Partial<SessionSummary>);
const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...over });

test("an Agents row shows how many subagents it spawned, running or finished, and nothing when it spawned none", () => {
  const busy = summary({ sessionId: "s1", parentSessionId: "chat", rlmChildId: "sub-1", sessionName: "busy job", activeSessionId: "a1", activity: "working" } as Partial<SessionSummary>);
  const quiet = summary({ sessionId: "s2", parentSessionId: "chat", rlmChildId: "sub-2", sessionName: "quiet job" } as Partial<SessionSummary>);
  const all = [busy, quiet, running("g1", "s1"), running("g2", "s1"), running("gg1", "g1"), summary({ sessionId: "g3", parentSessionId: "s1" } as Partial<SessionSummary>)];
  const tree = childrenByParent(all);
  const agents = chatAgents({ self: { id: "chat", name: "chat" }, children: [], childSessions: subagentSessions(tree.get("chat") ?? [], tree), board: null,
    roots: ["vp", "idle-vp"], messages: [], now: Date.parse("2026-10-10T00:00:00Z"),
    rows: [{ row: row({ id: "vp", name: "developer environment VP", working: true, subagentsRunning: 4 }) }, { row: row({ id: "idle-vp", name: "idle VP" }) }] });
  const shown = Object.fromEntries(agents.map(agent => [agent.name, agentSubagents(agent)?.text ?? ""]));
  assert.deepEqual(shown, { "busy job": "4 sub", "developer environment VP": "4 sub", "quiet job": "", "idle VP": "" });
  assert.equal(agentSubagents(agents.find(agent => agent.name === "busy job")!)?.title, "4 subagents, 3 running");
});

test("a finished or failed job works while a subagent below it still runs, and is done once they stop", () => {
  const done = summary({ sessionId: "j", parentSessionId: "chat", rlmChildId: "sub-j", sessionName: "startup prompt trim" } as Partial<SessionSummary>);
  const failed = summary({ sessionId: "f", parentSessionId: "chat", rlmChildId: "sub-f", sessionName: "pool scheduler", statusLabel: "failed", summary: "boom" } as Partial<SessionSummary>);
  const states = (all: SessionSummary[]) => {
    const tree = childrenByParent(all);
    const agents = chatAgents({ self: { id: "chat", name: "chat" }, children: [{ id: "sub-f", label: "task", status: "error", sessionName: "pool scheduler" }],
      childSessions: subagentSessions(tree.get("chat") ?? [], tree), board: null, roots: [], messages: [], rows: [], now: 0 });
    return Object.fromEntries(agents.map(agent => [agent.name, [agent.state, agent.subagentsRunning ?? 0]]));
  };
  assert.deepEqual(states([done, failed, running("g1", "j"), running("gg1", "g1"), running("g2", "f")]),
    { "startup prompt trim": ["working", 2], "pool scheduler": ["working", 1] });
  assert.deepEqual(states([done, failed, summary({ sessionId: "g1", parentSessionId: "j" } as Partial<SessionSummary>)]),
    { "startup prompt trim": ["done", 0], "pool scheduler": ["failed", 0] });
});

test("a job with two finished and one running subagent at two depths counts 3 spawned, 1 running", () => {
  const job = summary({ sessionId: "j", parentSessionId: "chat", rlmChildId: "sub-j", sessionName: "job" } as Partial<SessionSummary>);
  const all = [job, summary({ sessionId: "c1", parentSessionId: "j" } as Partial<SessionSummary>), running("c2", "j"), summary({ sessionId: "g1", parentSessionId: "c1" } as Partial<SessionSummary>)];
  const tree = childrenByParent(all);
  const [session] = subagentSessions(tree.get("chat") ?? [], tree);
  assert.deepEqual([session?.subagentsTotal, session?.subagentsRunning], [3, 1]);
  const [agent] = chatAgents({ self: { id: "chat", name: "chat" }, children: [], childSessions: subagentSessions(tree.get("chat") ?? [], tree), board: null, roots: [], messages: [], rows: [], now: 0 });
  assert.deepEqual([agent?.subagentsTotal, agent?.subagentsRunning], [3, 1]);
});

test("agentSubagents shows the spawned count with or without running ones, and null at 0", () => {
  const agent = (over: Partial<ChatAgent>): ChatAgent => ({ key: "k", name: "job", job: "job", sender: "job", link: "subagent", state: "done", steps: [], ...over });
  assert.deepEqual(agentSubagents(agent({ subagentsTotal: 3 })), { text: "3 sub", running: 0, title: "3 subagents, none running" });
  assert.deepEqual(agentSubagents(agent({ subagentsTotal: 3, subagentsRunning: 1 })), { text: "3 sub", running: 1, title: "3 subagents, 1 running" });
  assert.deepEqual(agentSubagents(agent({ subagentsTotal: 1 })), { text: "1 sub", running: 0, title: "1 subagent, none running" });
  assert.equal(agentSubagents(agent({})), null);
});

test("spawnedSubagents counts every sub-* folder with an rlm-subagent.json at any depth, deleted subagents included", async () => {
  const root = mkdtempSync(join(tmpdir(), "spawned-"));
  try {
    const job = join(root, "session-artifacts", "chat", "sub-job");
    for (const path of ["sub-a", "sub-a/sub-b", "sub-c"]) { mkdirSync(join(job, path), { recursive: true }); writeFileSync(join(job, path, "rlm-subagent.json"), "{}"); }
    mkdirSync(join(job, "sub-empty"));
    mkdirSync(join(job, "notes"));
    const folder = subagentFolder({ sessionId: "j", parentSessionId: "chat", sessionFile: join(job, "j.jsonl") });
    assert.equal(folder, job);
    assert.equal(await spawnedSubagents(folder!, 0), 3);
    mkdirSync(join(job, "sub-d")); writeFileSync(join(job, "sub-d", "rlm-subagent.json"), "{}");
    assert.equal(await spawnedSubagents(folder!, 1000), 3, "a fresh count is reused for 30 s");
    assert.equal(await spawnedSubagents(folder!, 31_000), 4);
    assert.equal(subagentFolder({ sessionId: "top", sessionFile: join(root, "sessions", "top.jsonl") }), join(root, "session-artifacts", "top"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a job the daemon archived and aborted when it went down reads failed with the cut, not done (10-16 00:19:57Z)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-cut-"));
  try {
    const at = "2026-10-16T00:19:57.648Z";
    const lines = [{ timestamp: "2026-10-16T00:16:42.807Z", type: "custom_message", customType: "agent_message", content: "[task from parent] ..." },
      { timestamp: "2026-10-16T00:19:57.647Z", type: "session_state", state: { status: "archived" } },
      { timestamp: at, type: "message", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" } }];
    writeFileSync(join(dir, "cut.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const cut = summary({ sessionId: "c", parentSessionId: "chat", rlmChildId: "sub-c", sessionName: "local agents checks", sessionFile: join(dir, "cut.jsonl") } as Partial<SessionSummary>);
    const done = summary({ sessionId: "d", parentSessionId: "chat", rlmChildId: "sub-d", sessionName: "startup prompt trim" } as Partial<SessionSummary>);
    const tree = childrenByParent([cut, done]);
    const cuts = new SessionCuts();
    await cuts.update(cutSources([cut, done]));
    const agents = chatAgents({ self: { id: "chat", name: "chat" }, children: [], childSessions: subagentSessions(tree.get("chat") ?? [], tree, cuts), board: null, roots: [], messages: [], rows: [], now: 0 });
    assert.deepEqual(Object.fromEntries(agents.map(agent => [agent.name, [agent.state, agent.activity]])), {
      "local agents checks": ["failed", `cut by an abort when the Prime daemon went down at ${clockTime(Date.parse(at))} and never reported`],
      "startup prompt trim": ["done", undefined],
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
