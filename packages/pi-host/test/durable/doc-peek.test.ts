/**
 * A doc read of a thread that is not open answers from its file and leaves the thread closed. apps/chat's agent.ref check reads every
 * agent thread's ref, one every 500 ms, pass after pass (apps/chat/server/agents.ts `verifyRefs`); when each read opened its thread, pi-host
 * held 1,155 thread files open 12 min after a start on 11-23 (~/work/pi-host-stalls/f-boot/).
 * Run: cd packages/pi-host && node --import tsx --test --test-force-exit --test-isolation=none test/durable/doc-peek.test.ts
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

const scratch = mkdtempSync(join(tmpdir(), "pi-host-doc-peek-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function host(dir: string): DurableThreads {
  return new DurableThreads({
    dir, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: () => {
      const models = createModels();
      models.setProvider(fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] }).provider);
      return models;
    },
  });
}

const ref = (agent: string) => ({ agent, role: "job", dir: `/agents/${agent}` });

test("a doc read of a closed thread gives the open thread's value and leaves the thread closed", async () => {
  const dir = join(scratch, "closed");
  const threads = host(dir);
  const ids: string[] = [];
  try {
    for (let n = 0; n < 3; n++) {
      const { id } = await threads.create({ name: `agent thread ${n}` });
      await threads.docPut(id, "agent.ref", ref(`ag_${n}`));
      ids.push(id);
    }
    await threads.docPut(ids[0]!, "chat.board", { v: 2, rev: 3, plan: [{ id: "p1", text: "kept" }] });
    const fromOpen = await Promise.all(ids.map(id => threads.docGet(id, "agent.ref")));
    for (const id of ids) await threads.closeThread(id, "test");

    for (const [n, id] of ids.entries()) {
      assert.deepEqual(await threads.docGet(id, "agent.ref"), fromOpen[n]);
      assert.equal(await threads.observe(id), undefined, `thread ${n} was opened by a doc read`);
    }
    assert.deepEqual(await threads.docGet(ids[0]!, "chat.board"), { v: 2, rev: 3, plan: [{ id: "p1", text: "kept" }] });
    assert.equal(await threads.docGet(ids[1]!, "chat.board"), null);
    assert.equal(await threads.docGet(ids[1]!, "agent.ref", 7), null);
    await assert.rejects(threads.docGet("0000-no-such-thread", "agent.ref"), /No durable thread/);
    assert.equal(await threads.observe(ids[0]!), undefined);
  } finally {
    await threads.shutdown();
  }
});

test("a doc read beside an open of the same thread, and a write after it, read what the file holds", async () => {
  const dir = join(scratch, "race");
  const threads = host(dir);
  try {
    const { id } = await threads.create({ name: "raced" });
    await threads.docPut(id, "agent.ref", ref("ag_before"));
    await threads.closeThread(id, "test");

    const [peeked, opened] = await Promise.all([threads.docGet(id, "agent.ref"), threads.thread(id), threads.docGet(id, "agent.ref")]);
    assert.deepEqual(peeked, ref("ag_before"));
    assert.ok(opened.harness);
    await threads.docPut(id, "agent.ref", ref("ag_after"));
    assert.deepEqual(await threads.docGet(id, "agent.ref"), ref("ag_after"));
    await threads.closeThread(id, "test");
    assert.deepEqual(await threads.docGet(id, "agent.ref"), ref("ag_after"));
  } finally {
    await threads.shutdown();
  }
  // A new process on the same folder reads the same doc without opening the thread.
  const again = host(dir);
  try {
    const [row] = again.list();
    assert.deepEqual(await again.docGet(row!.id, "agent.ref"), ref("ag_after"));
    assert.equal(await again.observe(row!.id), undefined);
  } finally {
    await again.shutdown();
  }
});
