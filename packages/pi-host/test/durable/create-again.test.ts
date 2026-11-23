/**
 * A `durable_create` that names its thread id makes that thread once: the same create sent again, while the first still opens the thread or
 * after it answered, answers the same thread and makes no second one. On 11-23 apps/chat's comm thread create for #1124-cost-management
 * timed out during a 14 min pi-host loop freeze, each of its three tries made a thread, and two of them stayed behind empty.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Outbound } from "../../src/protocol.ts";
import { DurableCommands } from "../../src/durable/commands.ts";
import { DurableThreads, type ThreadInfo } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-create-again-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function models() {
  const out = createModels();
  out.setProvider(fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 }).provider);
  return out;
}

const sink = { clientId: "chat", write: (_line: Outbound) => {} };
type Answer = { success: boolean; data?: { thread: ThreadInfo }; error?: string };

test("a durable_create sent three times with the same thread id makes one thread", async () => {
  const threads = new DurableThreads({ dir: join(dir, "durable"), models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir });
  const commands = new DurableCommands(threads);
  try {
    await threads.start();
    const create = async (request: string) => (await commands.handle({ id: request, type: "durable_create", thread: "767933b2-9421-4702-9372-2711fc2b623b", name: "agent · #room", cwd: dir }, sink)) as Answer;
    // The first try's caller gave up while pi-host still opened the thread, and the second came in before the open ended.
    const [first, second] = await Promise.all([create("1"), create("2")]);
    const third = await create("3");
    for (const answer of [first, second, third]) assert.equal(answer.success, true, answer.error);
    assert.deepEqual([first, second, third].map(a => a.data!.thread.id), Array(3).fill("767933b2-9421-4702-9372-2711fc2b623b"));
    assert.deepEqual(threads.list().filter(t => t.name === "agent · #room").map(t => t.id), ["767933b2-9421-4702-9372-2711fc2b623b"]);
    assert.equal((await threads.thread("767933b2-9421-4702-9372-2711fc2b623b")).root.id, 1);

    const plain = (await commands.handle({ id: "4", type: "durable_create", name: "agent · #room" }, sink)) as Answer;
    assert.notEqual(plain.data!.thread.id, "767933b2-9421-4702-9372-2711fc2b623b");
    const bad = (await commands.handle({ id: "5", type: "durable_create", thread: "../x" }, sink)) as Answer;
    assert.equal(bad.success, false);
    assert.match(bad.error!, /must be a uuid/);
  } finally {
    await threads.shutdown();
  }
});
