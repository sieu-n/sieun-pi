import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import { C74, releaseGo } from "../src/shared/release-go.ts";

const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const P71 = "Ship: merge #254, #252, #253, #225, #250, #255, #256 and #257, then turn the reminder on in production";
const MOVE = [{ op: "plan_update", id: "p1", status: "doing", job: "main merges" }];

type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
function boardTool(dataDir: string): Tool {
  const tools = new Map<string, Tool>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  return tools.get("chat_board")!;
}
const ctx = { sessionManager: { getSessionId: () => CHAT } };
async function seeded(): Promise<BoardStore> {
  const boards = new BoardStore(await mkdtemp(join(tmpdir(), "agent-board-service-")));
  await boards.apply(CHAT, [{ op: "plan_add", text: P71 }], "agent");
  assert.equal((await boards.read(CHAT))!.plan[0]!.go, "needed", "the merge step carries the go mark");
  return boards;
}
/** A session data dir that names a chat service by instance.json and configuration.json, the files the live service writes. */
async function sessionDir(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-board-session-"));
  await writeFile(join(dir, "instance.json"), JSON.stringify({ pid: process.pid, instanceId: "00000000-0000-0000-0000-000000000000", url }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "token" }));
  return dir;
}

test("slack green guy p71 (10-15 19:18 KST): a session's chat_board write is judged by the live service, so a rule change reaches it with no reload", async () => {
  const boards = await seeded();
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const backend = { chats: { ids: async () => new Set([CHAT]) }, boards, threads: { setBoard() {} }, close: async () => {} } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const tool = boardTool(await sessionDir(server.url));
  try {
    const flagged = await tool.execute("c1", { ops: [{ op: "plan_add", text: "Push the fix to sieun/dev", waitFor: "Fable's go for our slot" }] }, undefined, undefined, ctx);
    assert.match(flagged.content[0]!.text, /waits for another thread's go, word or slot/, "the service applies the board's c47 flag");
    const moved = await tool.execute("c2", { ops: MOVE }, undefined, undefined, ctx);
    assert.match(moved.content[0]!.text, /^Updated p1 .*\nBoard rev 3: /);
    assert.equal((await boards.read(CHAT))!.plan[0]!.status, "doing", "the write landed in the service's store");
  } finally { await server.close(); }
});

test("chat_board applies with the session's own copy when no service takes the write: connection refused, or a service from before the route (404)", async () => {
  releaseGo.preapproval = C74;
  const closed = createServer();
  await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
  const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/cap/`;
  await new Promise<void>(done => closed.close(() => done()));
  const old = createServer((_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found." })); });
  await new Promise<void>(done => old.listen(0, "127.0.0.1", done));
  try {
    for (const url of [deadUrl, `http://127.0.0.1:${(old.address() as AddressInfo).port}/cap/`]) {
      const dir = await sessionDir(url);
      const written = await boardTool(dir).execute("c1", { ops: [{ op: "plan_add", text: P71, status: "doing" }] }, undefined, undefined, ctx);
      assert.match(written.content[0]!.text, /^Added p1 /, url);
      assert.equal((await new BoardStore(dir).read(CHAT))!.plan[0]!.status, "doing", url);
    }
  } finally { await new Promise<void>(done => old.close(() => done())); }
});
