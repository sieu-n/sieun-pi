import assert from "node:assert/strict";
import { test } from "node:test";
import { groupName, outline, share, speakerOf, textHeight } from "../src/client/prompt-parts.ts";
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

test("outline: the parts before the conversation in order, then the conversation by group, biggest first", () => {
  const result = outline(view);
  assert.deepEqual(result.head.map(item => item.id), ["p0", "p1"]);
  assert.equal(result.headTokens, 400);
  assert.equal(result.messages.length, 7);
  assert.equal(result.messageTokens, 600);
  assert.deepEqual(result.groups.map(group => [group.name, group.count, group.tokens, group.speaker]), [
    ["Tool result", 2, 350, "tool"],
    ["[check-in]", 2, 140, "injected"],
    ["Assistant tool call", 1, 50, "model"],
    ["Agent message", 1, 40, "injected"],
    ["Owner", 1, 20, "owner"],
  ]);
});

test("share: whole percents from 10%, one decimal below, and <0.1% for a sliver", () => {
  assert.equal(share(310, 1000), "31%");
  assert.equal(share(24, 1000), "2.4%");
  assert.equal(share(1, 100_000), "<0.1%");
  assert.equal(share(0, 1000), "0%");
  assert.equal(share(5, 0), "0%");
});

test("textHeight: one line per newline, long lines wrap at the column count", () => {
  assert.equal(textHeight("a\nb", 110, 18), 36);
  assert.equal(textHeight("x".repeat(220), 110, 18), 36);
  assert.equal(textHeight("", 110, 18), 18);
});
