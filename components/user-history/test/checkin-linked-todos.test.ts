// mac-management 10-19: p5 "Token usage reaches LGTM" waited on chat-057a's For you t6, the owner's choice on a one-time update window, and
// goal_gaps flagged it in every check-in, because a goal read as held only by the chat's own todos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endState, heldByTodo } from "../src/checkin-end-state.ts";
import { goalPushes, linkedTodoRefs, withLinkedTodos } from "../src/checkin-goals.ts";
import { stepView } from "../src/checkin-steps.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-19T17:10:00Z");
const other = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
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

// AI harness 10-23: p919 waited for "thread:01a16213-54c6-73fa-b399-20e2713c41ba t11", the owner's Apple sign-in asked once as Railway Breach's
// t11, while the chat's own t11 is an old closed todo. A linked todo holds only the wait that names its chat, and a bare id names only this chat's.
const breach = "01a16213-54c6-73fa-b399-20e2713c41ba";
const signIn = (done: boolean): OwnerTodo => ({ id: "t11", text: "Sign fhnyq29tw5 back in with Apple", done, from: "agent", at: "2026-10-22T10:13:13Z" });
const p919: PlanItem = { id: "p919", text: "Codex account fhnyq29tw5 is signed back into the account pool", status: "blocked", children: [],
  waitFor: `thread:${breach} t11`, sessionId: CHAT };
const ownT11 = (done: boolean): OwnerTodo => ({ id: "t11", text: "Delete the old Slack app?", done, from: "agent", at: "2026-10-08T07:46:05Z" });
const harness = (todos: OwnerTodo[], plan: PlanItem[] = [p919]) => ({ v: 2, rev: 1, updatedAt: "2026-10-23T03:00:00Z", plan, todos }) as unknown as ChatBoard;
const endOf = (item: PlanItem, board: ChatBoard): string => {
  const at = Date.parse("2026-10-23T03:11:00Z");
  return endState(stepView(item, at - 8 * 3_600_000, new Set([CHAT]), [], [], [], at), board.todos, [], new Set([CHAT]), at).state;
};

test("a step waiting on another thread's open todo is For you, and stuck again once that todo is done", () => {
  assert.equal(endOf(p919, withLinkedTodos(harness([ownT11(true)]), [{ chat: breach, todo: signIn(false) }])), "foryou");
  assert.equal(endOf(p919, withLinkedTodos(harness([ownT11(true)]), [{ chat: breach, todo: signIn(true) }])), "event");
});

test("this chat's own todo of the same id holds no wait on another thread's todo", () => {
  assert.equal(heldByTodo(p919, withLinkedTodos(harness([ownT11(false)]), [{ chat: breach, todo: signIn(true) }]).todos), false);
});

test("another thread's todo holds no bare wait on this chat's todo of the same id", () => {
  const own: PlanItem = { id: "p5", text: "Delete the old Slack app", status: "blocked", children: [], waitFor: "t11", sessionId: CHAT };
  const board = withLinkedTodos(harness([ownT11(true)], [p919, own]), [{ chat: breach, todo: signIn(false) }]);
  assert.equal(heldByTodo(own, board.todos), false);
  assert.equal(heldByTodo(p919, board.todos), true);
});
