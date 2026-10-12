import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { newChatStore } from "../src/chat-new-chat.ts";
import { startChatServer } from "../src/chat-server.ts";
import { parseStartSkill, startMessage } from "../src/shared/start-skill.ts";

test("start skill: the first message starts with the chosen skill, and with nothing when none is set", () => {
  assert.equal(startMessage("fix the login", "my-skill"), "/skill:my-skill fix the login");
  assert.equal(startMessage("fix the login", null), "fix the login", "a fresh install sends the message as typed");
  assert.equal(startMessage("  /compact", "my-skill"), "  /compact", "a message that starts with a command is sent as typed");
  assert.equal(parseStartSkill(undefined), null);
  assert.equal(parseStartSkill(""), null);
  assert.equal(parseStartSkill("team:review-1.2"), "team:review-1.2");
  for (const bad of ["/skill:x", "two words", 3, "-x"]) assert.throws(() => parseStartSkill(bad), /skill name/);
});

test("start skill: a fresh data directory has none; Settings sets and clears it through api/new-chat with the write token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "start-skill-"));
  const store = newChatStore(join(dir, "new-chat.json"));
  assert.deepEqual(await store.read(), { startSkill: null });
  assert.deepEqual(readdirSync(dir), [], "reading writes no file");
  const backend = { newChat: store, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = (body: unknown, headers: Record<string, string> = { "X-Chat-Token": "token", Origin: origin }) =>
    fetch(server.url + "api/new-chat", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  try {
    assert.deepEqual(await (await fetch(server.url + "api/new-chat")).json(), { startSkill: null });
    assert.equal((await post({ startSkill: "my-skill" }, { Origin: origin })).status, 403);
    assert.equal((await post({ startSkill: "/skill:my-skill" })).status, 400);
    assert.deepEqual(await (await post({ startSkill: "my-skill" })).json(), { startSkill: "my-skill" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "new-chat.json"), "utf8")), { startSkill: "my-skill" });
    assert.deepEqual(await (await fetch(server.url + "api/new-chat")).json(), { startSkill: "my-skill" });
    assert.deepEqual(await (await post({ startSkill: null })).json(), { startSkill: null });
  } finally { await server.close(); }
});

test("start skill: the page names no skill of its own", () => {
  const client = join(import.meta.dirname, "..", "src", "client");
  for (const name of readdirSync(client).filter(file => /\.(svelte|ts)$/.test(file))) {
    assert.doesNotMatch(readFileSync(join(client, name), "utf8"), /skill:[a-z]/, `${name} hardcodes a skill command`);
  }
});
