// Guards the 10-18 Mac reconnect on release-1bfb0bc: a thread `board` event of 456 KB for chat 01a1164b came 3.6 s after the new socket, and
// made that run's first 6 s 683 KB against a median of 183 KB, because the feed sent the whole board on every change. On the live box a change
// touched one item in most writes. A page that asks for deltas now gets the items that changed, keyed by id, after the board rev it holds.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { BoardFollower, boardKey, type BoardDelta } from "../src/shared/board-delta.ts";
import type { ChatBoard, PlanItem, ThreadEvent } from "../src/shared/types.ts";

const ID = "01a1164b-0000-7000-8000-0000000000bb";

function bigBoard(): ChatBoard {
  const step = (id: number, children: PlanItem[] = []): PlanItem => ({ id: `p${id}`, text: `step ${id} ` + "x".repeat(300), status: "todo", note: "n".repeat(500), children });
  const plan = Array.from({ length: 40 }, (_, goal) => step(goal * 10, Array.from({ length: 9 }, (_, index) => step(goal * 10 + index + 1))));
  const todos = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, text: "ask " + "y".repeat(200), done: false, from: "agent" as const, at: "2026-10-18T00:00:00Z" }));
  return { v: 2, rev: 7, updatedAt: "2026-10-18T10:00:07Z", plan, todos, lastIds: { p: 400, t: 30 } };
}

/** A board file as 01a1164b's was on 10-18: with the v1 `scratch` list, 92 KB that nothing reads, beside the fields `ChatBoard` names. */
function withScratch(board: ChatBoard): ChatBoard {
  return { ...board, scratch: Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, text: "z".repeat(800), links: [], children: [] })) } as ChatBoard;
}

/** `board` with plan item `id` changed by `change`, one rev on. */
function changed(board: ChatBoard, id: string, change: Partial<PlanItem>): ChatBoard {
  const walk = (items: PlanItem[]): PlanItem[] => items.map(item => item.id === id ? { ...item, ...change } : { ...item, children: walk(item.children) });
  return { ...board, plan: walk(board.plan), rev: board.rev + 1, updatedAt: new Date(Date.parse(board.updatedAt) + 1000).toISOString() };
}

async function hub(board: () => Promise<ChatBoard>): Promise<ThreadHub> {
  const dir = await mkdtemp(join(tmpdir(), "board-delta-"));
  const file = join(dir, ID + ".jsonl");
  const stamp = Date.parse("2026-10-18T00:00:01.000Z");
  await writeFile(file, [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T00:00:00.000Z", cwd: dir }),
    JSON.stringify({ type: "message", id: "00000001", parentId: null, timestamp: new Date(stamp).toISOString(), message: { role: "user", content: "hi", timestamp: stamp } })].join("\n") + "\n");
  const catalog = { summary: async (id: string) => ({ sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: 1 }), hostOf: () => null } as unknown as Catalog;
  return new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), board as never);
}

const boards = (events: ThreadEvent[]) => events.filter((event): event is Extract<ThreadEvent, { type: "board" }> | BoardDelta => event.type === "board" || event.type === "board-delta");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test("a change to one board item sends that item only, and the page ends with the server's board", async () => {
  const start = withScratch(bigBoard());
  const threads = await hub(async () => start);
  const events: ThreadEvent[] = [];
  await threads.subscribe(ID, event => events.push(event), false, undefined, true);
  await settle();
  assert.deepEqual(boards(events).map(event => event.type), ["board"], "the first board goes out whole");
  assert.equal("scratch" in (boards(events)[0] as Extract<ThreadEvent, { type: "board" }>).board, false, "without the fields no page reads");
  let page: ChatBoard | null = null;
  const follower = new BoardFollower(async () => assert.fail("no gap"), board => { page = board; });
  follower.take(boards(events)[0] as Extract<ThreadEvent, { type: "board" }>);

  const next = changed(start, "p53", { note: "done on release-1bfb0bc", status: "done" });
  const { scratch: _scratch, ...shown } = next as ChatBoard & { scratch?: unknown };
  events.length = 0;
  threads.setBoard(ID, next);
  const [delta] = boards(events);
  assert.equal(delta?.type, "board-delta");
  assert.ok(delta?.type === "board-delta");
  assert.deepEqual(delta.plan.map(item => item.id), ["p53"]);
  assert.deepEqual([delta.todos, delta.roots, delta.todoIds], [[], undefined, undefined]);
  assert.ok(bytes(delta) * 100 < bytes(next), `${bytes(delta)} B for one item of a ${bytes(next)} B board`);
  follower.take(delta);
  assert.deepEqual(page, shown);
  await threads.close();
});

test("a missed board delta makes the page ask for the whole board once and end equal to the server's board", async () => {
  const start = bigBoard();
  const threads = await hub(async () => start);
  const events: ThreadEvent[] = [];
  await threads.subscribe(ID, event => events.push(event), false, undefined, true);
  await settle();
  const one = changed(start, "p1", { note: "one" });
  const two = changed(one, "p2", { text: "two" });
  const three = { ...changed(two, "p3", { status: "done" }), todos: [...two.todos.slice(1), { id: "t31", text: "new ask", done: false, from: "agent" as const, at: "2026-10-18T10:01:00Z" }] };
  for (const board of [one, two, three]) threads.setBoard(ID, board);
  const [first, gone, late, last] = boards(events);
  assert.equal(first?.type, "board");
  let page: ChatBoard | null = null;
  let asks = 0;
  let answer!: (board: ChatBoard) => void;
  const follower = new BoardFollower(() => { asks++; return new Promise(resolve => { answer = resolve; }); }, board => { page = board; });
  follower.take(first as Extract<ThreadEvent, { type: "board" }>);
  assert.equal(gone?.type, "board-delta", "the page misses this one");
  follower.take(late as BoardDelta);
  follower.take(last as BoardDelta);
  assert.equal(asks, 1, "one ask for the whole board while deltas keep coming");
  answer(two);
  await settle();
  assert.equal(asks, 1);
  assert.deepEqual(page, three);
  assert.equal(follower.key, boardKey(three));
  await threads.close();
});

test("a reconnect that names the board it holds gets no board bytes, also while the thread opens again, and an older board gets one delta", async () => {
  const start = bigBoard();
  // A thread the server does not hold (a restart, an eviction) reads its board after the feed's first frames.
  const cold = await hub(() => new Promise(resolve => setTimeout(() => resolve(start), 30)));
  const quiet: ThreadEvent[] = [];
  await cold.subscribe(ID, event => quiet.push(event), false, { board: boardKey(start) }, true);
  await settle();
  assert.deepEqual(boards(quiet), [], "a page with the current board gets none");

  const next = changed(start, "p11", { note: "moved on" });
  cold.setBoard(ID, next);
  const behind: ThreadEvent[] = [];
  await cold.subscribe(ID, event => behind.push(event), false, { board: boardKey(start) }, true);
  const [delta] = boards(behind);
  assert.ok(delta?.type === "board-delta");
  assert.deepEqual(delta.plan.map(item => item.id), ["p11"]);
  const current: ThreadEvent[] = [];
  await cold.subscribe(ID, event => current.push(event), false, { board: boardKey(next) }, true);
  assert.deepEqual(boards(current), []);
  await cold.close();
});
