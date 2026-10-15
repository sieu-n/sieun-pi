import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatAgents, stepSessions } from "../src/chat-agents.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { jobFacts } from "../src/checkin-steps.ts";
import { applyBoardOp, nextIds, parseBoard, parseBoardOps } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, ChildAgent, PlanItem, SessionRow } from "../src/shared/types.ts";

const T0 = "2026-10-12T00:00:00.000Z";
const NOW = Date.parse("2026-10-12T07:00:00Z");
const ID = "01a00000-0000-7000-8000-000000000011";
const OTHER = "01a00000-0000-7000-8000-000000000013";
const empty = (): ChatBoard => ({ v: 2, rev: 0, plan: [], todos: [], updatedAt: T0 });
const run = (board: ChatBoard, ops: unknown[]): { board: ChatBoard; summaries: string[] } => {
  const summaries: string[] = [];
  for (const op of parseBoardOps(ops) as BoardOp[]) { const next = applyBoardOp(board, op, "agent", T0, nextIds(board)); board = next.board; summaries.push(next.summary); }
  return { board, summaries };
};
const step = (over: Partial<PlanItem> & { id: string }): PlanItem => ({ text: over.id, status: "doing", children: [], ...over });
const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false, subagentsRunning: 0,
  unread: false, tags: [], priority: 0, progress: "none", ...over });
const sources = (plan: PlanItem[], over: Partial<Parameters<typeof chatAgents>[0]> = {}) => ({ self: { id: "chat", name: "VP" }, children: [], childSessions: [],
  board: { ...empty(), plan }, roots: [], messages: [], rows: [], now: NOW, ...over });

test("plan sessions: a thread job, a pasted chat URL or a given sessionId stores the session id; a job name stores none", () => {
  const { board } = run(empty(), [
    { op: "plan_add", text: "by thread", job: `thread:${ID}` },
    { op: "plan_add", text: "by url", job: `http://localhost:5182/#${ID}@1760000000000` },
    { op: "plan_add", text: "by name", job: "index-job" },
    { op: "plan_add", text: "by both", job: "index-job", sessionId: `thread:${OTHER}` },
  ]);
  assert.deepEqual(board.plan.map(item => [item.job, item.sessionId]), [[ID, ID], [ID, ID], ["index-job", undefined], ["index-job", OTHER]]);
  assert.throws(() => parseBoardOps([{ op: "plan_add", text: "x", sessionId: "not an id!" }]), /sessionId must be/);
});

test("plan sessions: plan_update links by name or id, keeps the id while the job stays, a new job drops it, null unlinks both", () => {
  let { board } = run(empty(), [{ op: "plan_add", text: "s", job: "index-job", sessionId: ID }]);
  ({ board } = run(board, [{ op: "plan_update", id: "p1", status: "done" }]));
  assert.equal(board.plan[0]!.sessionId, ID, "an unrelated change keeps the id");
  ({ board } = run(board, [{ op: "plan_update", id: "p1", job: "index-job" }]));
  assert.equal(board.plan[0]!.sessionId, ID, "the same job keeps the id");
  let summaries: string[];
  ({ board, summaries } = run(board, [{ op: "plan_update", id: "p1", job: "other-job" }]));
  assert.deepEqual([board.plan[0]!.job, board.plan[0]!.sessionId, summaries[0]], ["other-job", undefined, 'Updated p1 "s": linked job other-job']);
  ({ board, summaries } = run(board, [{ op: "plan_update", id: "p1", job: `thread:${OTHER}` }]));
  assert.deepEqual([board.plan[0]!.job, board.plan[0]!.sessionId, summaries[0]], [OTHER, OTHER, `Updated p1 "s": linked job ${OTHER}`]);
  ({ board, summaries } = run(board, [{ op: "plan_update", id: "p1", job: "index-job", sessionId: ID }]));
  assert.equal(summaries[0], `Updated p1 "s": linked job index-job (thread:${ID})`);
  ({ board, summaries } = run(board, [{ op: "plan_update", id: "p1", job: null }]));
  assert.deepEqual([board.plan[0]!.job, board.plan[0]!.sessionId, summaries[0]], [undefined, undefined, 'Updated p1 "s": unlinked its job']);
});

test("plan sessions: plan_set keeps a kept item's id while its job stays, and drops it with a new job", () => {
  const { board: start } = run(empty(), [{ op: "plan_add", text: "a", job: "index-job", sessionId: ID }, { op: "plan_add", text: "b", job: "w1", sessionId: OTHER }]);
  const { board } = run(start, [{ op: "plan_set", items: [{ id: "p1", text: "a", job: "index-job" }, { id: "p2", text: "b", job: "w2" }] }]);
  assert.deepEqual(board.plan.map(item => item.sessionId), [ID, undefined]);
});

test("plan sessions: an old board with no sessionId loads unchanged", () => {
  const old = { v: 2, rev: 3, plan: [{ id: "p1", text: "a", status: "doing", job: "index-job", children: [] }], todos: [], updatedAt: T0 };
  assert.deepEqual(parseBoard(structuredClone(old)), old);
});

test("plan sessions: the server stores a named job's session id once, quietly, and only while the step still names that job", async () => {
  const store = new BoardStore(await mkdtemp(join(tmpdir(), "plan-sessions-")));
  await store.apply("chat", [{ op: "plan_add", text: "a", job: "index-job" }, { op: "plan_add", text: "b", job: "w1" }], "agent");
  const before = (await store.read("chat"))!;
  const children: ChildAgent[] = [{ id: "c1", label: "task", sessionName: "index-job", status: "running" }];
  const agents = chatAgents(sources(before.plan, { children, childSessions: [{ sessionId: ID, childId: "c1", name: "index-job", running: true, failed: false }] }));
  const links = stepSessions(before, agents);
  assert.deepEqual([...links], [["p1", { job: "index-job", sessionId: ID }]]);
  await store.linkSessions("chat", links);
  const after = (await store.read("chat"))!;
  assert.equal(after.plan[0]!.sessionId, ID);
  assert.equal(after.rev, before.rev + 1);
  const file = join(store.dir, "chat.json");
  const text = await readFile(file, "utf8");
  await store.linkSessions("chat", links);
  assert.equal(await readFile(file, "utf8"), text, "a second pass writes nothing");
  assert.equal(stepSessions(after, chatAgents(sources(after.plan, { children }))).size, 0);
  await store.linkSessions("chat", new Map([["p2", { job: "renamed", sessionId: OTHER }]]));
  assert.equal((await store.read("chat"))!.plan[1]!.sessionId, undefined, "a step whose job changed meanwhile is left alone");
});

test("plan sessions: a deleted job's step still maps to an agent row by its session id; a renamed thread keeps its steps", () => {
  const agents = chatAgents(sources([step({ id: "p1", job: "index-job", sessionId: ID, status: "done" }), step({ id: "p2", job: "old name", sessionId: OTHER })],
    { rows: [{ row: row({ id: OTHER, name: "new name", working: true }) }] }));
  const gone = agents.find(agent => agent.steps.includes("p1"));
  assert.deepEqual(gone && { key: gone.key, sessionId: gone.sessionId, name: gone.name, job: gone.job, state: gone.state, link: gone.link },
    { key: `thread:${ID}`, sessionId: ID, name: "index job", job: `session:${ID}`, state: "done", link: "step" });
  const renamed = agents.find(agent => agent.steps.includes("p2"));
  assert.deepEqual(renamed && [renamed.sessionId, renamed.name, renamed.state], [OTHER, "new name", "working"]);
  const facts = jobFacts([], { ...empty(), plan: [step({ id: "p2", job: "old name", sessionId: OTHER })] }, [row({ id: OTHER, name: "new name", working: true })], "chat");
  assert.deepEqual(facts.map(fact => [fact.key, fact.item?.id]), [[`thread:${OTHER}`, "p2"]]);
});

test("plan sessions: a live child still owns its steps by name and by session id; the chat's own steps are no agent", () => {
  const children: ChildAgent[] = [{ id: "c1", label: "task", sessionName: "index-job", status: "done" }];
  const agents = chatAgents(sources([step({ id: "p1", job: "index-job" }), step({ id: "p2", job: "index-job", sessionId: ID }), step({ id: "p3", job: "chat" }),
    step({ id: "p4", sessionId: "chat" })], { children, childSessions: [{ sessionId: ID, childId: "c1", name: "index-job", running: false, failed: false }] }));
  assert.deepEqual(agents.map(agent => [agent.key, agent.steps]), [["child:c1", ["p1", "p2"]]]);
});
