// Owner, 10-22 about 06:45Z: the Prompt dialog gets a second view with the parts in the order the provider gets them, and each payload block becomes
// its own part. The Summary view keeps its groups, and its "#n" numbers and one-line previews read the same as the ordered view's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageNumbers, outline, preview } from "../src/client/prompt-parts.ts";
import type { PromptPart, PromptView } from "../src/shared/prompt-view.ts";

const part = (id: string, label: string, role: PromptPart["role"] | null, text: string, message?: number): PromptPart => ({
  id, kind: role ? "message" : "system", label, source: role === "assistant" ? "model reply" : role === "user" ? "the owner" : "Prime", text, tokens: 10,
  ...role ? { role } : {}, ...message === undefined ? {} : { message },
});

const parts: PromptPart[] = [
  part("s", "Base system prompt", null, "You are"),
  part("u", "Owner", "user", "fix it", 0),
  part("t", "Assistant thinking", "assistant", "hmm", 1),
  part("a", "Assistant", "assistant", "on it", 1),
  part("c1", "Assistant tool call: ipython", "assistant", "→ ipython\nprint(1)", 1),
  part("c2", "Assistant tool call: bash", "assistant", "→ bash\nls", 1),
  part("r1", "Tool result: ipython", "toolResult", "1", 2),
  part("r2", "Tool result: bash", "toolResult", "a.txt", 3),
];
const view: PromptView = { threadId: "x", sessionFile: "x.jsonl", origin: { kind: "rebuild", reason: "test" }, totalTokens: 80, parts };

test("each tool call block counts in one Assistant tool call group", () => {
  const table = outline(view);
  const calls = table.groups.find(group => group.label === "Assistant tool call");
  assert.equal(calls?.parts.length, 2);
  assert.equal(calls?.source, "2 parts");
  assert.deepEqual(table.groups.map(group => group.label).sort(), ["Assistant", "Assistant thinking", "Assistant tool call", "Owner", "Tool result"]);
  assert.equal(table.messageParts, 7);
});

test("#n is the payload message counted from 1, shared by the blocks of one message", () => {
  const number = messageNumbers(parts);
  assert.deepEqual(["u", "t", "a", "c1", "c2", "r1", "r2"].map(id => number.get(id)), [1, 2, 2, 2, 2, 3, 4]);
  assert.equal(number.has("s"), false);
});

test("#n falls back to the place among conversation parts without a message index", () => {
  const number = messageNumbers(parts.map(({ message: _message, ...rest }) => rest));
  assert.deepEqual(["u", "t", "r2"].map(id => number.get(id)), [1, 2, 7]);
});

test("a tool call preview drops the arrow and tool name its row already shows", () => {
  assert.equal(preview(parts[4]!), "print(1)");
  assert.equal(preview(parts[3]!), "on it");
});
