import assert from "node:assert/strict";
import { test } from "node:test";
import { boardActionText, countItems, focusPlan, groupTodos, ID_COLORS, idClass, idIndex, isBoardAction, isEmptyBoard, isFinished, linkChip, linkLabel, offeredLink, openAgentTodos, parentIds, planProgress, planTotals, ROOT, shortTitle, treeRows, type TreeRow } from "../src/client/board.ts";
import type { ChatBoard, OwnerTodo, PlanItem, ScratchItem } from "../src/shared/types.ts";

const item = (id: string, status: PlanItem["status"], children: PlanItem[] = []): PlanItem => ({ id, text: id, status, children });
const note = (id: string, children: ScratchItem[] = []): ScratchItem => ({ id, text: id, links: [], at: "2026-10-06T00:00:00Z", children });
const line = (row: TreeRow<{ id: string }>): string => row.kind === "item" ? `${"  ".repeat(row.depth)}${row.item.id}` : `${"  ".repeat(row.depth)}[${row.shown ? "hide" : "show"} done ${row.count} of ${row.parent}]`;

test("treeRows: every parent starts folded; an opened parent shows its children; done and dropped steps hide until Show done is on for their parent", () => {
  const plan = [
    item("p1", "doing", [item("p2", "done"), item("p3", "doing", [item("p4", "done"), item("p5", "todo", [item("p6", "todo")])]), item("p7", "dropped")]),
    item("p8", "done", [item("p9", "done")]),
    item("p10", "todo"),
  ];
  const open = new Set<string>();
  const shown = new Set<string>();
  const rows = () => treeRows(plan, { open: id => open.has(id), showDone: parent => shown.has(parent) }, isFinished).map(line);
  assert.deepEqual(rows(), ["p1", "p10", `[show done 1 of ${ROOT}]`], "folded by default, p8 hidden as done");
  open.add("p1");
  assert.deepEqual(rows(), ["p1", "  p3", "  [show done 2 of p1]", "p10", `[show done 1 of ${ROOT}]`], "p2 and p7 hide behind their parent's toggle");
  open.add("p3").add("p5");
  assert.deepEqual(rows(), ["p1", "  p3", "    p5", "      p6", "    [show done 1 of p3]", "  [show done 2 of p1]", "p10", `[show done 1 of ${ROOT}]`]);
  shown.add("p1");
  assert.deepEqual(rows(), ["p1", "  p2", "  p3", "    p5", "      p6", "    [show done 1 of p3]", "  p7", "  [hide done 2 of p1]", "p10", `[show done 1 of ${ROOT}]`]);
  shown.add(ROOT);
  open.add("p8");
  assert.deepEqual(rows().slice(-4), ["p8", "  [show done 1 of p8]", "p10", `[hide done 1 of ${ROOT}]`], "a shown done goal still folds and hides its own done steps");
  assert.deepEqual(treeRows([], { open: () => true, showDone: () => true }, isFinished), []);
});

test("treeRows over notes never hides anything; countItems and planTotals count the whole tree", () => {
  const notes = [note("s1", [note("s2", [note("s3")])]), note("s4")];
  const open = new Set(["s1"]);
  assert.deepEqual(treeRows(notes, { open: id => open.has(id), showDone: () => false }).map(line), ["s1", "  s2", "s4"]);
  assert.equal(countItems(notes), 4);
  assert.deepEqual(planTotals([item("p1", "done", [item("p2", "dropped"), item("p3", "todo")]), item("p4", "done")]), { done: 2, total: 3 });
  assert.deepEqual(planTotals([]), { done: 0, total: 0 });
});

test("idIndex is one of ten palette slots, the same for a chat and item on every call, and differs across items of one chat", () => {
  assert.equal(ID_COLORS, 10);
  const first = idIndex("chat-a", "p1");
  assert.equal(idIndex("chat-a", "p1"), first);
  assert.ok(Number.isInteger(first) && first >= 0 && first < ID_COLORS);
  assert.equal(idClass("chat-a", "p1"), `id-${first}`);
  const slots = new Set(Array.from({ length: 30 }, (_, index) => idIndex("chat-a", `p${index + 1}`)));
  assert.ok(slots.size >= 6, `30 ids of one chat spread over ${slots.size} colors`);
  assert.ok(Array.from({ length: 30 }, (_, index) => idIndex(`chat-${index}`, "p1")).some(slot => slot !== first), "the chat id is part of the hash");
});

test("planProgress counts every step below a goal except dropped ones", () => {
  const goal = item("p1", "doing", [
    item("p2", "done"),
    item("p3", "doing", [item("p4", "done"), item("p5", "todo"), item("p6", "dropped")]),
    item("p7", "blocked"),
  ]);
  assert.deepEqual(planProgress(goal), { done: 2, total: 5 });
  assert.equal(planProgress(item("p8", "todo")), null);
});

test("groupTodos splits open from done, newest first in each", () => {
  const todo = (id: string, done: boolean, at: string): OwnerTodo => ({ id, text: id, done, from: "agent", at });
  const groups = groupTodos([todo("t1", true, "2026-10-06T01:00:00Z"), todo("t2", false, "2026-10-06T02:00:00Z"), todo("t3", false, "2026-10-06T03:00:00Z"), todo("t4", true, "2026-10-06T04:00:00Z")]);
  assert.deepEqual(groups.open.map(todo => todo.id), ["t3", "t2"]);
  assert.deepEqual(groups.done.map(todo => todo.id), ["t4", "t1"]);
});

test("openAgentTodos counts only open asks from the agent, and an empty board is one with nothing on it", () => {
  const board: ChatBoard = { v: 2, rev: 3, plan: [], scratch: [], updatedAt: "2026-10-06T00:00:00Z", todos: [
    { id: "t1", text: "a", done: false, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t2", text: "b", done: true, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t3", text: "c", done: false, from: "owner", at: "2026-10-06T00:00:00Z" },
  ] };
  assert.equal(openAgentTodos(board), 1);
  assert.equal(openAgentTodos(null), 0);
  assert.equal(isEmptyBoard(null), true);
  assert.equal(isEmptyBoard({ ...board, todos: [] }), true);
  assert.equal(isEmptyBoard({ ...board, todos: [], scratch: [{ id: "s1", text: "note", links: [], at: "2026-10-06T00:00:00Z", children: [] }] }), false);
  assert.equal(isEmptyBoard(board), false);
});

test("a [board] user message is an owner action line", () => {
  assert.equal(isBoardAction('[board] Owner checked "Approve the Email picks"'), true);
  assert.equal(isBoardAction("[boards] no"), false);
  assert.equal(boardActionText('[board] Owner checked "Approve the Email picks"'), 'Owner checked "Approve the Email picks"');
});

test("linkChip names the kind and icon of a link, and a target the page cannot open is a broken chip", () => {
  assert.deepEqual(linkChip({ label: "ux-email", target: "job:ux-email" }), { kind: "job", icon: "bolt", label: "ux-email", target: { kind: "job", name: "ux-email" } });
  assert.equal(linkChip({ label: "", target: "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759780000000" }).label, "message in 01a112e2");
  assert.equal(linkChip({ label: "Audit", target: "wiki:sessions/2026/10/06/audit" }).icon, "book");
  assert.equal(linkChip({ label: "", target: "file:/Users/me/report.md" }).label, "report.md");
  assert.equal(linkChip({ label: "", target: "https://www.example.com/docs/page/" }).label, "example.com/docs/page");
  assert.deepEqual(linkChip({ label: "old", target: "ftp://x" }), { kind: "broken", icon: "link", label: "old", target: null });
});

test("linkLabel falls back to the raw target when it does not parse", () => {
  assert.equal(linkLabel("nothing"), "nothing");
});

test("offeredLink takes the last word of a draft that is a link target and leaves the rest as the note", () => {
  assert.deepEqual(offeredLink("see http://127.0.0.1:5182/x/#01a112e2-f720-75db-b51a-84cfbdbcffa0@1759780000000 later"),
    { text: "see later", target: "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759780000000" });
  assert.deepEqual(offeredLink("/Users/me/notes.md"), { text: "", target: "file:/Users/me/notes.md" });
  assert.deepEqual(offeredLink("http://localhost:5176/page/sessions/2026/10/06/audit"), { text: "", target: "wiki:sessions/2026/10/06/audit" });
  assert.equal(offeredLink("plain words only"), null);
});

test("parentIds and focusPlan: collapse-all folds every parent; a focus unfolds its ancestors, shows done when it or one above it is finished, and names its section", () => {
  const plan = [item("p1", "doing", [item("p2", "done", [item("p3", "done")]), item("p4", "todo", [item("p5", "todo")])]), item("p6", "dropped", [item("p7", "todo")])];
  const scratch = [note("s1", [note("s2", [note("s3")])]), note("s4")];
  const board: ChatBoard = { v: 2, rev: 1, plan, scratch, todos: [], updatedAt: "" };
  assert.deepEqual(parentIds(plan), ["p1", "p2", "p4", "p6"]);
  assert.deepEqual(parentIds(scratch), ["s1", "s2"]);
  assert.deepEqual(focusPlan(board, "p5"), { section: "plan", unfold: ["p1", "p4"], showDone: false });
  assert.deepEqual(focusPlan(board, "p3"), { section: "plan", unfold: ["p1", "p2"], showDone: true }, "a done step shows the done items");
  assert.deepEqual(focusPlan(board, "p7"), { section: "plan", unfold: ["p6"], showDone: true }, "an open step under a dropped goal needs the done items shown");
  assert.deepEqual(focusPlan(board, "p1"), { section: "plan", unfold: [], showDone: false });
  assert.deepEqual(focusPlan(board, "s3"), { section: "notes", unfold: ["s1", "s2"], showDone: false });
  assert.equal(focusPlan(board, "p99"), null);
  assert.equal(shortTitle("short"), "short");
  assert.equal(shortTitle("a".repeat(60)), "a".repeat(60));
  assert.equal(shortTitle("a".repeat(61)), "a".repeat(59) + "\u2026");
});
