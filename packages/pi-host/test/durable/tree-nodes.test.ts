/**
 * A tree read builds only the nodes of conversations a commit touched since the last read. On 11-22 a tree of agent factory's 380
 * conversations held pi-host's loop 250 to 300 ms, the chat read it every 2 s while the thread ran, and every timeline read waited behind it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-tree-nodes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a second tree read builds no node again, and a commit to one conversation rebuilds only that node", async () => {
  const threads = new DurableThreads({ dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null, models: () => createModels() });
  try {
    const thread = await threads.create({ name: "many jobs" });
    const { harness } = await (threads as unknown as { thread(id: string): Promise<{ harness: Harness }> }).thread(thread.id);
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT));
    const first = await threads.tree(thread.id);
    assert.equal(first.length, 21);

    const built: number[] = [];
    const read = harness.conversation.bind(harness);
    harness.conversation = async (id, context) => {
      built.push(id);
      return read(id, context);
    };
    assert.deepEqual(await threads.tree(thread.id), first);
    assert.deepEqual(built, [], "an unchanged tree reads no conversation");

    const job = jobs[7]!;
    await job.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    await harness.commit(async tx => {
      await tx.appendEntry(job.id, { kind: "pi.message", model: [{ role: "user", content: "Write the relay page.", timestamp: 0 }] } as never);
    }, BACKGROUND_CONTEXT);
    const next = await threads.tree(thread.id);
    assert.deepEqual(built, [job.id], "only the touched conversation is read again");
    assert.equal(next.find(node => node.id === job.id)?.name, "Write the relay page");
    assert.deepEqual(next.filter(node => node.id !== job.id), first.filter(node => node.id !== job.id));
  } finally {
    await threads.shutdown();
  }
});
