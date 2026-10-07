import assert from "node:assert/strict";
import { test } from "node:test";
import { boardActionText, groupTodos, isBoardAction, isEmptyBoard, linkChip, linkLabel, offeredLink, openAgentTodos, planProgress } from "../src/client/board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const item = (id: string, status: PlanItem["status"], children: PlanItem[] = []): PlanItem => ({ id, text: id, status, children });

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
  assert.equal(isEmptyBoard({ ...board, todos: [], scratch: [{ id: "s1", text: "note", links: [], at: "2026-10-06T00:00:00Z" }] }), false);
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
