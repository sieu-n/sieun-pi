import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { applyThreadEvent } from "../src/shared/thread-state.ts";
import type { ThreadState } from "../src/shared/types.ts";
import { applyBoardOp, BOARD_LIMITS, BoardError, emptyBoard, nextIds, parseBoard, parseBoardOps, renderOpenPlan, SCRATCHPAD_REMOVED } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

const T0 = "2026-10-06T00:00:00.000Z";
const T1 = "2026-10-06T00:01:00.000Z";
/** A requirements check that passes, for a goal whose Build step a test moves. */
const MET = [{ text: '"one board per chat"', status: "met" as const, evidence: "the store writes boards/<id>.json" }];
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

test("chat board: a step waits until a time or for an event; plan_add, plan_update and plan_set carry it, null clears it, and the agent's board shows it", () => {
  const ops = parseBoardOps([
    { op: "plan_add", text: "Renew", status: "blocked", waitUntil: "2026-10-09T09:00:00+09:00" },
    { op: "plan_add", text: "Ship", waitFor: "the vendor's reply" },
    { op: "plan_update", id: "p1", waitFor: "the registrar email" },
    { op: "plan_update", id: "p2", waitFor: null, waitUntil: "2026-10-10" },
  ]);
  assert.deepEqual(ops[0], { op: "plan_add", text: "Renew", status: "blocked", waitUntil: "2026-10-09T00:00:00.000Z" }, "stored as an ISO string in UTC");
  const { board, summaries } = run(emptyBoard(T0), ops);
  assert.deepEqual(board.plan.map(item => [item.id, item.waitUntil, item.waitFor]),
    [["p1", "2026-10-09T00:00:00.000Z", "the registrar email"], ["p2", "2026-10-10T00:00:00.000Z", undefined]]);
  assert.deepEqual(summaries.slice(2), ['Updated p1 "Renew": set it to wait for "the registrar email"',
    'Updated p2 "Ship": set it to wait until 2026-10-10T00:00:00.000Z, cleared what it waits for']);
  assert.match(renderOpenPlan(board), /\[!\] p1 Renew \(waits until 2026-10-09T00:00:00.000Z, waits for the registrar email\)/);
  const cleared = run(board, parseBoardOps([{ op: "plan_update", id: "p1", waitUntil: null, waitFor: null }]));
  assert.deepEqual(cleared.board.plan[0], { id: "p1", text: "Renew", status: "blocked", children: [] });
  assert.equal(cleared.summaries[0], 'Updated p1 "Renew": cleared its wait time, cleared what it waits for');
  const set = run(emptyBoard(T0), parseBoardOps([{ op: "plan_set", items: [{ text: "Goal", children: [{ text: "Step", waitFor: "a slot" }] }] }]));
  assert.equal(set.board.plan[0]!.children[0]!.waitFor, "a slot");
  for (const bad of ["tomorrow", "09:00", 1, ""]) throwsKind(() => parseBoardOps([{ op: "plan_update", id: "p1", waitUntil: bad }]), "invalid");
  const long = run(emptyBoard(T0), parseBoardOps([{ op: "plan_add", text: "x", waitFor: "x".repeat(BOARD_LIMITS.waitFor + 1) }]));
  assert.equal(long.board.plan[0]!.waitFor!.length, BOARD_LIMITS.waitFor + 1, "a long waitFor is saved whole");
  assert.match(long.summaries[0]!, /\nSaved over a soft target: waitFor is 201 characters, over the 200 target\./);
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

test("chat board: the scratchpad is gone, so a scratch op is refused with the step-note fix; todo links store pasted chat and wiki URLs as targets", () => {
  for (const op of [{ op: "scratch_add", text: "Decision: Resend" }, { op: "scratch_update", id: "s2", text: "x" }, { op: "scratch_remove", id: "s1" }]) {
    assert.throws(() => parseBoardOps([op]), error => error instanceof BoardError && error.kind === "invalid" && error.message === SCRATCHPAD_REMOVED);
  }
  assert.match(SCRATCHPAD_REMOVED, /note of the step it concerns \(plan_update \{id, note\}\)/);
  const thread = "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759800000000";
  assert.deepEqual(parseBoardOps([{ op: "todo_add", text: "Look at this", links: [{ label: "page", target: "http://localhost:5176/page/sessions/a.md" },
    { label: "", target: "http://127.0.0.1:5182/x/#01a112e2-f720-75db-b51a-84cfbdbcffa0@1759800000000" }, { label: "r", target: "/Users/me/r.md" },
    { label: "browser to aside", target: "job:browser to aside" }] }]),
    [{ op: "todo_add", text: "Look at this", links: [{ label: "page", target: "wiki:sessions/a.md" }, { label: thread, target: thread }, { label: "r", target: "file:/Users/me/r.md" },
      { label: "browser to aside", target: "job:browser to aside" }] }]);
  throwsKind(() => parseBoardOps([{ op: "todo_add", text: "x", links: [{ label: "a", target: "ftp://x" }] }]), "invalid");
  const six = run(emptyBoard(T0), parseBoardOps([{ op: "todo_add", text: "x", links: Array.from({ length: 6 }, () => ({ target: "job:a" })) }]));
  assert.equal(six.board.todos[0]!.links!.length, 6, "a sixth link is saved");
  assert.match(six.summaries[0]!, /6 links, over the 5 target/);
});

test("chat board: a step added under a done goal reopens the goal and every done goal above it; a doing or todo goal is left alone", () => {
  const { board } = run(emptyBoard(T0), [{ op: "plan_set", items: [
    { text: "Ship", status: "done", requirements: MET, children: [{ text: "Build", status: "done", children: [{ text: "Tests", status: "done" }] }] },
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

test("chat board: the plan nests without a depth cap (a 12-deep chain by plan_add and by plan_set); the cap of 500 counts open items only", () => {
  let board = run(emptyBoard(T0), [{ op: "plan_add", text: "root" }]).board;
  for (let depth = 1; depth < 12; depth++) board = run(board, [{ op: "plan_add", parent: `p${depth}`, text: `level ${depth}` }]).board;
  let deepest = board.plan[0]!;
  let depth = 0;
  while (deepest.children.length) { deepest = deepest.children[0]!; depth++; }
  assert.equal(depth, 11);
  assert.equal(deepest.id, "p12");
  assert.match(renderOpenPlan(board), /\n {24}\[ \] p12 level 11$/m);
  const chain = (level: number): { text: string; children?: { text: string }[] } => level === 12 ? { text: "leaf" } : { text: `l${level}`, children: [chain(level + 1)] };
  const set = run(emptyBoard(T0), parseBoardOps([{ op: "plan_set", items: [chain(1)] }]));
  assert.equal(set.summaries[0], "Set the plan: 12 items");
  assert.equal(BOARD_LIMITS.planItems, 500);
  const closed = run(emptyBoard(T0), [{ op: "plan_set", items: Array.from({ length: 600 }, (_, i) => ({ text: `g${i}`, status: i % 2 ? "done" as const : "dropped" as const })) }]).board;
  assert.equal(run(closed, [{ op: "plan_add", text: "601" }]).summaries[0], 'Added p601 "601"', "600 done and dropped items leave room, as on the Crawler VP's board on 10-15");
  const full = run(emptyBoard(T0), [{ op: "plan_set", items: Array.from({ length: 500 }, (_, i) => ({ text: `g${i}`, status: i % 2 ? "doing" as const : "todo" as const })) }]).board;
  const over = run(full, [{ op: "plan_add", text: "501" }]);
  assert.equal(over.board.plan.length, 501, "the 501st open item is saved");
  assert.match(over.summaries[0]!, /\nThe open plan has 501 goals and steps, over the 500 target/);
  assert.doesNotMatch(run(over.board, [{ op: "plan_update", id: "p1", status: "doing" }]).summaries[0]!, /over the 500 target/, "an op that adds no open item is not flagged");
  assert.match(run(emptyBoard(T0), [{ op: "plan_set", items: Array.from({ length: 501 }, (_, i) => ({ text: `g${i}` })) }]).summaries[0]!, /over the 500 target/);
});

test("chat board: an agent todo offers 2 to 4 choices; tapping one steers 'chose'; a chat may leave any number of asks open (c96)", () => {
  const { board, summaries } = run(emptyBoard(T0), [{ op: "todo_add", text: "Deploy now?", choices: ["Yes", "Wait for QA"] }]);
  assert.deepEqual(board.todos[0], { id: "t1", text: "Deploy now?", done: false, choices: ["Yes", "Wait for QA"], from: "agent", at: T1 });
  assert.equal(summaries[0], 'Added a todo t1 "Deploy now?" with choices "Yes" / "Wait for QA"');
  const tapped = run(board, [{ op: "todo_update", id: "t1", reply: "Wait for QA", done: true }], "owner");
  assert.deepEqual(tapped.summaries, ['Owner chose "Wait for QA" for "Deploy now?"']);
  assert.equal(tapped.board.todos[0]!.done, true);
  assert.equal(run(board, [{ op: "todo_update", id: "t1", reply: "Only staging" }], "owner").summaries[0], 'Owner answered "Deploy now?": Only staging');
  const flagged: [string[], RegExp][] = [[["one"], /1 choices, off the 2 to 4 target/], [["a", "b", "c", "d", "e"], /5 choices, off the 2 to 4 target/],
    [["a", "a"], /two choices are the same/], [["a", "x".repeat(81)], /choice 2 is 81 characters, over the 80 target/]];
  for (const [choices, flag] of flagged) {
    const asked = run(emptyBoard(T0), parseBoardOps([{ op: "todo_add", text: "q", choices }]));
    assert.deepEqual(asked.board.todos[0]!.choices, choices, "the choices are saved as given");
    assert.match(asked.summaries[0]!, flag);
  }
  throwsKind(() => parseBoardOps([{ op: "todo_add", text: "q", choices: ["a", " "] }]), "invalid");
  const three = run(emptyBoard(T0), [{ op: "todo_add", text: "a" }, { op: "todo_add", text: "b" }, { op: "todo_add", text: "c" }]).board;
  assert.equal(run(three, [{ op: "todo_add", text: "d" }, { op: "todo_add", text: "e" }]).board.todos.filter(todo => !todo.done).length, 5);
});

test("chat board: a v2 file passes; anything else throws", () => {
  const v2 = emptyBoard(T0);
  assert.equal(parseBoard(v2), v2);
  assert.throws(() => parseBoard({ v: 1, rev: 4, plan: [], todos: [], updatedAt: T0, scratchpad: "old" }), /malformed/);
  assert.throws(() => parseBoard({ v: 3, rev: 0, plan: [], todos: [], updatedAt: T0 }), /malformed/);
  assert.throws(() => parseBoard(null), /malformed/);
});

test("chat board: todos from the agent, checked and answered by the owner in plain words", () => {
  const agent = run(emptyBoard(T0), [{ op: "todo_add", text: "Approve the Email picks" }, { op: "todo_add", text: "Which email provider do we use?" }]);
  assert.deepEqual(agent.board.todos[0], { id: "t1", text: "Approve the Email picks", done: false, from: "agent", at: T1 });
  assert.equal(agent.summaries[0], 'Added a todo t1 "Approve the Email picks"');
  const owner = run(agent.board, [
    { op: "todo_update", id: "t1", done: true },
    { op: "todo_update", id: "t2", reply: "Use Resend", done: true },
    { op: "todo_add", text: "Ping me at 5" },
    { op: "todo_update", id: "t1", done: false, text: "Approve the picks" },
    { op: "todo_remove", id: "t3" },
  ], "owner");
  assert.deepEqual(owner.summaries, ['Owner checked "Approve the Email picks"', 'Owner checked "Which email provider do we use?" and answered: Use Resend',
    'Owner added a todo "Ping me at 5"', 'Owner renamed "Approve the Email picks" to "Approve the picks" and unchecked it', 'Owner removed the todo "Ping me at 5"']);
  assert.equal(owner.board.todos[1]!.reply, "Use Resend");
  assert.equal(owner.board.rev, 7);
  const cleared = run(owner.board, [{ op: "todo_update", id: "t2", reply: null }], "owner");
  assert.equal(cleared.board.todos[1]!.reply, undefined);
  assert.equal(cleared.summaries[0], 'Owner cleared the answer on "Which email provider do we use?"');
});

test("chat board: the owner may change todos, never the plan; unknown ids and bad input are refused", () => {
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
  assert.deepEqual(parseBoardOps([{ op: "plan_add", text: "a", parent: null }]), [{ op: "plan_add", text: "a" }]);
});

test("chat board: the open checklist shows this chat's target, open goals and steps in full with their marks, open todos, and counts the rest", () => {
  assert.equal(renderOpenPlan(null, "s-1"), "This chat: thread:s-1\nThe board is empty: no plan, no todos.");
  const long = "x".repeat(130);
  const { board } = run(emptyBoard(T0), [
    { op: "plan_add", text: "Goal", status: "doing" },
    { op: "plan_add", parent: "p1", text: "Step", status: "done", job: "w6" },
    { op: "plan_add", parent: "p1", text: long, job: "w7", waitFor: "run 42 goes green" },
    { op: "plan_add", text: "Shipped", status: "done" },
    { op: "todo_add", text: "Approve", choices: ["Yes", "No"] },
    { op: "todo_add", text: "Deploy?", choices: ["Go", "Not yet"], step: "p3" },
  ]);
  const answered = run(board, [{ op: "todo_update", id: "t1", done: true, reply: "Yes" }], "owner").board;
  assert.equal(renderOpenPlan(answered, "s-1", "Check-in: every 15 min"), [
    "This chat: thread:s-1", "Check-in: every 15 min", "Board rev 7. Open plan (goals and steps not done):", "  [~] p1 Goal",
    `    [ ] p3 ${long} (job w7, waits for run 42 goes green)`,
    "Owner todos open:", '  [ ] t2 Deploy? (from agent, for p3), choices: "Go" / "Not yet"',
    "Not shown: 2 done or dropped steps, 1 answered todos, 0 step notes and requirements. Read them with board.get(id), board.done(), " +
      "board.todos(all=True) in Python."].join("\n"));
  assert.doesNotMatch(renderOpenPlan(answered), /\[x\]|Approve/);
});

test("chat board: the open checklist names a linked step's thread next to its job", () => {
  const { board } = run(emptyBoard(T0), parseBoardOps([
    { op: "plan_add", text: "Goal", status: "doing" },
    { op: "plan_add", parent: "p1", text: "Port it", job: "api audit", sessionId: "01a00000-0000-7000-8000-000000000012", status: "doing" },
    { op: "plan_add", parent: "p1", text: "Verify", sessionId: "thread:01a12f09-0000-7000-8000-000000000000" },
  ]));
  const text = renderOpenPlan(board);
  assert.match(text, /\[~\] p2 Port it \(job api audit \(thread:01a00000-0000-7000-8000-000000000012\)\)$/m);
  assert.match(text, /\[ \] p3 Verify \(thread:01a12f09-0000-7000-8000-000000000000\)$/m);
});

test("board store: read is null before the first op, apply writes all ops or none, watch reports each writer's change", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "boards-"));
  const store = new BoardStore(dataDir);
  const seen: { id: string; rev: number }[] = [];
  let sawRev3!: () => void;
  const rev3 = new Promise<void>(resolve => { sawRev3 = resolve; });
  const stop = store.watch((id, board) => { seen.push({ id, rev: board.rev }); if (board.rev === 3) sawRev3(); });
  assert.equal(await store.read("chat-a"), null);
  assert.deepEqual(await store.apply("chat-a", [], "agent"), { board: null, summaries: [] });
  const first = await store.apply("chat-a", [{ op: "plan_add", text: "Goal" }, { op: "todo_add", text: "Approve" }], "agent");
  assert.equal(first.board?.rev, 2);
  assert.deepEqual(first.summaries, ['Added p1 "Goal"', 'Added a todo t1 "Approve"']);
  await assert.rejects(store.apply("chat-a", [{ op: "todo_update", id: "t1", done: true }, { op: "plan_remove", id: "p1" }], "owner"), BoardError);
  assert.equal((await store.read("chat-a"))?.todos[0]?.done, false, "a refused op leaves the file as it was");
  await writeFile(join(dataDir, "boards", "notes.txt"), "ignored");
  const checked = await store.apply("chat-a", [{ op: "todo_update", id: "t1", done: true }], "owner");
  assert.equal(checked.board?.rev, 3);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "boards", "chat-a.json"), "utf8")), checked.board);
  await assert.rejects(store.apply("../x", [{ op: "todo_add", text: "x" }], "agent"), /Not a session id/);
  // The watcher reports after its debounce and a read; a fixed 300 ms sleep missed it under load (full suite, 10-13).
  await rev3;
  stop();
  assert.deepEqual(seen.at(-1), { id: "chat-a", rev: 3 });
  assert.ok(seen.every(entry => entry.id === "chat-a"), JSON.stringify(seen));
});

test("thread state: a board event sets the chat's board", () => {
  const board = run(emptyBoard(T0), [{ op: "todo_add", text: "Approve" }]).board;
  const state = { board: null } as unknown as ThreadState;
  assert.equal(applyThreadEvent(state, { type: "board", board }).board, board);
});

test("extension: chat_board writes the chat's board under agent-chat-data-dir; a write returns the summaries and a rev line, a read the open checklist", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "board-ext-"));
  const tools = new Map<string, { promptGuidelines?: string[]; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const tool = tools.get("chat_board")!;
  assert.ok(tool.promptGuidelines?.some(line => line.includes("CTO")));
  const ctx = { sessionManager: { getSessionId: () => "s-1" } };
  const added = await tool.execute("c1", { ops: [{ op: "plan_add", text: "Goal", status: "doing" }, { op: "plan_add", parent: "p1", text: "Old", status: "done" },
    { op: "todo_add", text: "Approve" }] }, undefined, undefined, ctx);
  assert.equal(added.content[0]!.text, 'Added p1 "Goal"\nAdded p2 "Old" under p1\nAdded a todo t1 "Approve"\nBoard rev 3: 1 open steps, 1 open todos.');
  assert.doesNotMatch(added.content[0]!.text, /\[x\]|This chat/, "a write result carries no board");
  assert.equal((await new BoardStore(dataDir).read("s-1"))?.rev, 3);
  await checkInSettings(join(dataDir, "check-in-settings.json")).update("s-1", () => ({ everyMs: 15 * 60_000, pausedUntil: "forever" }));
  assert.match((await tool.execute("c2", { ops: [] }, undefined, undefined, ctx)).content[0]!.text,
    /^This chat: thread:s-1\nCheck-in: paused until the owner resumes it\nBoard rev 3\. Open plan .*\n {2}\[~\] p1 Goal\nOwner todos open:\n {2}\[ \] t1 Approve/,
    "the chat reads the owner's setting from the data dir");
  await assert.rejects(tool.execute("c3", { ops: [{ op: "plan_update", id: "p7", status: "done" }] }, undefined, undefined, ctx), /No plan item p7/);
});

test("extension: the chat tool texts stay lean", () => {
  const tools = new Map<string, { description: string; parameters: unknown }>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, getFlag: () => undefined };
  historyExtension(pi as never);
  const size = (name: string) => { const tool = tools.get(name)!; return JSON.stringify({ name, description: tool.description, parameters: tool.parameters }).length; };
  assert.ok(size("chat_board") <= 1400, `chat_board schema is ${size("chat_board")} chars; op rules live in the board skill`);
  assert.ok(size("tell_owner") <= 420, `tell_owner schema is ${size("tell_owner")} chars`);
});

import { planCounts as countPlan } from "../src/shared/chat-board.ts";
test("planCounts: every non-dropped step at any depth, and the done ones, for the sidebar line", () => {
  type Item = { id: string; text: string; status: "todo" | "doing" | "done" | "blocked" | "dropped"; children: Item[] };
  const item = (id: string, status: Item["status"], children: Item[] = []): Item => ({ id, text: id, status, children });
  assert.deepEqual(countPlan([item("p1", "doing", [item("p2", "done"), item("p3", "dropped"), item("p4", "todo", [item("p5", "done")])]), item("p6", "done")]), { done: 3, total: 5 });
  assert.deepEqual(countPlan([]), { done: 0, total: 0 });
});

test("c44: plan_update parent moves an item under its goal", () => {
  // p253 sits at the top level with a step of its own; p254 is the goal it belongs to.
  const loose = { ...emptyBoard(T0), plan: [{ id: "p253", text: "Agents send nothing outside without the owner's ok", status: "doing" as const,
    children: [{ id: "p255", text: "Gate", status: "done" as const, children: [] }] }, { id: "p254", text: "AI harness works", status: "doing" as const, children: [] }] };
  const moved = run(loose, [{ op: "plan_update", id: "p253", parent: "p254" }]);
  assert.deepEqual(moved.board.plan.map(item => item.id), ["p254"]);
  assert.deepEqual(moved.board.plan[0]!.children.map(item => [item.id, item.children.map(child => child.id)]), [["p253", ["p255"]]], "id and steps kept");
  assert.deepEqual(moved.summaries, ['Updated p253 "Agents send nothing outside without the owner\'s ok": moved it under p254']);
  throwsKind(() => run(moved.board, [{ op: "plan_update", id: "p253", parent: "p255" }]), "invalid");
  throwsKind(() => run(moved.board, [{ op: "plan_update", id: "p253", parent: "p253" }]), "invalid");

  const back = run(moved.board, [{ op: "plan_update", id: "p253", parent: null }]);
  assert.deepEqual(back.board.plan.map(item => item.id), ["p254", "p253"]);
  assert.deepEqual(back.summaries, ['Updated p253 "Agents send nothing outside without the owner\'s ok": moved it to the top level']);

  // An open step moved under a finished goal reopens it.
  const two = run(emptyBoard(T0), [{ op: "plan_add", text: "Area" }, { op: "plan_add", parent: "p1", text: "Step", status: "doing" }, { op: "plan_add", text: "Shipped area", status: "done" }]).board;
  const open = run(two, [{ op: "plan_update", id: "p2", parent: "p3" }]);
  assert.equal(open.board.plan.find(item => item.id === "p3")!.status, "todo");
  assert.match(open.summaries[0]!, /moved it under p3, reopened p3$/);
});
