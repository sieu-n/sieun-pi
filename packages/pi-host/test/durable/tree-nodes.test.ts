/**
 * A tree read builds only the nodes of conversations a commit touched since the last read. On 11-22 a tree of agent factory's 380
 * conversations held pi-host's loop 250 to 300 ms, the chat read it every 2 s while the thread ran, and every timeline read waited behind it.
 * A kept node must still show each change the chat, the d9 duty and check-ins read from the tree: a run that starts, ends, is aborted, fails
 * or retries, a model change and a job's name.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Harness } from "@earendil-works/pi-durable";
import { durableSettings } from "@sieun-pi/pi-pool/durable";
import { RlmChildDoc } from "../../src/durable/children.ts";
import { RETRY_FLAG_MS } from "../../src/durable/retrying.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import type { TreeNode } from "../../src/durable/index.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-tree-nodes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const OTHER = "claude-sonnet-5-5";
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

/** A thread store whose faux model answers each request with the next of `responses`, and whose clock `shift` moves. */
function store(name: string, responses: FauxResponseStep[] = []) {
  const clock = { shift: 0 };
  const threads = new DurableThreads({
    dir: join(scratch, name), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    now: () => Date.now() + clock.shift,
    models: () => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }, { id: OTHER }] });
      faux.setResponses(responses);
      models.setProvider(faux.provider);
      return models;
    },
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
  });
  return { threads, clock };
}

const harnessOf = async (threads: DurableThreads, id: string) =>
  (await (threads as unknown as { thread(id: string): Promise<{ harness: Harness }> }).thread(id)).harness;

/** Reads the tree until conversation `id`'s node passes `done`, so a node kept past its change fails here by timeout. */
async function until(threads: DurableThreads, thread: string, id: number, done: (node: TreeNode) => boolean, what: string): Promise<TreeNode> {
  const end = Date.now() + 10_000;
  for (;;) {
    const node = (await threads.tree(thread)).find(n => n.id === id);
    if (node && done(node)) return node;
    if (Date.now() > end) throw new Error(`${what}: the node still reads ${JSON.stringify(node)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A faux answer that waits for `release`, so a run stays running until the test lets it end. */
function held(text: string): { step: FauxResponseStep; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  return { step: async () => { await gate; return fauxAssistantMessage(text); }, release };
}

test("a second tree read builds no node again, and a commit to one conversation rebuilds only that node", async () => {
  const { threads } = store("unchanged");
  try {
    const thread = await threads.create({ name: "many jobs" });
    const harness = await harnessOf(threads, thread.id);
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

test("a kept node shows a run that starts and ends, an abort and a failed turn", async () => {
  const first = held("Done.");
  const second = held("Never sent.");
  const { threads } = store("runs", [first.step, second.step, fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error: the prompt is too long" })]);
  try {
    const thread = await threads.create({ name: "runs" });
    await until(threads, thread.id, 1, n => n.status === "idle", "a new thread");
    await threads.submit(thread.id, { text: "Build the relay page." });
    await until(threads, thread.id, 1, n => n.status === "running", "a run that starts");
    first.release();
    await until(threads, thread.id, 1, n => n.status === "idle", "a run that ends");

    await threads.submit(thread.id, { text: "Build the second page." });
    await until(threads, thread.id, 1, n => n.status === "running", "a second run");
    await threads.abort(thread.id);
    await until(threads, thread.id, 1, n => n.status === "idle", "an aborted run");
    second.release();

    await threads.submit(thread.id, { text: "Build the third page." });
    await until(threads, thread.id, 1, n => n.status === "idle" && threads.info(thread.id).status !== "running", "a failed turn");
  } finally {
    await threads.shutdown();
  }
});

test("a kept node shows a model change and a job's name given after its first read", async () => {
  const { threads } = store("model and name");
  try {
    const thread = await threads.create({ name: "model and name" });
    const harness = await harnessOf(threads, thread.id);
    const job = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const before = await until(threads, thread.id, job.id, () => true, "a new job");
    assert.notEqual(before.model, `anthropic/${OTHER}`);
    await job.configure({ model: { provider: "anthropic", modelId: OTHER } }, BACKGROUND_CONTEXT);
    await until(threads, thread.id, job.id, n => n.model === `anthropic/${OTHER}`, "a model change");
    await harness.commit(async tx => {
      const doc = await tx.doc(RlmChildDoc, job.id);
      doc.id = "child-1";
      doc.name = "relay page";
      doc.task = "Build the relay page.";
    }, BACKGROUND_CONTEXT);
    await until(threads, thread.id, job.id, n => n.name !== before.name && n.name.includes("relay page"), "a job's name");
  } finally {
    await threads.shutdown();
  }
});

test("a kept running node shows the retry flag once the run has retried past 5 minutes", async () => {
  const { threads, clock } = store("retry", Array.from({ length: 400 }, () => fauxAssistantMessage([], { stopReason: "error", errorMessage: OVERLOADED })));
  try {
    const thread = await threads.create({ name: "retry" });
    await threads.submit(thread.id, { text: "Build the relay page." });
    const running = await until(threads, thread.id, 1, n => n.status === "running", "a retrying run");
    assert.equal(running.retrying, undefined, "under 5 minutes there is no flag");
    clock.shift = RETRY_FLAG_MS + 1000;
    await until(threads, thread.id, 1, n => /^retrying since \d\d:\d\d: 529 overloaded$/.test(n.retrying ?? ""), "the retry flag");
    await threads.abort(thread.id);
  } finally {
    await threads.shutdown();
  }
});
