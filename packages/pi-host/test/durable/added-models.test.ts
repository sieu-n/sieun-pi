// Guards c221 (2026-11-10): every thread and job runs Claude Fable 5.2 at medium thinking. pi-ai 1.4.0's catalog lacks Fable 5.2, and
// Anthropic refuses it under pi-ai's user-agent claude-cli/2.1.280 with 400 claude_code_version_too_old, so pi-host takes the entry from
// Prime's models.json. pi-host reads its default model and thinking level from Prime's settings.json, so the two cannot drift.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableModels, primeDefaults } from "../../src/durable/models.ts";
import { DurableThreads } from "../../src/durable/threads.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-added-models-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const agentDir = (name: string, files: { settings?: unknown; models?: unknown }): string => {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  if (files.settings !== undefined) writeFileSync(join(path, "settings.json"), JSON.stringify(files.settings));
  if (files.models !== undefined) writeFileSync(join(path, "models.json"), JSON.stringify(files.models));
  return path;
};

test("durable threads run Claude Fable 5.2 with a user-agent Anthropic accepts, every thinking level from low to max, and Fable 5.1's adaptive thinking", () => {
  const model = durableModels("added-models-test").getModel("anthropic", "claude-fable-5-2");
  assert.ok(model, "anthropic/claude-fable-5-2 is in the registry");
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.headers?.["user-agent"], "claude-cli/2.1.311");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 500_000);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.equal(model.compat?.forceAdaptiveThinking, true, "medium reaches Anthropic as effort, not a token budget");
});

test("a models.json entry of a model the catalog lacks wins over pi-host's shipped one and is read again when the file changes", () => {
  const entry = (agent: string) => ({ providers: { anthropic: { models: [{ id: "claude-fable-5-2", name: "Claude Fable 5.2", contextWindow: 400_000, headers: { "user-agent": agent } }] } } });
  const path = agentDir("models-json", { models: entry("claude-cli/2.1.400") });
  const models = durableModels("models-json-test", { agentDir: path });
  assert.equal(models.getModel("anthropic", "claude-fable-5-2")?.headers?.["user-agent"], "claude-cli/2.1.400");
  assert.equal(models.getModel("anthropic", "claude-fable-5-2")?.contextWindow, 400_000);
  writeFileSync(join(path, "models.json"), JSON.stringify(entry("claude-cli/2.1.401")) + "\n");
  assert.equal(models.getModel("anthropic", "claude-fable-5-2")?.headers?.["user-agent"], "claude-cli/2.1.401");
  assert.equal(models.getModel("anthropic", "claude-opus-5-5")?.headers, undefined, "a catalog model keeps pi-ai's entry");
});

test("pi-host's default model and thinking level are Prime's settings.json ones, read again when the file changes", () => {
  assert.deepEqual(primeDefaults(agentDir("none", {})), { model: { provider: "anthropic", modelId: "claude-fable-5-2" }, thinkingLevel: "medium" });
  const path = agentDir("settings", { settings: { defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "xhigh" } });
  assert.deepEqual(primeDefaults(path), { model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, thinkingLevel: "xhigh" });
  writeFileSync(join(path, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-fable-5-2", defaultThinkingLevel: "medium" }) + "\n");
  assert.deepEqual(primeDefaults(path), { model: { provider: "anthropic", modelId: "claude-fable-5-2" }, thinkingLevel: "medium" });
});

test("a thread set with jobs moves its root and each job on the root's old model, and a thread set without jobs moves only its root", async () => {
  const OLD = { provider: "anthropic", modelId: "claude-opus-5-5" };
  const NEW = { provider: "anthropic", modelId: "claude-fable-5-2" };
  let defaults = { model: OLD, thinkingLevel: "high" as const };
  const threads = new DurableThreads({
    dir: join(dir, "threads"),
    models: () => {
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: OLD.modelId }, { id: NEW.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 12 }, () => ({ messages }: { messages: Message[] }) => {
        const first = messages.find(m => m.role === "user");
        const text = typeof first?.content === "string" ? first.content : (first?.content ?? []).map(c => (c.type === "text" ? c.text : "")).join("");
        if (text === "spawn" && messages.at(-1)?.role === "user") return fauxAssistantMessage([fauxToolCall("subagent", { task: "check the canary", name: "canary" })], { stopReason: "toolUse" });
        return fauxAssistantMessage("ok");
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: () => defaults.model,
    defaultThinkingLevel: () => defaults.thinkingLevel,
    defaultCwd: dir,
  });
  try {
    const thread = await threads.create({ name: "factory" });
    assert.equal(`${thread.provider}/${thread.modelId} ${thread.thinkingLevel}`, "anthropic/claude-opus-5-5 high");
    const { submission } = await threads.submit(thread.id, { text: "spawn" });
    assert.equal((await threads.wait(thread.id, submission)).status, "done");
    const job = async () => (await threads.tree(thread.id)).find(node => node.parent !== null);
    assert.equal((await job())?.model, "anthropic/claude-opus-5-5");

    const moved = await threads.set(thread.id, { model: NEW, thinkingLevel: "medium", jobs: true });
    assert.equal(`${moved.provider}/${moved.modelId} ${moved.thinkingLevel}`, "anthropic/claude-fable-5-2 medium");
    assert.deepEqual((await threads.tree(thread.id)).map(node => node.model), ["anthropic/claude-fable-5-2", "anthropic/claude-fable-5-2"]);

    await threads.set(thread.id, { model: OLD });
    assert.deepEqual((await threads.tree(thread.id)).map(node => node.model), ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-2"]);

    defaults = { model: NEW, thinkingLevel: "medium" };
    const fresh = await threads.create({ name: "fresh" });
    assert.equal(`${fresh.provider}/${fresh.modelId} ${fresh.thinkingLevel}`, "anthropic/claude-fable-5-2 medium", "a new thread reads the defaults at creation");
  } finally {
    await threads.shutdown();
  }
});
