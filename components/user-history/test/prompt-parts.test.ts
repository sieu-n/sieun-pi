import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, groupName, labelDetail, outline, preview, share, speakerOf } from "../src/client/prompt-parts.ts";
import type { PromptPart, PromptView } from "../src/shared/prompt-view.ts";

const part = (id: string, label: string, source: string, tokens: number, role?: PromptPart["role"]): PromptPart =>
  ({ id, kind: role ? "message" : "system", label, source, ...(role ? { role } : {}), text: "x", tokens });

const view: PromptView = {
  threadId: "t1", sessionFile: "/s.jsonl", origin: { kind: "rebuild", reason: "no capture" }, totalTokens: 1000,
  parts: [
    part("p0", "Base system prompt", "Prime buildRlmPrompt", 300),
    part("p1", "Chat brief", "chat_board tool promptGuidelines", 100),
    part("p2", "Owner", "the owner (or the parent's task text)", 20, "user"),
    part("p3", "[check-in]", "chat server (sent as a user message)", 80, "user"),
    part("p4", "Assistant tool call", "model reply", 50, "assistant"),
    part("p5", "Tool result: ipython", "tool output", 200, "toolResult"),
    part("p6", "Tool result: bash", "tool output", 150, "toolResult"),
    part("p7", "[check-in]", "chat server (sent as a user message)", 60, "user"),
    part("p8", "Agent message from prompt-source", "agent_message (another session)", 40, "user"),
  ],
};

test("speakerOf: owner text and owner board actions are the owner's; other user-role parts are injected", () => {
  assert.equal(speakerOf(view.parts[0]!), "prompt");
  assert.equal(speakerOf(view.parts[2]!), "owner");
  assert.equal(speakerOf(part("x", "[board] owner action", "the owner, through the board (sent as a user message)", 1, "user")), "owner");
  assert.equal(speakerOf(part("x", "Image", "image in a user message", 1, "user")), "owner");
  assert.equal(speakerOf(view.parts[3]!), "injected");
  assert.equal(speakerOf(view.parts[8]!), "injected");
  assert.equal(speakerOf(view.parts[4]!), "model");
  assert.equal(speakerOf(view.parts[5]!), "tool");
});

test("groupName: a tool name, a sender or a target does not split a group", () => {
  assert.equal(groupName("Tool result: ipython"), "Tool result");
  assert.equal(groupName("Agent message from prompt-source"), "Agent message");
  assert.equal(groupName("Agent message: task from parent"), "Agent message");
  assert.equal(groupName("Nudge for frontend bro"), "Nudge");
  assert.equal(groupName("[check-in]"), "[check-in]");
  assert.equal(groupName("Assistant thinking"), "Assistant thinking");
});

test("outline: the parts before the conversation in order, then the conversation by source kind, biggest first, each with its parts in time order", () => {
  const result = outline(view);
  assert.deepEqual(result.rows.map(row => [row.key, row.label, row.parts.map(item => item.id)]), [["h:p0", "Base system prompt", ["p0"]], ["h:p1", "Chat brief", ["p1"]]]);
  assert.equal(result.headTokens, 400);
  assert.equal(result.headParts, 2);
  assert.equal(result.messageParts, 7);
  assert.equal(result.messageTokens, 600);
  assert.deepEqual(result.groups.map(group => [group.label, group.source, group.tokens, group.speaker, group.parts.map(item => item.id)]), [
    ["Tool result", "2 parts", 350, "tool", ["p5", "p6"]],
    ["[check-in]", "2 parts", 140, "injected", ["p3", "p7"]],
    ["Assistant tool call", "1 part", 50, "model", ["p4"]],
    ["Agent message", "1 part", 40, "injected", ["p8"]],
    ["Owner", "1 part", 20, "owner", ["p2"]],
  ]);
  assert.equal(new Set([...result.rows, ...result.groups].map(row => row.key)).size, result.rows.length + result.groups.length, "every row has its own key for its open state");
});

test("labelDetail: what a part's label adds to its source kind", () => {
  assert.equal(labelDetail("Tool result: ipython"), "ipython");
  assert.equal(labelDetail("Agent message from prompt-source"), "prompt-source");
  assert.equal(labelDetail("Nudge for frontend bro"), "frontend bro");
  assert.equal(labelDetail("[check-in]"), "");
});

test("preview: a part's text on one line, cut to its length", () => {
  assert.equal(preview("→ ipython\nprint(1)\n\n  done"), "→ ipython print(1) done");
  assert.equal(preview("x".repeat(500), 240).length, 240);
  assert.equal(preview(""), "");
});

test("clip: a long text shows its first lines and counts the rest; a short one shows whole", () => {
  assert.deepEqual(clip("a\nb\nc", 2), { text: "a\nb", more: 1 });
  assert.deepEqual(clip("a\nb\nc\nd\n", 2), { text: "a\nb", more: 2 });
  assert.deepEqual(clip("a\nb", 2), { text: "a\nb", more: 0 });
  assert.deepEqual(clip("a\nb\n", 2), { text: "a\nb\n", more: 0 });
  const long = clip("y".repeat(10_000), 40, 6000);
  assert.deepEqual([long.text.length, long.more], [6000, 1], "one line longer than the character cap is cut too");
});

test("share: whole percents from 10%, one decimal below, and <0.1% for a sliver", () => {
  assert.equal(share(310, 1000), "31%");
  assert.equal(share(24, 1000), "2.4%");
  assert.equal(share(1, 100_000), "<0.1%");
  assert.equal(share(0, 1000), "0%");
  assert.equal(share(5, 0), "0%");
});

test("outline: consecutive tool definitions are one row that opens to each definition", () => {
  const tool = (id: string, name: string, tokens: number): PromptPart => ({ id, kind: "tools", label: "Tool: " + name, source: "tool definition", text: "x", tokens });
  const result = outline({ ...view, parts: [view.parts[0]!, tool("t1", "ipython", 50), tool("t2", "chat_board", 70), view.parts[1]!, tool("t3", "job_reply", 5), view.parts[2]!] });
  assert.deepEqual(result.rows.map(row => [row.key, row.label, row.tokens, row.parts.map(item => item.id)]), [
    ["h:p0", "Base system prompt", 300, ["p0"]],
    ["h:t1", "Tools, 2 definitions", 120, ["t1", "t2"]],
    ["h:p1", "Chat brief", 100, ["p1"]],
    ["h:t3", "Tool: job_reply", 5, ["t3"]],
  ]);
  assert.equal(result.headParts, 5);
});
