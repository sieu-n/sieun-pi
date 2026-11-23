/**
 * A doc put with newerOnly keeps the held doc when its `rev` is above the put's. apps/chat answers a board write before its put reaches
 * pi-host (apps/chat/server/boards.ts `putBoards`), so a put a release's stop left running can land after the next server's put of a
 * later board; it must not replace that board.
 * Run: cd packages/pi-host && node --import tsx --test --test-force-exit --test-isolation=none test/durable/doc-put-newer.test.ts
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-doc-put-newer-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a newerOnly put of an older rev leaves the held doc and sends no doc event, and a newer or equal rev writes", async () => {
  const threads = new DurableThreads({
    dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: () => {
      const models = createModels();
      models.setProvider(fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] }).provider);
      return models;
    },
  });
  try {
    const { id } = await threads.create({ name: "board puts" });
    const board = (rev: number, text: string) => ({ v: 2, rev, plan: [{ id: "p1", text }], todos: [], updatedAt: new Date().toISOString() });
    const docs: unknown[] = [];
    const stop = await threads.watch(id, {}, event => { if (event.type === "doc") docs.push(event.value); });
    try {
      assert.equal(await threads.docPut(id, "chat.board", board(5, "later"), undefined, { newerOnly: true }), true);
      assert.equal(await threads.docPut(id, "chat.board", board(4, "earlier, landing late"), undefined, { newerOnly: true }), false);
      assert.equal((await threads.docGet(id, "chat.board") as { plan: { text: string }[] }).plan[0]!.text, "later");
      assert.equal(await threads.docPut(id, "chat.board", board(5, "the same rev again"), undefined, { newerOnly: true }), true);
      assert.equal(await threads.docPut(id, "chat.board", board(6, "next"), undefined, { newerOnly: true }), true);
      // Without newerOnly a put writes whatever it holds, as every put did before.
      assert.equal(await threads.docPut(id, "chat.board", board(1, "a plain put")), true);
      assert.equal((await threads.docGet(id, "chat.board") as { rev: number }).rev, 1);
      assert.deepEqual(docs.map(doc => (doc as { plan: { text: string }[] }).plan[0]!.text), ["later", "the same rev again", "next", "a plain put"]);
    } finally {
      await stop();
    }
  } finally {
    await threads.shutdown();
  }
});
