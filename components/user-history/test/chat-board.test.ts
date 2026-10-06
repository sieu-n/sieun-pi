import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { applyThreadEvent } from "../src/shared/thread-state.ts";
import type { ThreadState } from "../src/shared/types.ts";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps, renderBoard } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:01:00.000Z";
function run(board: ChatBoard, ops: BoardOp[], actor: BoardActor = "agent"): { board: ChatBoard; summaries: string[] } {
  const summaries: string[] = [];
  for (const op of ops) { const result = applyBoardOp(board, op, actor, T1, nextIds(board)); board = result.board; summaries.push(result.summary); }
  return { board, summaries };
}
function throwsKind(fn: () => unknown, kind: BoardError["kind"]): void {
  assert.throws(fn, error => error instanceof BoardError && error.kind === kind);
}

test("chat board: plan add, nest, update, remove by id at any depth; rev rises per op", () => {
  const start = emptyBoard(T0);
  const { board, summaries } = run(start, [
    { op: "plan_add", text: "Ship the board" },
    { op: "plan_add", parent: "p1", text: "Reducer", status: "doing", job: "w6" },
    { op: "plan_add", parent: "p2", text: "Tests" },
    { op: "plan_update", id: "p3", status: "done", note: "16 cases" },
    { op: "plan_update", id: "p2", job: null },
  ]);
  assert.equal(start.rev, 0, "the input board is not mutated");
  assert.equal(board.rev, 5);
  assert.equal(board.updatedAt, T1);
  assert.deepEqual(board.plan, [{ id: "p1", text: "Ship the board", status: "todo", children: [
    { id: "p2", text: "Reducer", status: "doing", children: [{ id: "p3", text: "Tests", status: "done", note: "16 cases", children: [] }] }] }]);
  assert.deepEqual(summaries, ['Added p1 "Ship the board"', 'Added p2 "Reducer" under p1', 'Added p3 "Tests" under p2',
    'Updated p3 "Tests": marked it done, updated its note', 'Updated p2 "Reducer": unlinked its job']);
  const removed = run(board, [{ op: "plan_remove", id: "p2" }]);
  assert.deepEqual(removed.board.plan, [{ id: "p1", text: "Ship the board", status: "todo", children: [] }]);
  assert.equal(removed.summaries[0], 'Removed p2 "Reducer" and its 1 step');
  assert.equal(run(removed.board, [{ op: "plan_add", text: "Next" }]).board.plan[1]!.id, "p2", "ids continue after the highest left");
});

test("chat board: plan_set keeps given ids, fills the rest without collisions, defaults status", () => {
  const { board, summaries } = run(emptyBoard(T0), [{ op: "plan_set", items: [
    { text: "A", children: [{ id: "p1", text: "A.1", status: "doing" }, { text: "A.2" }] },
    { id: "p1", text: "dup id" },
  ] }]);
  const ids: string[] = [];
  const visit = (items: ChatBoard["plan"]) => { for (const item of items) { ids.push(item.id); visit(item.children); } };
  visit(board.plan);
  assert.equal(new Set(ids).size, 4, ids.join());
  assert.equal(board.plan[0]!.children[0]!.id, "p1");
  assert.equal(board.plan[0]!.status, "todo");
  assert.equal(summaries[0], "Set the plan: 4 items");
});

test("chat board: scratchpad replace and append", () => {
  const { board, summaries } = run(emptyBoard(T0), [
    { op: "scratchpad", text: "Decision: Resend", mode: "replace" },
    { op: "scratchpad", text: "Email picks pending", mode: "append" },
  ]);
  assert.equal(board.scratchpad, "Decision: Resend\nEmail picks pending");
  assert.deepEqual(summaries, ["Rewrote the scratchpad", "Added to the scratchpad"]);
});

test("chat board: todos from the agent, checked and answered by the owner in plain words", () => {
  const agent = run(emptyBoard(T0), [{ op: "todo_add", text: "Approve the Email picks" }, { op: "todo_add", text: "Pick a provider" }]);
  assert.deepEqual(agent.board.todos[0], { id: "t1", text: "Approve the Email picks", done: false, from: "agent", at: T1 });
  assert.equal(agent.summaries[0], 'Added a todo t1 "Approve the Email picks"');
  const owner = run(agent.board, [
    { op: "todo_update", id: "t1", done: true },
    { op: "todo_update", id: "t2", reply: "Use Resend", done: true },
    { op: "todo_add", text: "Ping me at 5" },
    { op: "todo_update", id: "t1", done: false, text: "Approve the picks" },
    { op: "todo_remove", id: "t3" },
  ], "owner");
  assert.deepEqual(owner.summaries, ['Owner checked "Approve the Email picks"', 'Owner checked "Pick a provider" and answered: Use Resend',
    'Owner added a todo "Ping me at 5"', 'Owner renamed "Approve the Email picks" to "Approve the picks" and unchecked it', 'Owner removed the todo "Ping me at 5"']);
  assert.equal(owner.board.todos[1]!.reply, "Use Resend");
  assert.equal(owner.board.rev, 7);
  const cleared = run(owner.board, [{ op: "todo_update", id: "t2", reply: null }], "owner");
  assert.equal(cleared.board.todos[1]!.reply, undefined);
  assert.equal(cleared.summaries[0], 'Owner cleared the answer on "Pick a provider"');
});

test("chat board: the owner may change only todos; unknown ids and bad input are refused", () => {
  const board = run(emptyBoard(T0), [{ op: "plan_add", text: "A" }]).board;
  for (const op of [{ op: "plan_add", text: "x" }, { op: "plan_update", id: "p1", status: "done" }, { op: "plan_remove", id: "p1" },
    { op: "plan_set", items: [] }, { op: "scratchpad", text: "x", mode: "replace" }] as BoardOp[]) {
    throwsKind(() => applyBoardOp(board, op, "owner", T1, nextIds(board)), "forbidden");
  }
  throwsKind(() => run(board, [{ op: "plan_update", id: "p9", status: "done" }]), "unknown");
  throwsKind(() => run(board, [{ op: "plan_add", parent: "p9", text: "x" }]), "unknown");
  throwsKind(() => run(board, [{ op: "todo_update", id: "t1", done: true }], "owner"), "unknown");
  throwsKind(() => run(board, [{ op: "todo_remove", id: "t1" }], "owner"), "unknown");
  throwsKind(() => parseBoardOps([{ op: "plan_update", id: "p1", status: "finished" }]), "invalid");
  throwsKind(() => parseBoardOps([{ op: "todo_add", text: "  " }]), "invalid");
  throwsKind(() => parseBoardOps([{ op: "nope" }]), "invalid");
  throwsKind(() => parseBoardOps({ op: "todo_add", text: "x" }), "invalid");
  assert.deepEqual(parseBoardOps([{ op: "scratchpad", text: "" }, { op: "plan_add", text: "a", parent: null }]),
    [{ op: "scratchpad", text: "", mode: "replace" }, { op: "plan_add", text: "a" }]);
});

test("chat board: render shows the nested checklist, todos with answers, and the scratchpad", () => {
  assert.match(renderBoard(null), /empty/);
  const { board } = run(emptyBoard(T0), [
    { op: "plan_add", text: "Goal", status: "doing" },
    { op: "plan_add", parent: "p1", text: "Step", status: "done", job: "w6" },
    { op: "todo_add", text: "Approve" },
    { op: "scratchpad", text: "note one", mode: "replace" },
  ]);
  const answered = run(board, [{ op: "todo_update", id: "t1", done: true, reply: "yes" }], "owner").board;
  assert.equal(renderBoard(answered), [
    `Board rev 5, updated ${T1}`, "Plan:", "  [~] p1 Goal (doing)", "    [x] p2 Step (done, job w6)",
    "Owner todos:", "  [x] t1 Approve (from agent), answer: yes", "Scratchpad:", "note one"].join("\n"));
});

test("board store: read is null before the first op, apply writes all ops or none, watch reports each writer's change", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "boards-"));
  const store = new BoardStore(dataDir);
  const seen: { id: string; rev: number }[] = [];
  const stop = store.watch((id, board) => seen.push({ id, rev: board.rev }));
  assert.equal(await store.read("chat-a"), null);
  assert.deepEqual(await store.apply("chat-a", [], "agent"), { board: null, summaries: [] });
  const first = await store.apply("chat-a", [{ op: "plan_add", text: "Goal" }, { op: "todo_add", text: "Approve" }], "agent");
  assert.equal(first.board?.rev, 2);
  assert.deepEqual(first.summaries, ['Added p1 "Goal"', 'Added a todo t1 "Approve"']);
  await assert.rejects(store.apply("chat-a", [{ op: "todo_update", id: "t1", done: true }, { op: "plan_remove", id: "p1" }], "owner"), BoardError);
  assert.equal((await store.read("chat-a"))?.todos[0]?.done, false, "a refused op leaves the file as it was");
  const checked = await store.apply("chat-a", [{ op: "todo_update", id: "t1", done: true }], "owner");
  assert.equal(checked.board?.rev, 3);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "boards", "chat-a.json"), "utf8")), checked.board);
  await assert.rejects(store.apply("../x", [{ op: "todo_add", text: "x" }], "agent"), /Not a session id/);
  await writeFile(join(dataDir, "boards", "notes.txt"), "ignored");
  await new Promise(resolve => setTimeout(resolve, 300));
  stop();
  assert.deepEqual(seen.at(-1), { id: "chat-a", rev: 3 });
  assert.ok(seen.every(entry => entry.id === "chat-a"), JSON.stringify(seen));
});

test("thread state: a board event sets the chat's board", () => {
  const board = run(emptyBoard(T0), [{ op: "todo_add", text: "Approve" }]).board;
  const state = { board: null } as unknown as ThreadState;
  assert.equal(applyThreadEvent(state, { type: "board", board }).board, board);
});

test("extension: chat_board writes the chat's board under agent-chat-data-dir and returns the summaries and the whole board", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "board-ext-"));
  const tools = new Map<string, { promptGuidelines?: string[]; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const tool = tools.get("chat_board")!;
  assert.ok(tool.promptGuidelines?.some(line => line.includes("CTO")));
  const ctx = { sessionManager: { getSessionId: () => "s-1" } };
  const added = await tool.execute("c1", { ops: [{ op: "plan_add", text: "Goal", status: "doing" }, { op: "todo_add", text: "Approve" }] }, undefined, undefined, ctx);
  assert.match(added.content[0]!.text, /^Added p1 "Goal"\nAdded a todo t1 "Approve"\nBoard rev 2/);
  assert.equal((await new BoardStore(dataDir).read("s-1"))?.rev, 2);
  assert.match((await tool.execute("c2", { ops: [] }, undefined, undefined, ctx)).content[0]!.text, /^Board rev 2/);
  await assert.rejects(tool.execute("c3", { ops: [{ op: "plan_update", id: "p7", status: "done" }] }, undefined, undefined, ctx), /No plan item p7/);
});
