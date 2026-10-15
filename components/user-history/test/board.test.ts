import assert from "node:assert/strict";
import { test } from "node:test";
import { boardActionText, firstSentence, focusPlan, NOTE_WORDS, QUEUED_TEXT, queueText, rowParts, groupTodos, ID_COLORS, idClass, idIndex, isBoardAction, isEmptyBoard, isFinished, linkChip, linkLabel, openAgentTodos, parentIds, planProgress, planTotals, planWait, ROOT, shortTitle, stepAgent, stepAgentTitle, treeRows, type TreeRow } from "../src/client/board.ts";
import type { ChatAgent, ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const item = (id: string, status: PlanItem["status"], children: PlanItem[] = []): PlanItem => ({ id, text: id, status, children });
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

test("planTotals counts the whole tree", () => {
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
  const board: ChatBoard = { v: 2, rev: 3, plan: [], updatedAt: "2026-10-06T00:00:00Z", todos: [
    { id: "t1", text: "a", done: false, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t2", text: "b", done: true, from: "agent", at: "2026-10-06T00:00:00Z" },
    { id: "t3", text: "c", done: false, from: "owner", at: "2026-10-06T00:00:00Z" },
  ] };
  assert.equal(openAgentTodos(board), 1);
  assert.equal(openAgentTodos(null), 0);
  assert.equal(isEmptyBoard(null), true);
  assert.equal(isEmptyBoard({ ...board, todos: [] }), true);
  assert.equal(isEmptyBoard(board), false);
});

test("a [board] user message is an owner action line", () => {
  assert.equal(isBoardAction('[board] Owner checked "Approve the Email picks"'), true);
  assert.equal(isBoardAction("[boards] no"), false);
  assert.equal(boardActionText('[board] Owner checked "Approve the Email picks"'), 'Owner checked "Approve the Email picks"');
});

test("linkChip names the kind and icon of a link, and a target the page cannot open is a broken chip", () => {
  assert.deepEqual(linkChip({ label: "ux-email", target: "job:ux-email" }), { kind: "job", icon: "briefcase", label: "ux-email", target: { kind: "job", name: "ux-email" } });
  assert.equal(linkChip({ label: "", target: "thread:01a112e2-f720-75db-b51a-84cfbdbcffa0@1759780000000" }).label, "message in 01a112e2");
  assert.equal(linkChip({ label: "Audit", target: "wiki:sessions/2026/10/06/audit" }).icon, "page");
  assert.equal(linkChip({ label: "", target: "file:/Users/me/report.md" }).label, "report.md");
  assert.equal(linkChip({ label: "", target: "https://www.example.com/docs/page/" }).label, "example.com/docs/page");
  assert.deepEqual(linkChip({ label: "old", target: "ftp://x" }), { kind: "broken", icon: "link", label: "old", target: null });
});

test("linkLabel falls back to the raw target when it does not parse", () => {
  assert.equal(linkLabel("nothing"), "nothing");
});

test("parentIds and focusPlan: collapse-all folds every parent; a focus unfolds its ancestors and shows done when it or one above it is finished", () => {
  const plan = [item("p1", "doing", [item("p2", "done", [item("p3", "done")]), item("p4", "todo", [item("p5", "todo")])]), item("p6", "dropped", [item("p7", "todo")])];
  const board: ChatBoard = { v: 2, rev: 1, plan, todos: [], updatedAt: "" };
  assert.deepEqual(parentIds(plan), ["p1", "p2", "p4", "p6"]);
  assert.deepEqual(focusPlan(board, "p5"), { unfold: ["p1", "p4"], showDone: false });
  assert.deepEqual(focusPlan(board, "p3"), { unfold: ["p1", "p2"], showDone: true }, "a done step shows the done items");
  assert.deepEqual(focusPlan(board, "p7"), { unfold: ["p6"], showDone: true }, "an open step under a dropped goal needs the done items shown");
  assert.deepEqual(focusPlan(board, "p1"), { unfold: [], showDone: false });
  assert.equal(focusPlan(board, "p99"), null);
  assert.equal(shortTitle("short"), "short");
  assert.equal(shortTitle("a".repeat(60)), "a".repeat(60));
  assert.equal(shortTitle("a".repeat(61)), "a".repeat(59) + "\u2026");
});

test("planWait: nothing for a plain step; a local time for waitUntil with the year only when it differs; the text for waitFor; both joined", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const local = (iso: string, year: boolean) => new Date(iso).toLocaleString(undefined, { ...(year ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  assert.equal(planWait(item("p1", "todo"), now), null);
  assert.equal(planWait({ ...item("p1", "todo"), waitFor: " the owner's Slack click " }, now), "waits for the owner's Slack click");
  assert.equal(planWait({ ...item("p1", "todo"), waitUntil: "2026-10-09T05:30:00Z" }, now), `waits until ${local("2026-10-09T05:30:00Z", false)}`);
  assert.equal(planWait({ ...item("p1", "todo"), waitUntil: "2027-01-02T05:30:00Z" }, now), `waits until ${local("2027-01-02T05:30:00Z", true)}`);
  assert.equal(planWait({ ...item("p1", "todo"), waitUntil: "not a time", waitFor: "" }, now), null);
  assert.equal(planWait({ ...item("p1", "todo"), waitUntil: "2026-10-09T05:30:00Z", waitFor: "land 25" }, now), `waits for land 25 until ${local("2026-10-09T05:30:00Z", false)}`);
});

test("rowParts: in the panel a goal shows only its progress and a step its agent and wait, never a note or requirements; the plan view shows notes and requirements (owner 10-16)", () => {
  const goal = { children: [{}] };
  const step = { children: [] };
  assert.deepEqual(rowParts(goal, "panel"), { progress: true, agent: false, wait: false, note: false, requirements: false });
  assert.deepEqual(rowParts(step, "panel"), { progress: false, agent: true, wait: true, note: false, requirements: false });
  assert.deepEqual(rowParts(goal, "view"), { progress: true, agent: true, wait: false, note: true, requirements: true });
  assert.deepEqual(rowParts(step, "view"), { progress: false, agent: true, wait: false, note: true, requirements: true });
});

test("firstSentence: the note's first sentence or first line, past abbreviations and a leading list number; a long sentence keeps 25 words and an ellipsis", () => {
  assert.deepEqual(firstSentence("Landed on staging. CI run 1234 green at 3f2a9c1, stack below."), { text: "Landed on staging.", cut: true });
  assert.deepEqual(firstSentence("  One sentence only.  "), { text: "One sentence only.", cut: false });
  assert.deepEqual(firstSentence("No period at all"), { text: "No period at all", cut: false });
  assert.deepEqual(firstSentence("Waits on the owner, e.g. a Slack click. Then it ships."), { text: "Waits on the owner, e.g. a Slack click.", cut: true });
  assert.deepEqual(firstSentence("1. Fix the chart. 2. Ship it."), { text: "1. Fix the chart.", cut: true });
  assert.deepEqual(firstSentence("Is it live? Yes."), { text: "Is it live?", cut: true });
  assert.deepEqual(firstSentence("Reads board.ts and v1.2 fine\nError: stack at line 4"), { text: "Reads board.ts and v1.2 fine", cut: true });
  const long = Array.from({ length: 40 }, (_, index) => `w${index}`).join(" ") + ".";
  const cut = firstSentence(long);
  assert.equal(cut.text, Array.from({ length: NOTE_WORDS }, (_, index) => `w${index}`).join(" ") + "\u2026");
  assert.equal(cut.cut, true);
  assert.equal(NOTE_WORDS, 25);
  assert.deepEqual(firstSentence(""), { text: "", cut: false });
});

test("a queued agent reads 'waiting for a turn'; its place and wait stay in the tooltip", () => {
  const now = Date.parse("2026-10-16T01:00:00Z");
  const agent: ChatAgent = { key: "child:sub-1", sessionId: "s-1", name: "ops-fix", job: "ops-fix", sender: "ops-fix", link: "subagent", state: "working", steps: ["p2"], queued: { position: 74, total: 83, since: now - 3 * 60_000 } };
  assert.equal(QUEUED_TEXT, "waiting for a turn");
  const queued = queueText(agent.queued!, now);
  assert.equal(queued, "Queued 74 of 83, waiting 3 min");
  assert.equal(stepAgentTitle(stepAgent({ ...item("p2", "doing") }, [agent])!, "ops-fix", queued), "ops-fix · Queued 74 of 83, waiting 3 min · s-1");
});

test("stepAgent: the Agents row that owns the step, else the stored session of a deleted job, else the owner as written, else none", () => {
  const sid = "01a00000-0000-7000-8000-000000000011";
  const agent: ChatAgent = { key: "child:sub-1", sessionId: sid, childId: "sub-1", name: "plan-agent-data", job: "plan-agent-data", sender: "plan-agent-data", link: "subagent", state: "working", steps: ["p2", "p3"] };
  const step = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({ ...item(id, "doing"), ...extra });
  const found = stepAgent(step("p3", { job: "plan-agent-data", sessionId: sid }), [agent]);
  assert.equal(found?.agent, agent);
  assert.deepEqual({ ...found, agent: undefined }, { name: "plan-agent-data", state: "working", sessionId: sid, agent: undefined });
  assert.equal(stepAgentTitle(found!), `plan-agent-data · Working · ${sid}`);
  assert.deepEqual(stepAgent(step("p9", { job: "old-job", sessionId: sid }), [agent]), { name: "old-job", state: null, sessionId: sid }, "a deleted job keeps its name and opens its thread");
  assert.deepEqual(stepAgent(step("p9", { job: `thread:${sid}` }), []), { name: "01a00000", state: null, sessionId: sid }, "a thread: owner is a session");
  assert.deepEqual(stepAgent(step("p9", { sessionId: sid }), []), { name: "01a00000", state: null, sessionId: sid });
  assert.deepEqual(stepAgent(step("p9", { job: "some-job" }), []), { name: "some-job", state: null, job: "some-job" }, "an old board step keeps its owner link");
  assert.equal(stepAgentTitle(stepAgent(step("p9", { job: "some-job" }), [])!), "some-job");
  assert.equal(stepAgent(step("p9"), [agent]), null);
});
