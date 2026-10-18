// Guards d7 stuck_steps_all on 10-18: frontend bro checked off t28 and t25 after the owner approved in the chat at 07:31Z, and p115 and p129 stayed
// blocked on the closed asks until a nudge at 07:41Z, so the 07:38Z whole-system run counted both stuck (owner_no_todo).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoardStore } from "../src/chat-board-store.ts";
import { endState } from "../src/checkin-end-state.ts";
import { stepView } from "../src/checkin-steps.ts";
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const step = (board: ChatBoard | null, id: string): PlanItem => {
  let found: PlanItem | undefined;
  const visit = (items: readonly PlanItem[]) => { for (const item of items) { if (item.id === id) found = item; visit(item.children); } };
  visit(board!.plan);
  return found!;
};
const stateOf = (board: ChatBoard | null, id: string): string => {
  const now = Date.now();
  return endState(stepView(step(board, id), now, new Set([CHAT]), [], [], [], now), board!.todos, [], new Set([CHAT]), now).state;
};

async function withStore(run: (store: BoardStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "closed-ask-"));
  try { await run(new BoardStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** p1 with p2 waiting on t1 by id, p3 waiting on the owner and linked by t2, and p4 waiting on CI and linked by t3. */
async function frontendBro(store: BoardStore): Promise<void> {
  await store.apply(CHAT, [
    { op: "plan_add", text: "Connections and Email reach Staging" },
    { op: "plan_add", parent: "p1", text: "You look at the new Connections on Staging", status: "blocked", waitFor: "t1" },
    { op: "plan_add", parent: "p1", text: "You answer the 3 Email questions", status: "blocked", waitFor: "your answer on the Email review todo" },
    { op: "plan_add", parent: "p1", text: "Land the inbox fix", job: "inbox fix", status: "blocked", waitFor: "ci run 39102047592 green" },
    { op: "todo_add", text: "Look at Connections and say good or what to change", step: "p2" },
    { op: "todo_add", text: "Three yes or no questions on Email", step: "p3" },
    { op: "todo_add", text: "Ok to land the inbox fix?", step: "p4" },
  ] as BoardOp[], "agent");
}

test("a step that waits on a For you todo the chat checks off is the chat's to move, not stuck on the closed ask", () => withStore(async store => {
  await frontendBro(store);
  assert.equal(stateOf(await store.read(CHAT), "p2"), "foryou");
  const { board, summaries } = await store.apply(CHAT, [{ op: "todo_update", id: "t1", done: true }, { op: "todo_remove", id: "t2" }] as BoardOp[], "agent");
  for (const id of ["p2", "p3"]) {
    const item = step(board, id);
    assert.equal(item.waitFor, undefined);
    assert.equal(item.status, "todo");
    assert.equal(item.sessionId, CHAT);
    assert.equal(stateOf(board, id), "moving");
  }
  assert.match(step(board, "p2").note!, /^t1 closed at \d\d:\d\dZ with no answer/);
  assert.equal(summaries.length, 4);
  assert.match(summaries[2]!, /^p2 .* waited on t1, which closed with no answer: it waits on nothing now and is the chat's/);
}));

test("the old board left both steps stuck on the closed asks", () => withStore(async store => {
  await frontendBro(store);
  const board = (await store.read(CHAT))!;
  const closed = { ...board, todos: board.todos.map(todo => ({ ...todo, done: true })) };
  assert.equal(stateOf(closed, "p2"), "event");
  assert.equal(stateOf(closed, "p3"), "owner_no_todo");
}));

test("a closing batch that gives the step its next state, an owner's answer, and a step that waits on CI keep their own state", () => withStore(async store => {
  await frontendBro(store);
  const { board } = await store.apply(CHAT, [
    { op: "plan_update", id: "p2", status: "done" },
    { op: "todo_update", id: "t1", done: true },
    { op: "todo_update", id: "t3", done: true },
  ] as BoardOp[], "agent");
  assert.equal(step(board, "p2").status, "done");
  assert.equal(step(board, "p2").note, undefined);
  assert.equal(step(board, "p4").waitFor, "ci run 39102047592 green");
  const answered = await store.apply(CHAT, [{ op: "todo_update", id: "t2", reply: "Yes to all 3", done: true }], "owner");
  assert.equal(step(answered.board, "p3").waitFor, undefined);
  assert.match(step(answered.board, "p3").note!, /t2 closed at \d\d:\d\dZ the owner answered "Yes to all 3"/);
}));
