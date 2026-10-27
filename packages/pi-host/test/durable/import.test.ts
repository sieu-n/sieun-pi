/**
 * A Prime session file imports as a durable thread: the active branch only, a compaction keeps its head, and the next
 * input sends the model the summary and the kept messages, as Prime would have.
 */
import { strict as assert } from "node:assert";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableThreads } from "../../src/durable/index.ts";
import { textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-import-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } };
const assistant = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage, stopReason: "stop", timestamp: ts });
const lines = [
  { type: "session", version: 3, id: "old-thread", timestamp: "2026-10-20T00:00:00.000Z", cwd: dir },
  { type: "model_change", id: "m1", parentId: null, provider: "anthropic", modelId: "claude-opus-5-5" },
  { type: "session_info", id: "n1", parentId: "m1", name: "Vent" },
  { type: "message", id: "u1", parentId: "n1", timestamp: "2026-10-20T00:00:01.000Z", message: { role: "user", content: "first question about llamas", timestamp: 1 } },
  { type: "message", id: "a1", parentId: "u1", message: assistant("first answer about llamas", 2) },
  { type: "message", id: "dead", parentId: "a1", message: { role: "user", content: "an abandoned branch about zebras", timestamp: 3 } },
  { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "second question about alpacas", timestamp: 4 } },
  { type: "message", id: "a2", parentId: "u2", message: assistant("second answer about alpacas", 5) },
  { type: "compaction", id: "c1", parentId: "a2", timestamp: "2026-10-20T00:00:06.000Z", summary: "We talked about llamas and alpacas.", firstKeptEntryId: "u2", tokensBefore: 100 },
  { type: "custom_message", id: "x1", parentId: "c1", customType: "agent_message", content: "[agent-message from parent] keep going", display: true, timestamp: "2026-10-20T00:00:07.000Z" },
  { type: "message", id: "a3", parentId: "x1", message: assistant("third answer, continuing", 8) },
];
const file = join(dir, "old.jsonl");
writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");

test("a Prime session imports as a thread, and the next input sees the summary and kept messages only", async () => {
  let seen: Message[] = [];
  const threads = new DurableThreads({
    dir: join(dir, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses([context => { seen = context.messages; return fauxAssistantMessage("got it"); }]);
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: dir,
  });
  try {
    const thread = await threads.importSession(file);
    assert.equal(thread.name, "Vent");
    assert.equal(thread.imported, 7);
    assert.equal(thread.cwd, dir);
    const { entries } = await threads.entries(thread.id, { limit: 50 });
    assert.deepEqual(entries.reverse().map(entry => entry.kind), ["pi.user", "pi.assistant", "pi.user", "pi.assistant", "pi.compaction", "prime.custom", "pi.assistant"]);
    assert.equal(threads.search({ q: "zebras" }).length, 0);
    assert.equal(threads.search({ q: "alpacas" }).length >= 2, true);
    const [usageRow] = threads.usage({ threads: [thread.id] });
    assert.equal(usageRow?.turns, 3);
    assert.deepEqual([usageRow!.costInput, usageRow!.costOutput, usageRow!.costCacheRead, usageRow!.costCacheWrite, usageRow!.cost].map(n => Math.round(n * 100) / 100), [0.3, 0.6, 0.09, 0.12, 1.11]);

    const { submission } = await threads.submit(thread.id, { text: "what next?", requestId: "after-import" });
    const settled = await threads.wait(thread.id, submission);
    assert.equal(settled.status, "done");
    const texts = seen.filter(message => message.role !== "system").map(message => `${message.role}:${textOf(message.content as never)}`);
    assert.ok(texts[0]!.startsWith("user:The conversation history before this point was compacted"), texts.join("\n"));
    assert.ok(texts[0]!.includes("We talked about llamas and alpacas."));
    assert.deepEqual(texts.slice(1), [
      "user:second question about alpacas", "assistant:second answer about alpacas", "user:[agent-message from parent] keep going",
      "assistant:third answer, continuing", "user:what next?",
    ]);
  } finally {
    await threads.shutdown();
  }
});
