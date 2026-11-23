/**
 * A board change reaches each open page as what changed from the board the page holds, and as the whole board only when the page holds
 * another one or none the server knows of. On 11-23 every board event carried the whole board, 219 KB of JSON for agent factory's, to
 * every open tab on each change (~/work/p231-slow-calls/p231-board-event).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-event-delta.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import type { AgentSummary, BoardView, ChatBoard, LiveEvent } from "../../web/src/lib/api/types.ts";
import { applyBoardDelta, boardKey, boardsParam } from "../../web/src/lib/api/shared/board-delta.ts";
import { start, until, type Running } from "./helpers.ts";

type BoardEvent = Extract<LiveEvent, { type: "board" }>;

let s: Running;
let agent: AgentSummary;
const sockets: WebSocket[] = [];

before(async () => {
  s = await start({ wordMs: 0 });
  agent = (await s.send("POST", "/api/agents", { name: "board event" })).body;
  await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
});
after(async () => {
  for (const socket of sockets) socket.close();
  await s.close();
});

/** A page's socket that names the boards it holds, as live.svelte.ts does, and the board events it gets for the agent with their sizes. */
async function page(held: Map<string, string>): Promise<{ next(): Promise<{ event: BoardEvent; bytes: number }>; read(board: ChatBoard): Promise<void> }> {
  const query = held.size ? `?boards=${encodeURIComponent(boardsParam(held))}` : "";
  const socket = new WebSocket(`${s.base.replace(/^http/, "ws")}/api/live${query}`);
  sockets.push(socket);
  const got: { event: BoardEvent; bytes: number }[] = [];
  const waiting: ((value: { event: BoardEvent; bytes: number }) => void)[] = [];
  socket.on("message", data => {
    const event = JSON.parse(String(data)) as LiveEvent;
    if (event.type !== "board" || event.chatId !== agent.id) return;
    const value = { event, bytes: String(data).length };
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else got.push(value);
  });
  await new Promise(resolve => socket.once("open", resolve));
  return {
    next: () => (got.length ? Promise.resolve(got.shift()!) : new Promise(resolve => waiting.push(resolve))),
    // As kept.svelte.ts names a board it read after the socket opened; the ping's pong says the server took the command before it.
    read: async board => {
      socket.send(JSON.stringify({ type: "boards", held: boardsParam(new Map([[agent.id, boardKey(board)]])) }));
      const pong = new Promise<void>(resolve => socket.on("message", data => (String(data) === '{"type":"pong"}' ? resolve() : undefined)));
      socket.send(JSON.stringify({ type: "ping" }));
      await pong;
    },
  };
}

const board = async (): Promise<ChatBoard> => (await s.get<BoardView>(`/api/agents/${agent.id}/board`)).board!;
const write = (ops: unknown[]) => s.send("POST", `/api/agents/${agent.id}/board`, { actor: "agent", ops });

test("a page that holds the board before a change gets what changed, and a page on another board or none gets the whole board", async () => {
  await write([{ op: "plan_add", text: "Pick the night shift's pager.", note: "x".repeat(8_000) }, { op: "plan_add", text: "Move the alerts." }]);
  const shown = await board();
  const old = { ...shown, rev: shown.rev - 1 };
  const onBase = await page(new Map([[agent.id, boardKey(shown)]]));
  const onOther = await page(new Map([[agent.id, boardKey(old)]]));
  const holdsNone = await page(new Map());

  await write([{ op: "plan_update", id: shown.plan.at(-1)!.id, text: "Move the alerts to the night channel." }]);
  const now = await board();
  const [delta, whole, none] = await Promise.all([onBase.next(), onOther.next(), holdsNone.next()]);
  assert.ok("delta" in delta.event, "the page on the delta's base got the whole board");
  assert.deepEqual(applyBoardDelta(shown, delta.event.delta), now);
  assert.ok(delta.bytes < 1_000, `the delta event is ${delta.bytes} bytes`);
  assert.ok("board" in whole.event, "the page on another board got a delta");
  assert.deepEqual(whole.event.board, now);
  assert.ok(whole.bytes > 8_000, `the whole board event is ${whole.bytes} bytes`);
  assert.ok("board" in none.event);
  assert.equal(delta.event.row?.rev, now.rev);

  // The whole board left each page on the new board, so the next change reaches every page as what changed.
  await write([{ op: "plan_update", id: now.plan[0]!.id, status: "doing" }]);
  const then = await board();
  for (const [next, held] of [[await onBase.next(), applyBoardDelta(shown, delta.event.delta)!], [await onOther.next(), now], [await holdsNone.next(), now]] as const) {
    assert.ok("delta" in next.event, "a page the server sent the last board got the whole board again");
    assert.deepEqual(applyBoardDelta(held, next.event.delta), then);
  }
});


test("a page that names a board it read after its socket opened gets that board's next change as what changed", async () => {
  const late = await page(new Map());
  const shown = await board();
  await late.read(shown);
  await write([{ op: "plan_update", id: shown.plan[0]!.id, text: "Pick the night shift's pager and its backup." }]);
  const { event } = await late.next();
  assert.ok("delta" in event, "the page that named its board got the whole board");
  assert.deepEqual(applyBoardDelta(shown, event.delta), await board());
});
