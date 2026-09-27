import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatDefaultsStore, type ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { ModelCatalog, ModelInfo } from "../src/shared/types.ts";

function agentDir(settings: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-defaults-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  return dir;
}
const settingsOf = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

test("defaults store reads and writes Prime Agent settings.json and keeps other keys", async () => {
  const dir = agentDir({ theme: "dark", defaultProvider: "anthropic", defaultModel: "claude-opus-5-5", defaultThinkingLevel: "high", rlmMaxDepth: 3 });
  const store = chatDefaultsStore(dir);
  assert.deepEqual(store.read(), { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" });

  await store.write({ provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" });
  assert.deepEqual(store.read(), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" });
  const written = settingsOf(dir);
  assert.equal(written.theme, "dark");
  assert.equal(written.rlmMaxDepth, 3);
  assert.equal(written.defaultProvider, "openai-codex");
  assert.equal(written.defaultModel, "gpt-6-astra");
  assert.equal(written.defaultThinkingLevel, "xhigh");

  await store.write({ provider: "anthropic", modelId: "claude-fable-5-1" });
  assert.deepEqual(store.read(), { provider: "anthropic", modelId: "claude-fable-5-1", thinkingLevel: "xhigh" }, "a write without a level keeps the stored level");
  assert.equal(settingsOf(dir).theme, "dark");

  const empty = chatDefaultsStore(mkdtempSync(join(tmpdir(), "chat-defaults-empty-")));
  assert.deepEqual(empty.read(), { provider: null, modelId: null, thinkingLevel: null });
  assert.deepEqual(chatDefaultsStore(agentDir({ defaultThinkingLevel: "ultra" })).read().thinkingLevel, null, "an unknown stored level reads as unset");
});

test("api/defaults validates against the catalog and needs the write token", async () => {
  const dir = agentDir({ defaultProvider: "anthropic", defaultModel: "claude-opus-5-5", defaultThinkingLevel: "high", theme: "light" });
  const models: ModelInfo[] = [
    { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text", "image"], contextWindow: 200000, reasoning: true, thinkingLevels: ["off", "low", "medium", "high", "max"] },
    { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra", input: ["text"], contextWindow: 400000, reasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh"] },
  ];
  const catalog: ModelCatalog = { models, configuredProviders: ["anthropic", "openai-codex"], current: null, thinkingLevel: null, availableThinkingLevels: [] };
  const backend = { defaults: chatDefaultsStore(dir), threads: { models: async () => catalog }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = (body: unknown, headers: Record<string, string> = { "X-Chat-Token": "token", Origin: origin }) =>
    fetch(server.url + "api/defaults", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  try {
    assert.deepEqual(await (await fetch(server.url + "api/defaults")).json(), { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" });
    assert.equal((await post({ provider: "openai-codex", modelId: "gpt-6-astra" }, { Origin: origin })).status, 403);
    assert.equal((await post({ provider: "openai-codex", modelId: "gpt-6-astra" }, { "X-Chat-Token": "token", Origin: "http://evil.example" })).status, 403);
    const bogus = await post({ provider: "anthropic", modelId: "claude-nope" });
    assert.equal(bogus.status, 400);
    assert.equal((await bogus.json()).error, "Choose a model from the catalog.");
    const level = await post({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "xhigh" });
    assert.equal(level.status, 400);
    assert.match((await level.json()).error, /effort Claude Opus 5.5 supports/);
    assert.equal((await post({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: 3 })).status, 400);
    assert.deepEqual(settingsOf(dir).defaultModel, "claude-opus-5-5", "rejected writes leave the file alone");

    const accepted = await post({ provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" });
    assert.deepEqual(await (await fetch(server.url + "api/defaults")).json(), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" });
    const written = settingsOf(dir);
    assert.equal(written.theme, "light");
    assert.equal(written.defaultProvider, "openai-codex");
    assert.equal(written.defaultThinkingLevel, "xhigh");

    const kept = await post({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: null });
    assert.deepEqual(await kept.json(), { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "xhigh" }, "a null level keeps the stored one; the catalog resolves it per model");
  } finally { await server.close(); }
});
