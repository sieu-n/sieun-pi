// Guards the 10-18 board panel crash in the AI harness chat: row.agents held key child:sub-3945faa4 twice, and Svelte threw each_key_duplicate about 14 times per switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatAgents } from "../src/chat-agents.ts";
import type { ChildAgent } from "../src/shared/types.ts";

test("chatAgents keeps one row per child id when the daemon lists two sessions of that child", () => {
  const child = { id: "sub-3945faa4", label: "job", status: "running", sessionName: "job" } as unknown as ChildAgent;
  const childSessions = [
    { sessionId: "old-session", childId: "sub-3945faa4", name: "job", running: false, failed: false },
    { sessionId: "new-session", childId: "sub-3945faa4", name: "job", running: true, failed: false },
  ];
  for (const children of [[child], []]) {
    const agents = chatAgents({ self: { id: "chat", name: "chat" }, children, childSessions, board: null, roots: [], messages: [], rows: [], now: Date.parse("2026-10-18T07:00:00Z") });
    const keys = agents.map(agent => agent.key);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(", ")}`);
  }
});
