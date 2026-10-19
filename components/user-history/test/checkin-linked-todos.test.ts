// mac-management 10-19: p5 "Token usage reaches LGTM" waited on chat-057a's For you t6, the owner's choice on a one-time update window, and
// goal_gaps flagged it in every check-in, because a goal read as held only by the chat's own todos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalPushes, linkedTodoRefs, withLinkedTodos } from "../src/checkin-goals.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-19T17:10:00Z");
const other = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const wait = `chat-057a's For you on the update window (${other} t6)`;
const p18: PlanItem = { id: "p18", text: "Get the Mac and metal Prime daemons sending token usage to LGTM", status: "doing", children: [], waitFor: wait };
const p5: PlanItem = { id: "p5", text: "Token usage from the Mac and metal reaches LGTM", status: "doing", children: [p18], waitFor: wait,
  target: { metric: "hosts sending prime_agent_tokens_total to LGTM", target: 2, unit: "hosts", current: 0, measuredAt: "2026-10-19T17:00:00Z", source: "LGTM query" } };
const board = { v: 2, rev: 1, updatedAt: "2026-10-19T17:00:00Z", plan: [p5], todos: [] } as unknown as ChatBoard;
const t6 = (done: boolean): OwnerTodo => ({ id: "t6", text: "One update window? It names p5 and p18 of its own plan.", done, from: "agent", at: "2026-10-19T16:30:00Z", step: "p5" });

test("a wait naming another chat's id and todo id is a linked todo", () => {
  assert.deepEqual(linkedTodoRefs(board.plan), [{ chat: other, id: "t6" }]);
  assert.deepEqual(linkedTodoRefs([{ ...p5, waitFor: "chat-057a's t6", children: [{ ...p18, waitFor: "chat-057a's t6" }] }]), []);
});

test("an open todo of another chat that the goal waits on holds the goal, and a done one does not", () => {
  const held = goalPushes(withLinkedTodos(board, [{ chat: other, todo: t6(false) }]), [], undefined, 30 * 60_000, now).pushes[0];
  assert.equal(held?.act, "owner");
  const open = goalPushes(withLinkedTodos(board, [{ chat: other, todo: t6(true) }]), [], undefined, 30 * 60_000, now).pushes[0];
  assert.notEqual(open?.act, "owner");
});

test("a linked todo keeps only its id, so the other chat's step ids hold nothing here", () => {
  const [todo] = withLinkedTodos(board, [{ chat: other, todo: t6(false) }]).todos;
  assert.equal(todo?.step, undefined);
  assert.doesNotMatch(todo?.text ?? "", /\bp\d+\b/);
});
