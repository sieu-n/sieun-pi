// Guards owner rule c145 (owner 10-19): plan steps, todos and duties named by id in a chat message render as chips.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionIndex } from "../src/client/board.ts";
import { renderMarkdown } from "../src/client/markdown.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/** Owner, 10-19: "메시지 보낼때 Plan, Duty id 좀 써 p684 이런 식으로", with a screenshot of p684 as a chip in his own message. */
const board: ChatBoard = { v: 2, rev: 3, updatedAt: "", plan: [{ id: "p684", text: "Ship the chips", status: "doing", children: [] }],
  todos: [{ id: "t12", text: "Pick a color", from: "agent", done: false, at: "" }] };
const index = mentionIndex("chat-1", board, [], [{ id: "d9", name: "Whole system" }]);

test("a tell_owner message chips the plan step, todo and duty ids the chat has", () => {
  const html = renderMarkdown("p684 shipped, d9 runs at 07:40 and t12 waits on you.", "", index, true);
  for (const id of ["p684", "t12", "d9"]) assert.match(html, new RegExp(`data-mention="${id}"`), html);
  assert.match(html, /title="Whole system"/);
});

test("an id the chat does not have, or one inside a word or code, stays text", () => {
  const html = renderMarkdown("d10 and xd9 and `d9` and p999.", "", index, true);
  assert.doesNotMatch(html, /data-mention/, html);
});
