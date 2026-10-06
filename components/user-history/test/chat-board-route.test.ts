import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoardStore } from "../src/chat-board-store.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBoard } from "../src/shared/types.ts";

test("POST api/threads/:id/board: owner todo ops apply, the board is broadcast, the chat gets a [board] steer; non-chats 404, plan ops 403", async () => {
  const boards = new BoardStore(await mkdtemp(join(tmpdir(), "board-route-")));
  await boards.apply("chat1", [{ op: "plan_add", text: "Goal" }, { op: "todo_add", text: "Approve the Email picks" }], "agent");
  const prompts: { id: string; message: string; mode: string }[] = [];
  const broadcast: { id: string; rev: number }[] = [];
  const backend = {
    chats: { ids: async () => new Set(["chat1"]) },
    boards,
    threads: {
      setBoard(id: string, board: ChatBoard) { broadcast.push({ id, rev: board.rev }); },
      async prompt(id: string, input: { message: string; mode: string }) { prompts.push({ id, message: input.message, mode: input.mode }); },
    },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = async (id: string, body: unknown) => {
    const res = await fetch(server.url + `api/threads/${id}/board`, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Chat-Token": "token", Origin: origin } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  try {
    const checked = await post("chat1", { ops: [{ op: "todo_update", id: "t1", done: true, reply: "Use Resend" }] });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.sent, true);
    assert.equal((checked.body.board as ChatBoard).rev, 3);
    assert.deepEqual(prompts, [{ id: "chat1", message: '[board] Owner checked "Approve the Email picks" and answered: Use Resend', mode: "steer" }]);
    assert.deepEqual(broadcast, [{ id: "chat1", rev: 3 }]);
    const added = await post("chat1", { ops: [{ op: "todo_add", text: "Call me at 5" }, { op: "todo_remove", id: "t1" }] });
    assert.equal(prompts[1]!.message, '[board] Owner added a todo "Call me at 5"; Owner removed the todo "Approve the Email picks"');
    assert.deepEqual((added.body.board as ChatBoard).todos.map(todo => [todo.id, todo.from]), [["t2", "owner"]]);
    assert.equal((await post("plain", { ops: [{ op: "todo_add", text: "x" }] })).status, 404);
    assert.equal((await post("chat1", { ops: [{ op: "plan_update", id: "p1", status: "done" }] })).status, 403);
    assert.equal((await post("chat1", { ops: [{ op: "todo_update", id: "t9", done: true }] })).status, 409);
    assert.equal((await post("chat1", { ops: [] })).status, 400);
    assert.equal((await post("chat1", { ops: [{ op: "todo_add" }] })).status, 400);
    assert.equal(prompts.length, 2, "refused ops send nothing");
    assert.equal((await boards.read("chat1"))?.rev, 5);
  } finally { await server.close(); }
});
