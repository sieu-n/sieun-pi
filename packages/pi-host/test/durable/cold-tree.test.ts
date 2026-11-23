/**
 * A cold `durable_tree`: the first tree read of a thread file that is not open, which opens it (`backfill`) and builds a node per
 * conversation. On 11-23 a cold open plus tree of 72ba1ed2's 445 conversations held pi-host's loop 369 ms and then 424 ms in one go, because
 * both read each conversation's first entries and so its 88 KB `pi.system` prompt (~/work/pi-host-stalls/e-cold-tree/report.md). The read
 * must give the loop a turn between conversations, so a 10 ms timer never runs 100 ms late, and keep every node and field.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { DeliverTask, RlmChildDoc } from "../../src/durable/children.ts";
import { jobTitle } from "../../src/durable/job-title.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import type { TreeNode } from "../../src/durable/index.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-cold-tree-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const JOBS = 450;
/** The bound the stall goal sets for a cheap command during a read is 300 ms; a 10 ms timer here may run at most 100 ms late. */
const LATE_MS = 100;
/** A job's system prompt, as long as the 88 KB `pi.system` entry of every job on 11-23. */
const SYSTEM = { kind: "pi.system", model: [{ role: "system", content: "You are a job. ".repeat(6_000) }] } as never;
const at = (i: number) => 1_700_000_000_000 + i * 1000;
const task = (i: number) => `[task from parent]\n\nBuild page ${i} of the relay site.`;

const threads = new DurableThreads({
  dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
  models: () => {
    const models = createModels();
    models.setProvider(fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] }).provider);
    return models;
  },
});
after(() => threads.shutdown());

const harnessOf = async (id: string) => (await (threads as unknown as { thread(id: string): Promise<{ harness: Harness }> }).thread(id)).harness;

/**
 * `JOBS` jobs of the root, each owning its conversation through a task, with a task input and the long system prompt after it. Every third
 * job's task is an agent message and the others' a typed input; every fifth has a spawn name. Job 3's first entry is its system prompt,
 * so its title comes from the second, and one more conversation is a fork of job 0 at its task.
 */
async function addJobs(harness: Harness, thread: string): Promise<{ id: number; name: string; createdAt: number }[]> {
  let forkAt: EntryId | undefined;
  const jobs = await harness.commit(async tx => {
    const jobs: { id: number; name: string; createdAt: number }[] = [];
    for (let i = 0; i < JOBS; i++) {
      const owner = await tx.createTask(DeliverTask, {
        parent: ROOT_CONVERSATION_ID, child: 0, thread, name: `job ${i}`, content: "", from: thread, via: "rlm.spawn", requestId: `rlm-task:${i}`, whenBusy: "steer",
      }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
      const job = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      const input = { kind: i % 3 === 0 ? "agent.message" : "pi.user", model: [{ role: "user", content: task(i), timestamp: at(i) }], ...(i % 3 === 0 ? { data: { from: thread } } : {}) } as never;
      if (i === 3) await tx.appendEntry(job.id, SYSTEM);
      const first = await tx.appendEntry(job.id, input);
      if (i !== 3) await tx.appendEntry(job.id, SYSTEM);
      if (i === 0) forkAt = first.id;
      if (i % 5 === 0) Object.assign(await tx.doc(RlmChildDoc, job.id), { id: `sub-${i}`, name: `page ${i}`, task: task(i), createdAt: 1, status: "done" });
      jobs.push({ id: job.id, name: i % 5 === 0 ? `page ${i}` : jobTitle(task(i)), createdAt: at(i) });
    }
    return jobs;
  }, BACKGROUND_CONTEXT);
  const fork = await harness.commit(tx => tx.forkConversation(jobs[0]!.id as ConversationId, forkAt!, { ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
  return [...jobs, { id: fork.id, name: jobTitle(task(0)), createdAt: at(0) }];
}

/** A tree read with how late a 10 ms timer ran while it went. */
async function timedTree(thread: string): Promise<{ nodes: TreeNode[]; lateMs: number; ms: number }> {
  let lateMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lateMs = Math.max(lateMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    const nodes = await threads.tree(thread);
    lateMs = Math.max(lateMs, performance.now() - last - 10);
    return { nodes, lateMs, ms: performance.now() - start };
  } finally {
    clearInterval(timer);
  }
}

test("a cold tree of 450 jobs opens the file and builds every node, and never holds the loop 100 ms", { timeout: 300_000 }, async () => {
  const work = await threads.create({ name: "work" });
  const jobs = await addJobs(await harnessOf(work.id), work.id);
  const warm = await threads.tree(work.id);
  await threads.closeThread(work.id, "test");

  const cold = await timedTree(work.id);
  console.log(`cold tree: ${cold.nodes.length} nodes in ${Math.round(cold.ms)} ms, the timer ran at most ${Math.round(cold.lateMs)} ms late`);
  assert.deepEqual(cold.nodes, warm, "a cold read gives the tree an open file gave");
  assert.equal(cold.nodes.length, JOBS + 2);
  const byId = new Map(cold.nodes.map(node => [node.id, node]));
  assert.equal(byId.get(ROOT_CONVERSATION_ID)?.name, "work");
  for (const job of jobs) {
    const node = byId.get(job.id);
    assert.ok(node, `job ${job.id} has a node`);
    assert.equal(node.name, job.name, `job ${job.id}'s name`);
    assert.equal(node.createdAt, job.createdAt, `job ${job.id}'s time`);
    assert.equal(node.status, "idle");
  }
  assert.ok(cold.lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(cold.lateMs)} ms late while a cold tree built ${cold.nodes.length} nodes`);
});
