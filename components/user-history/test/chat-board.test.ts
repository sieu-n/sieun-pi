import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { checkInSettings } from "../src/chat-checkin.ts";
import { applyThreadEvent } from "../src/shared/thread-state.ts";
import type { ThreadState } from "../src/shared/types.ts";
import { applyBoardOp, BOARD_LIMITS, BoardError, emptyBoard, migrateBoard, nextIds, parseBoardOps, renderBoard } from "../src/shared/chat-board.ts";
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

test("chat board: scratch bullets with links; ids continue; pasted chat and wiki URLs are stored as targets", () => {
  const { board, summaries } = run(emptyBoard(T0), parseBoardOps([
    { op: "scratch_add", text: "Decision: Resend", links: [{ label: "w6 report", target: "job:w6" }] },
    { op: "scratch_add", text: "Email picks pending" },
    { op: "scratch_update", id: "s2", text: "Email picks done", links: [{ label: "page", target: "http://localhost:5176/page/sessions/a.md" }] },
    { op: "scratch_remove", id: "s1" },
    { op: "scratch_add", text: "Next" },
  ]));
  assert.deepEqual(board.scratch, [
    { id: "s2", text: "Email picks done", links: [{ label: "page", target: "wiki:sessions/a.md" }], at: T1, children: [] },
    { id: "s3", text: "Next", links: [], at: T1, children: [] },
  ]);
  assert.deepEqual(summaries, ['Added a note s1: "Decision: Resend" with links [w6 report](job:w6)', 'Added a note s2: "Email picks pending"',
    'Edited the note s2 "Email picks pending": rewrote it to "Email picks done", set its links to [page](wiki:sessions/a.md)',
    'Removed the note "Decision: Resend"', 'Added a note s3: "Next"']);
  const owner = run(board, parseBoardOps([{ op: "scratch_add", text: "See this reply",
    links: [{ label: "", target: "http://127.0.0.1:5182/x/#01a112e2-f720-75db-b51a-84cfbdbcffa0@1759800000000" }] }]), "owner");
  assert.deepEqual(owner.board.scratch.at(-1)!.links, [{ label: "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759800000000", target: "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759800000000" }]);
  assert.match(owner.summaries[0]!, /^Owner added a note: "See this reply" with links \[thread:/);
  throwsKind(() => parseBoardOps([{ op: "scratch_add", text: "x", links: [{ label: "a", target: "ftp://x" }] }]), "invalid");
  throwsKind(() => parseBoardOps([{ op: "scratch_add", text: "x", links: Array.from({ length: 6 }, () => ({ target: "job:a" })) }]), "invalid");
  const full = { ...emptyBoard(T0), scratch: Array.from({ length: BOARD_LIMITS.scratch }, (_, i) => ({ id: `s${i + 1}`, text: "x", links: [], at: T0, children: [] })) };
  throwsKind(() => run(full, [{ op: "scratch_add", text: "one more" }]), "invalid");
});

test("chat board: notes nest under a parent to any depth; remove takes the subtree; the count cap covers nested notes; a bad parent is refused", () => {
  const { board, summaries } = run(emptyBoard(T0), parseBoardOps([
    { op: "scratch_add", text: "Email" },
    { op: "scratch_add", parent: "s1", text: "Resend chosen", links: [{ label: "w6", target: "job:w6" }] },
    { op: "scratch_add", parent: "s2", text: "key in 1Password" },
    { op: "scratch_add", text: "Other" },
    { op: "scratch_update", id: "s3", text: "key in Vault" },
  ]));
  assert.deepEqual(board.scratch, [
    { id: "s1", text: "Email", links: [], at: T1, children: [
      { id: "s2", text: "Resend chosen", links: [{ label: "w6", target: "job:w6" }], at: T1, children: [
        { id: "s3", text: "key in Vault", links: [], at: T1, children: [] }] }] },
    { id: "s4", text: "Other", links: [], at: T1, children: [] },
  ]);
  assert.equal(summaries[1], 'Added a note s2: "Resend chosen" with links [w6](job:w6) under s1');
  assert.equal(summaries[4], 'Edited the note s3 "key in 1Password": rewrote it to "key in Vault"');
  assert.equal(renderBoard(board).split("Scratchpad:\n")[1], "  - s1 Email\n    - s2 Resend chosen [w6](job:w6)\n      - s3 key in Vault\n  - s4 Other");
  assert.equal(nextIds(board)("s"), "s5");
  const removed = run(board, [{ op: "scratch_remove", id: "s2" }], "owner");
  assert.equal(removed.summaries[0], 'Owner removed the note "Resend chosen" and the 1 under it');
  assert.deepEqual(removed.board.scratch.map(item => item.id), ["s1", "s4"]);
  assert.equal(removed.board.scratch[0]!.children.length, 0);
  throwsKind(() => run(board, [{ op: "scratch_add", parent: "s9", text: "x" }]), "unknown");
  const nested = { ...emptyBoard(T0), scratch: [{ id: "s1", text: "x", links: [], at: T0,
    children: Array.from({ length: BOARD_LIMITS.scratch - 1 }, (_, i) => ({ id: `s${i + 2}`, text: "x", links: [], at: T0, children: [] })) }] };
  throwsKind(() => run(nested, [{ op: "scratch_add", parent: "s1", text: "one more" }]), "invalid");
});

test("chat board: a step added under a done goal reopens the goal and every done goal above it; a doing or todo goal is left alone", () => {
  const { board } = run(emptyBoard(T0), [{ op: "plan_set", items: [
    { text: "Ship", status: "done", children: [{ text: "Build", status: "done", children: [{ text: "Tests", status: "done" }] }] },
    { text: "Later", status: "doing" },
  ] }]);
  const added = run(board, [{ op: "plan_add", parent: "p3", text: "One more case" }]);
  assert.equal(added.summaries[0], 'Added p5 "One more case" under p3, reopened p1, p2, p3');
  const statuses = (plan: ChatBoard["plan"]): string[] => plan.flatMap(item => [`${item.id}:${item.status}`, ...statuses(item.children)]);
  assert.deepEqual(statuses(added.board.plan), ["p1:todo", "p2:todo", "p3:todo", "p5:todo", "p4:doing"]);
  const under = run(board, [{ op: "plan_add", parent: "p4", text: "Step" }]);
  assert.equal(under.summaries[0], 'Added p5 "Step" under p4');
  assert.deepEqual(statuses(under.board.plan), ["p1:done", "p2:done", "p3:done", "p4:doing", "p5:todo"]);
  const blocked = run(run(board, [{ op: "plan_update", id: "p2", status: "blocked" }]).board, [{ op: "plan_add", parent: "p3", text: "x" }]);
  assert.deepEqual(statuses(blocked.board.plan), ["p1:todo", "p2:blocked", "p3:todo", "p5:todo", "p4:doing"], "a blocked goal between keeps its status");
});

test("chat board: the plan nests without a depth cap (a 12-deep chain by plan_add and by plan_set); the item cap is 500", () => {
  let board = run(emptyBoard(T0), [{ op: "plan_add", text: "root" }]).board;
  for (let depth = 1; depth < 12; depth++) board = run(board, [{ op: "plan_add", parent: `p${depth}`, text: `level ${depth}` }]).board;
  let deepest = board.plan[0]!;
  let depth = 0;
  while (deepest.children.length) { deepest = deepest.children[0]!; depth++; }
  assert.equal(depth, 11);
  assert.equal(deepest.id, "p12");
  assert.match(renderBoard(board), /\n {24}\[ \] p12 level 11 \(todo\)$/m);
  const chain = (level: number): { text: string; children?: { text: string }[] } => level === 12 ? { text: "leaf" } : { text: `l${level}`, children: [chain(level + 1)] };
  const set = run(emptyBoard(T0), parseBoardOps([{ op: "plan_set", items: [chain(1)] }]));
  assert.equal(set.summaries[0], "Set the plan: 12 items");
  assert.equal(BOARD_LIMITS.planItems, 500);
  const full = run(emptyBoard(T0), [{ op: "plan_set", items: Array.from({ length: 500 }, (_, i) => ({ text: `g${i}` })) }]).board;
  throwsKind(() => run(full, [{ op: "plan_add", text: "501" }]), "invalid");
});

test("chat board: an agent todo offers 2 to 4 choices; tapping one steers 'chose'; at most 3 open agent asks", () => {
  const { board, summaries } = run(emptyBoard(T0), [{ op: "todo_add", text: "Deploy now?", choices: ["Yes", "Wait for QA"] }]);
  assert.deepEqual(board.todos[0], { id: "t1", text: "Deploy now?", done: false, choices: ["Yes", "Wait for QA"], from: "agent", at: T1 });
  assert.equal(summaries[0], 'Added a todo t1 "Deploy now?" with choices "Yes" / "Wait for QA"');
  const tapped = run(board, [{ op: "todo_update", id: "t1", reply: "Wait for QA", done: true }], "owner");
  assert.deepEqual(tapped.summaries, ['Owner chose "Wait for QA" for "Deploy now?"']);
  assert.equal(tapped.board.todos[0]!.done, true);
  assert.equal(run(board, [{ op: "todo_update", id: "t1", reply: "Only staging" }], "owner").summaries[0], 'Owner answered "Deploy now?": Only staging');
  for (const choices of [["one"], ["a", "b", "c", "d", "e"], ["a", "a"], ["a", "x".repeat(81)], ["a", " "]]) {
    throwsKind(() => parseBoardOps([{ op: "todo_add", text: "q", choices }]), "invalid");
  }
  const three = run(emptyBoard(T0), [{ op: "todo_add", text: "a" }, { op: "todo_add", text: "b" }, { op: "todo_add", text: "c" }]).board;
  throwsKind(() => run(three, [{ op: "todo_add", text: "d" }]), "invalid");
  assert.equal(run(three, [{ op: "todo_add", text: "mine" }], "owner").board.todos.length, 4, "the owner's own todos are not capped");
  const oneDone = run(three, [{ op: "todo_update", id: "t1", done: true }], "owner").board;
  assert.equal(run(oneDone, [{ op: "todo_add", text: "d" }]).board.todos.length, 4, "a checked ask frees a slot");
});

test("chat board: a v1 file migrates to bullets, one per non-empty line; a v2 file passes; anything else throws", () => {
  const v1 = { v: 1, rev: 4, plan: [], todos: [], updatedAt: T0, scratchpad: "- Decision: Resend\n\n* picks pending\nplain line\n" };
  assert.deepEqual(migrateBoard(v1), { v: 2, rev: 4, plan: [], todos: [], updatedAt: T0, scratch: [
    { id: "s1", text: "Decision: Resend", links: [], at: T0, children: [] }, { id: "s2", text: "picks pending", links: [], at: T0, children: [] },
    { id: "s3", text: "plain line", links: [], at: T0, children: [] }] });
  const v2 = emptyBoard(T0);
  assert.equal(migrateBoard(v2), v2);
  const flat = { ...emptyBoard(T0), scratch: [{ id: "s1", text: "old", links: [], at: T0 }, { id: "s2", text: "nested", links: [], at: T0, children: [{ id: "s3", text: "child", links: [], at: T0 }] }] };
  assert.deepEqual(migrateBoard(flat).scratch, [{ id: "s1", text: "old", links: [], at: T0, children: [] },
    { id: "s2", text: "nested", links: [], at: T0, children: [{ id: "s3", text: "child", links: [], at: T0, children: [] }] }], "a v2 file written before notes nested reads with children");
  const nested = migrateBoard(flat);
  assert.equal(migrateBoard(nested), nested, "a file with children on every note passes through");
  assert.throws(() => migrateBoard({ v: 3, rev: 0, plan: [], todos: [], scratch: [], updatedAt: T0 }), /malformed/);
  assert.throws(() => migrateBoard(null), /malformed/);
  assert.equal(nextIds(migrateBoard(v1))("s"), "s4");
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

test("chat board: the owner may change todos and the scratchpad, never the plan; unknown ids and bad input are refused", () => {
  const board = run(emptyBoard(T0), [{ op: "plan_add", text: "A" }]).board;
  for (const op of [{ op: "plan_add", text: "x" }, { op: "plan_update", id: "p1", status: "done" }, { op: "plan_remove", id: "p1" },
    { op: "plan_set", items: [] }] as BoardOp[]) {
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
  throwsKind(() => parseBoardOps([{ op: "scratchpad", text: "x" }]), "invalid");
  throwsKind(() => run(board, [{ op: "scratch_remove", id: "s9" }], "owner"), "unknown");
  assert.deepEqual(parseBoardOps([{ op: "scratch_add", text: "n", links: [{ label: "r", target: "/Users/me/r.md" }] }, { op: "plan_add", text: "a", parent: null }]),
    [{ op: "scratch_add", text: "n", links: [{ label: "r", target: "file:/Users/me/r.md" }] }, { op: "plan_add", text: "a" }]);
});

test("chat board: render shows this chat's target, the nested checklist, todos with choices and answers, and the scratch bullets with links", () => {
  assert.match(renderBoard(null), /^The board is empty/);
  assert.match(renderBoard(null, "s-1"), /^This chat: thread:s-1\nThe board is empty/);
  const { board } = run(emptyBoard(T0), [
    { op: "plan_add", text: "Goal", status: "doing" },
    { op: "plan_add", parent: "p1", text: "Step", status: "done", job: "w6" },
    { op: "todo_add", text: "Approve", choices: ["Yes", "No"] },
    { op: "scratch_add", text: "note one", links: [{ label: "report", target: "job:w6" }, { label: "doc", target: "wiki:a/b.md" }] },
  ]);
  const answered = run(board, [{ op: "todo_update", id: "t1", done: true, reply: "Yes" }], "owner").board;
  assert.equal(renderBoard(answered, "s-1"), [
    "This chat: thread:s-1", `Board rev 5, updated ${T1}`, "Plan:", "  [~] p1 Goal (doing)", "    [x] p2 Step (done, job w6)",
    "Owner todos:", '  [x] t1 Approve (from agent), choices: "Yes" (recommended) / "No", answer: Yes',
    "Scratchpad:", "  - s1 note one [report](job:w6) [doc](wiki:a/b.md)"].join("\n"));
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
  assert.match(added.content[0]!.text, /^Added p1 "Goal"\nAdded a todo t1 "Approve"\nThis chat: thread:s-1\nCheck-in: every 5 min\nBoard rev 2/);
  assert.equal((await new BoardStore(dataDir).read("s-1"))?.rev, 2);
  await checkInSettings(join(dataDir, "check-in-settings.json")).update("s-1", () => ({ everyMs: 15 * 60_000, pausedUntil: "forever" }));
  assert.match((await tool.execute("c2", { ops: [] }, undefined, undefined, ctx)).content[0]!.text, /^This chat: thread:s-1\nCheck-in: paused until the owner resumes it\nBoard rev 2/,
    "the chat reads the owner's setting from the data dir");
  await assert.rejects(tool.execute("c3", { ops: [{ op: "plan_update", id: "p7", status: "done" }] }, undefined, undefined, ctx), /No plan item p7/);
});
