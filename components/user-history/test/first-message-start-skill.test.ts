// Guards the owner's own first messages on a new thread: with a start skill set, each one began with "/skill:<skill> " and took the slow path,
// the create's answer, a commands lookup, then the prompt, so the 10-20 fixes that send the first message with the create never reached him.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { asset } from "../src/chat-assets.ts";
import { startChatServer } from "../src/chat-server.ts";

async function serve(t: { after: (fn: () => unknown) => void }, startSkill: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "first-start-skill-"));
  const creates: Record<string, unknown>[] = [], prompts: string[] = [];
  const backend = {
    close: async () => {}, catalog: { isOtherHost: (host?: string) => host === "mac", selfHost: () => null },
    threads: { create: async (input: Record<string, unknown>) => { creates.push(input); return { id: "new-thread" }; }, prompt: async (_id: string, input: { message: string }) => { prompts.push(input.message); } },
    created: { add: async () => {} }, newChat: { remember: async () => {}, read: async () => ({ startSkill }) },
  } as unknown as ChatBackend;
  const empty = asset(Buffer.from(""), "text/plain");
  const server = await startChatServer({ backend, bundle: { js: empty, css: empty, version: "start-skill" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "start-skill", socketPath: join(dir, "no-daemon.sock") }, onStop: async () => {} });
  t.after(() => server.close());
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(new URL("api/threads", server.url), { method: "POST", headers: { "content-type": "application/json", "x-chat-token": "token", origin: new URL(server.url).origin },
      body: JSON.stringify({ requestId: `start-skill-request-${creates.length + prompts.length}`, cwd: "/Users/sieunpark", host: "mac", ...body }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  return { post, creates, prompts };
}

test("a first message that starts with the start skill rides on the create like plain text", async t => {
  const { post, creates, prompts } = await serve(t, "poteto-mode");
  await post({ message: "/skill:poteto-mode check the Mac daemon" });
  assert.deepEqual(creates[0]!.first, { message: "/skill:poteto-mode check the Mac daemon", mode: "followUp" });
  assert.deepEqual(prompts, []);
});

test("any other slash command still goes by the prompt, which checks the command first", async t => {
  const { post, creates, prompts } = await serve(t, "poteto-mode");
  await post({ message: "/skill:other-skill hi" });
  await post({ message: "/compact" });
  assert.deepEqual(creates.map(input => input.first), [undefined, undefined]);
  assert.deepEqual(prompts, ["/skill:other-skill hi", "/compact"]);
});
