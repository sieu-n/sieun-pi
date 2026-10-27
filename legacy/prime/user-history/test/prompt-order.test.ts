// Guards the owner's ask of 10-22: the Prompt dialog's ordered view, which rebuilds the prompt in the order the provider reads it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXTENSION_TOOLS, payloadApi, payloadParts, PRIME_TOOLS, toPart } from "../src/prompt-view.ts";
import { orderTree, skillRows, turnsOf } from "../src/client/prompt-order.ts";
import type { PromptOrigin, PromptView } from "../src/shared/prompt-view.ts";
import * as brief from "../src/chat-brief.ts";
import * as corrections from "../src/chat-corrections.ts";
import * as guard from "../src/chat-guard.ts";
import * as feed from "../src/shared/chat-feed.ts";

const SYSTEM = "You are the base prompt.\n\n# Generic MCP Connections\n\nmcp text\n\n# Additional Guidance\n\n- a guideline\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /tmp/AGENTS.md\n\nrules\n\n" +
  "The following skills provide specialized instructions for specific tasks.\n<available_skills>\n  <skill>\n    <name>alpha</name>\n    <location>/s/alpha/SKILL.md</location>\n  </skill>\n" +
  "  <skill>\n    <name>beta</name>\n    <type>python</type>\n    <location>/s/beta/SKILL.md</location>\n  </skill>\n</available_skills>";
const tools = [{ name: "ipython", description: "run python", input_schema: { type: "object" } }, { name: "tell_owner", description: "message the owner", input_schema: { type: "object" } },
  { name: "mystery", description: "from elsewhere", input_schema: { type: "object" } }];
const call = (id: string, name = "ipython") => ({ type: "tool_use", id, name, input: { code: `print("${id}")` } });
const result = (id: string, text = `out ${id}`) => ({ type: "tool_result", tool_use_id: id, content: text });
const user = (...texts: string[]) => ({ role: "user", content: texts.map(text => ({ type: "text", text })) });

function view(payload: unknown, origin: PromptOrigin = { kind: "exact", capturedAt: "2026-10-22T09:00:00.000Z", provider: "anthropic", model: "m" }): PromptView {
  const parts = payloadParts(payload).map(toPart);
  const api = payloadApi(payload);
  return { threadId: "t", sessionFile: "/tmp/t.jsonl", origin, ...(api ? { api } : {}), totalTokens: parts.reduce((sum, part) => sum + part.tokens, 0), parts };
}

const payload = {
  system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: SYSTEM }],
  tools,
  messages: [
    user("[harness-digest]\n\nmemories\n\n[compaction-summary]\nwhat happened before"),
    user("please fix it", "[message id: m1; reply_to it only after he sends a newer message]"),
    { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "s" }, { type: "text", text: "on it" }, call("c1"), call("c2", "tell_owner")] },
    { role: "user", content: [result("c1"), result("c2")] },
    { role: "assistant", content: [call("c3")] },
    { role: "user", content: [result("c3")] },
    user("[agent-message from sibling:x]\n\nsteer while in the loop", "[not from the owner: send no tell_owner for it]"),
    { role: "assistant", content: [call("c4")] },
    { role: "user", content: [result("c4")] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ],
};

test("an assistant reply becomes one part per block, with the message index and tool call ids", () => {
  const parts = view(payload).parts.filter(part => part.role);
  const reply = parts.filter(part => part.message === 2);
  assert.deepEqual(reply.map(part => part.label), ["Assistant thinking", "Assistant", "Assistant tool call: ipython", "Assistant tool call: tell_owner"]);
  assert.deepEqual(reply.map(part => part.call ?? null), [null, null, "c1", "c2"]);
  assert.deepEqual(parts.filter(part => part.role === "toolResult").map(part => [part.call, part.message]), [["c1", 3], ["c2", 3], ["c3", 5], ["c4", 8]]);
});

test("tool definitions come before the system blocks for an Anthropic payload, each tool named with who registers it", () => {
  const tree = orderTree(view(payload));
  assert.deepEqual(tree.head.map(section => section.title), ["Tool definitions, 3", "System prompt"]);
  assert.deepEqual(tree.head[0]!.rows.map(row => [row.label, row.part?.registeredBy]), [["ipython", "prime"], ["tell_owner", "user-history"], ["mystery", "other"]]);
  assert.deepEqual(tree.head[1]!.rows.map(row => row.label), ["Provider identity line", "Base system prompt", "MCP connections", "Tool guidelines", "/tmp/AGENTS.md", "Skills list"]);
});

test("an OpenAI Responses payload keeps instructions, tools, input", () => {
  const tree = orderTree(view({ instructions: SYSTEM, tools: [{ type: "function", name: "ipython", parameters: {} }], input: [{ role: "user", content: "hi" }] }));
  assert.equal(tree.api, "openai-responses");
  assert.deepEqual(tree.head.map(section => section.title), ["Instructions", "Tool definitions, 1"]);
  assert.equal(tree.turns[0]!.lead?.label, "Owner");
});

test("the skills list opens into one row per skill with its location", () => {
  const skills = view(payload).parts.find(part => part.kind === "skills")!;
  const rows = skillRows(skills);
  assert.deepEqual(rows.map(row => row.label), ["Skills list frame", "alpha", "beta"]);
  assert.equal(rows[2]!.source, "python skill, /s/beta/SKILL.md");
  assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), skills.tokens);
});

test("each tool result nests under its own call, in order, and a compaction summary sits at its real place", () => {
  const turns = orderTree(view(payload)).turns;
  assert.deepEqual(turns.map(turn => turn.lead?.label), ["Harness digest", "Compaction summary", "Owner", "Agent message from sibling:x"]);
  const owner = turns[2]!;
  assert.deepEqual(owner.steps.map(step => [step.part.label, step.results.map(part => part.call)]),
    [["Assistant thinking", []], ["Assistant", []], ["Assistant tool call: ipython", ["c1"]], ["Assistant tool call: tell_owner", ["c2"]], ["Assistant tool call: ipython", ["c3"]]]);
});

test("a hook block nests under its message, labeled as added by the hook", () => {
  const turns = orderTree(view(payload)).turns;
  assert.deepEqual(turns[2]!.added.map(part => [part.label, part.hook]), [["[message id]", true]]);
  assert.deepEqual(turns[3]!.added.map(part => [part.label, part.hook]), [["[wake note]", true]]);
});

test("a notice that arrives mid-turn is its own top-level row and the work after it nests under it", () => {
  const turns = orderTree(view(payload)).turns;
  const steer = turns[3]!;
  assert.equal(steer.midTurn, true);
  assert.equal(turns[2]!.midTurn, false);
  assert.deepEqual(steer.steps.map(step => [step.part.label, step.results.map(part => part.call)]), [["Assistant tool call: ipython", ["c4"]], ["Assistant", []]]);
});

test("token totals of the tree match the view's total", () => {
  const shown = view(payload);
  const tree = orderTree(shown);
  assert.equal(tree.headTokens + tree.turnTokens, shown.totalTokens);
  assert.equal(turnsOf(shown.parts).flatMap(turn => [...turn.lead ? [turn.lead] : [], ...turn.added, ...turn.steps.flatMap(step => [step.part, ...step.results])]).length,
    shown.parts.filter(part => part.role).length);
});

test("a rebuild shows a placeholder for each section it cannot know, at its place", () => {
  const rebuilt = view({ messages: payload.messages }, { kind: "rebuild", reason: "no capture" });
  rebuilt.parts.unshift({ id: "ctx", kind: "instructions", label: "/tmp/AGENTS.md", source: "Prime: project context file (AGENTS.md)", text: "rules", tokens: 2 },
    { id: "brief", kind: "instructions", label: "Chat brief", source: "chat_board tool promptGuidelines", text: "- be brief", tokens: 3 });
  const tree = orderTree(rebuilt);
  assert.deepEqual(tree.head.map(section => section.rows.map(row => [row.label, row.placeholder === true])), [
    [["Every tool definition", true]],
    [["Base system prompt", true], ["MCP connections and tool guidelines", true], ["Chat brief", false], ["/tmp/AGENTS.md", false], ["Skills list", true]],
  ]);
});

test("the tools the view names as the user-history extension's are the ones extension/index.ts registers", () => {
  const source = readFileSync(new URL("../extension/index.ts", import.meta.url), "utf8");
  const constants: Record<string, unknown> = { ...brief, ...corrections, ...guard, ...feed };
  const registered = [...source.matchAll(/registerTool\(\{\s*name: ([A-Z_]+),/g)].map(match => constants[match[1]!]);
  assert.deepEqual(new Set(registered), EXTENSION_TOOLS);
  for (const name of EXTENSION_TOOLS) assert.ok(!PRIME_TOOLS.has(name));
});
