import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

const T0 = "2026-10-14T04:29:50.206Z";
const T1 = "2026-10-18T01:00:00.000Z";
const ASK = "Three yes or no questions on Email. 1. Templates first? 2. A template without an experiment? 3. Publish with no campaign?";

function run(board: ChatBoard, ops: BoardOp[], actor: BoardActor = "agent"): { board: ChatBoard; summaries: string[] } {
  const summaries: string[] = [];
  for (const op of ops) { const result = applyBoardOp(board, op, actor, T1, nextIds(board)); board = result.board; summaries.push(result.summary); }
  return { board, summaries };
}
const asked = (): ChatBoard => ({ ...emptyBoard(T0), todos: [{ id: "t25", text: ASK, done: false, from: "agent", at: T0 }] });

test("todo_update choices: an open free-text ask (t25, 92 h on 10-18) gains tap choices in place and keeps its asked time", () => {
  const [op] = parseBoardOps([{ op: "todo_update", id: "t25", choices: ["Yes to all 3", "No to some, I'll say which"] }]);
  const { board, summaries } = run(asked(), [op!]);
  assert.deepEqual(board.todos[0], { id: "t25", text: ASK, done: false, from: "agent", at: T0, choices: ["Yes to all 3", "No to some, I'll say which"] });
  assert.match(summaries[0]!, /^Offered "Yes to all 3" \/ "No to some, I'll say which" on "Three yes or no/);
  const tapped = run(board, [{ op: "todo_update", id: "t25", reply: "Yes to all 3", done: true }], "owner");
  assert.equal(tapped.board.todos[0]!.answeredBy, "owner");
  assert.match(tapped.summaries[0]!, /^Owner chose "Yes to all 3"/);
});

test("todo_update choices: null clears them, the same list is a no-op, and a malformed list is refused at parse", () => {
  const offered = run(asked(), [{ op: "todo_update", id: "t25", choices: ["Yes", "No"] }]).board;
  const same = run(offered, [{ op: "todo_update", id: "t25", choices: ["Yes", "No"] }]);
  assert.equal(same.board.todos[0]!.choices?.length, 2);
  assert.match(same.summaries[0]!, /^Left /);
  const [clear] = parseBoardOps([{ op: "todo_update", id: "t25", choices: null }]);
  const cleared = run(offered, [clear!]);
  assert.equal("choices" in cleared.board.todos[0]!, false);
  assert.match(cleared.summaries[0]!, /^Cleared the choices on /);
  assert.throws(() => parseBoardOps([{ op: "todo_update", id: "t25", choices: "Yes" }]), error => error instanceof BoardError && error.kind === "invalid");
});

test("todo_update choices: the agent cannot change the choices of a todo the owner answered", () => {
  const answered = run(asked(), [{ op: "todo_update", id: "t25", reply: "yes yes no", done: true }], "owner").board;
  assert.throws(() => run(answered, [{ op: "todo_update", id: "t25", choices: ["Yes", "No"] }]), error => error instanceof BoardError && error.kind === "forbidden");
});
