// chat-2572 p20 on 10-25: clean-room setups gave the head its first message at create, so its first turn could race the board seed. POST
// api/threads with deferFirst makes an empty chat with its check-in paused, and setup sends the first message later. Every other create still
// needs a message or an image.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { asset } from "../src/chat-assets.ts";
import { startChatServer } from "../src/chat-server.ts";

async function serve(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "defer-first-"));
  const calls: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const backend = {
    close: async () => {}, catalog: { isOtherHost: () => false, selfHost: () => null },
    chats: { create: async (input: Record<string, unknown>) => { creates.push(input); calls.push("create chat"); return { id: "01a17200-0000-7000-8000-0000000000aa", name: "root free space" }; },
      setCheckIn: async (id: string, change: Record<string, unknown>, actor: Record<string, unknown>) => { calls.push(`check-in ${id} ${JSON.stringify(change)} by ${actor.setter}`); return {}; } },
    threads: { create: async (input: Record<string, unknown>) => { creates.push(input); calls.push("create thread"); return { id: "01a17200-0000-7000-8000-0000000000bb" }; },
      prompt: async (_id: string, input: { message: string }) => { calls.push(`prompt ${input.message}`); } },
    created: { add: async () => {} }, newChat: { remember: async () => {}, read: async () => ({ startSkill: null }) },
  } as unknown as ChatBackend;
  const empty = asset(Buffer.from(""), "text/plain");
  const server = await startChatServer({ backend, bundle: { js: empty, css: empty, version: "defer-first" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "defer-first", socketPath: join(dir, "no-daemon.sock") }, onStop: async () => {} });
  t.after(() => server.close());
  let n = 0;
  const post = async (body: Record<string, unknown>, requestId = `defer-first-request-${n++}`) => {
    const response = await fetch(new URL("api/threads", server.url), { method: "POST", body: JSON.stringify({ requestId, cwd: tmpdir(), ...body }),
      headers: { "content-type": "application/json", "x-chat-token": "token", origin: new URL(server.url).origin, "x-chat-agent-session": "01a16e22-91e0-7783-8ab3-dd7d6021ed6f" } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { post, calls, creates };
}

test("deferFirst makes an empty chat with its check-in paused and sends no message", async t => {
  const { post, calls, creates } = await serve(t);
  const made = await post({ message: "", kind: "chat", name: "root free space", deferFirst: true }, "defer-first-same");
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.id, "01a17200-0000-7000-8000-0000000000aa");
  assert.equal(creates[0]!.first, undefined);
  assert.deepEqual(calls, ["create chat", 'check-in 01a17200-0000-7000-8000-0000000000aa {"pause":"forever"} by 01a16e22-91e0-7783-8ab3-dd7d6021ed6f']);
  const again = await post({ message: "", kind: "chat", name: "root free space", deferFirst: true }, "defer-first-same");
  assert.equal(again.body.id, made.body.id);
  assert.equal(calls.filter(call => call === "create chat").length, 1, "the same request id joins the first create");
});

test("deferFirst is refused for a thread, a message, an account or a Slack setup, and normal creates keep their message check", async t => {
  const { post, calls } = await serve(t);
  for (const body of [{ message: "", kind: "thread", deferFirst: true }, { message: "sample /", kind: "chat", deferFirst: true },
    { message: "", kind: "chat", deferFirst: true, account: { provider: "anthropic", id: "a" } }, { message: "", kind: "chat", deferFirst: true, slack: { channel: "C1" } }]) {
    const answer = await post(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match(String(answer.body.error), /deferFirst makes an empty chat/);
  }
  for (const body of [{ message: "  ", kind: "chat" }, { message: "", kind: "thread" }, { message: "", kind: "chat", deferFirst: "yes" }]) {
    const answer = await post(body);
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, "Add a message or image.");
  }
  const normal = await post({ message: "sample the free space on /", kind: "chat", name: "free space" });
  assert.equal(normal.status, 200);
  assert.deepEqual(calls, ["create chat"], "a normal chat create is not paused and carries its message");
});
