/**
 * agent_observe.list_agents on a thread with thousands of rows. On 11-23 one list_agents built 2,558 rows in a single 5.1 s turn of pi-host's
 * event loop, and every command sent to pi-host in those seconds waited (~/work/pi-host-stalls/b-list-agents/report.md):
 * 1. A listing of 2,500 jobs and 200 open roots gives the loop a turn between rows, so a 10 ms timer never runs 100 ms late, and it keeps
 *    every row and every field the caller saw before.
 * 2. A conversation with a new entry shows it in the next listing, and an unchanged one keeps its row.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { DeliverTask, RlmChildDoc } from "../../src/durable/children.ts";
import { DurableRlm, type RlmThread } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { rlmOptions } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-list-agents-rows-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const JOBS = 2_500;
const ROOTS = 200;
/** The bound the stall goal sets for a cheap command while a listing runs is 300 ms; a 10 ms timer here may run at most 100 ms late. */
const LATE_MS = 100;
/** The fields of a job's row, as the listing gave them before it gave the loop turns. */
const JOB_FIELDS = [
  "activeSessionId", "activity", "attachedClients", "cwd", "firstMessage", "isCompacting", "isCurrent", "isSessionActive", "isStreaming", "latestMessage",
  "messageCount", "parentActiveSessionId", "parentSessionId", "queuedCount", "relationship", "repliedSinceTask", "runtimeKind", "sessionId", "sessionName", "status",
];
/** The fields of another open root's row. */
const ROOT_FIELDS = [
  "activeSessionId", "activity", "attachedClients", "children", "cwd", "firstMessage", "isCompacting", "isCurrent", "isSessionActive", "isStreaming", "kind",
  "latestMessage", "messageCount", "queuedCount", "relationship", "runtimeKind", "sessionId", "sessionName", "status",
];

const user = (text: string) => ({ kind: "pi.message", model: [{ role: "user", content: text, timestamp: 0 }] }) as never;
const answer = (text: string) => ({ kind: "pi.message", model: [fauxAssistantMessage(text)] }) as never;

type Row = Record<string, unknown> & { sessionId: string; sessionName: string; messageCount?: number; latestMessage?: { text?: string } };
/** The host request a kernel's `agent_observe.list_agents()` sends, called the way the kernel's relay calls it. */
interface Requests {
  slot(thread: RlmThread, conversation: number): unknown;
  hostRequest(slot: unknown, request: { type: string }): Promise<{ current: Row; agents: Row[] }>;
  threads: Map<string, RlmThread>;
}

let rlm: DurableRlm;
let threads: DurableThreads;
before(async () => {
  rlm = await DurableRlm.load(rlmOptions(dir));
  threads = new DurableThreads({
    dir: join(dir, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null, rlm,
    models: () => {
      const models = createModels();
      models.setProvider(fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] }).provider);
      return models;
    },
  });
});
after(async () => {
  await threads?.shutdown();
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const harnessOf = async (id: string) => (await (threads as unknown as { thread(id: string): Promise<{ harness: Harness }> }).thread(id)).harness;

/** `count` job conversations of the root, each with a task, a done status and two messages. */
async function addJobs(harness: Harness, thread: string, count: number): Promise<number[]> {
  return harness.commit(async tx => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      // A delivery to no conversation ends at once, so the job owns its conversation and nothing runs in it.
      const task = await tx.createTask(DeliverTask, {
        parent: ROOT_CONVERSATION_ID, child: 0, thread, name: `job ${i}`, content: "", from: thread, via: "rlm.spawn", requestId: `rlm-task:${i}`, whenBusy: "steer",
      }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
      const job = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
      Object.assign(await tx.doc(RlmChildDoc, job.id), { id: `sub-${i}`, name: `job ${i}`, task: `Build page ${i}.`, createdAt: 1, status: "done" });
      await tx.appendEntry(job.id, user(`[task from parent]\n\nBuild page ${i}.`));
      await tx.appendEntry(job.id, answer(`Page ${i} is built.`));
      ids.push(job.id);
    }
    return ids;
  }, BACKGROUND_CONTEXT);
}

/** One list_agents of the work thread's root, with how late a 10 ms timer ran while it went. */
async function listed(work: string): Promise<{ rows: Row[]; lateMs: number; ms: number }> {
  const requests = rlm as unknown as Requests;
  const slot = requests.slot(requests.threads.get(work)!, ROOT_CONVERSATION_ID);
  let lateMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lateMs = Math.max(lateMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    const out = await requests.hostRequest(slot, { type: "agent_observe.list" });
    lateMs = Math.max(lateMs, performance.now() - last - 10);
    return { rows: out.agents, lateMs, ms: performance.now() - start };
  } finally {
    clearInterval(timer);
  }
}

test("a listing of 2,500 jobs and 200 open roots keeps every row and field and never holds the loop 100 ms", { timeout: 300_000 }, async () => {
  const work = await threads.create({ name: "work" });
  const harness = await harnessOf(work.id);
  const jobs = await addJobs(harness, work.id, JOBS);
  const roots: string[] = [];
  for (let i = 0; i < ROOTS; i++) {
    const root = await threads.create({ name: `root ${String(i).padStart(3, "0")}` });
    await (await harnessOf(root.id)).commit(async tx => {
      for (let n = 0; n < 10; n++) await tx.appendEntry(ROOT_CONVERSATION_ID as ConversationId, n % 2 ? answer(`Answer ${n} of root ${i}.`) : user(`Ask ${n} of root ${i}.`));
    }, BACKGROUND_CONTEXT);
    roots.push(root.id);
  }

  const first = await listed(work.id);
  console.log(`list_agents: ${first.rows.length} rows in ${Math.round(first.ms)} ms, the timer ran at most ${Math.round(first.lateMs)} ms late`);
  assert.equal(first.rows.length, JOBS + ROOTS);
  const byId = new Map(first.rows.map(row => [row.sessionId, row]));
  for (const [i, id] of jobs.entries()) {
    const row = byId.get(`${work.id}:${id}`);
    assert.ok(row, `job ${i} has a row`);
    assert.deepEqual(Object.keys(row).sort(), JOB_FIELDS);
    assert.equal(row.relationship, "child");
    assert.equal(row.messageCount, 2);
    assert.equal(row.firstMessage, `Build page ${i}.`);
    assert.equal(row.latestMessage?.text, `Page ${i} is built.`);
    assert.equal(row.repliedSinceTask, false);
  }
  for (const [i, id] of roots.entries()) {
    const row = byId.get(id);
    assert.ok(row, `root ${i} has a row`);
    assert.deepEqual(Object.keys(row).sort(), ROOT_FIELDS);
    assert.equal(row.relationship, "sibling");
    assert.equal(row.messageCount, 10);
    assert.equal(row.firstMessage, `Ask 0 of root ${i}.`);
    assert.equal(row.latestMessage?.text, `Answer 9 of root ${i}.`);
  }
  assert.ok(first.lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(first.lateMs)} ms late while list_agents built ${first.rows.length} rows`);

  const job = jobs[7]!;
  await harness.commit(async tx => { await tx.appendEntry(job as ConversationId, user("Add a footer.")); }, BACKGROUND_CONTEXT);
  await (await harnessOf(roots[3]!)).commit(async tx => { await tx.appendEntry(ROOT_CONVERSATION_ID as ConversationId, answer("Root 3 has news.")); }, BACKGROUND_CONTEXT);
  const second = await listed(work.id);
  assert.ok(second.lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(second.lateMs)} ms late in the second listing`);
  const changed = new Map(second.rows.map(row => [row.sessionId, row]));
  const jobRow = changed.get(`${work.id}:${job}`)!;
  assert.equal(jobRow.messageCount, 3);
  assert.equal(jobRow.latestMessage?.text, "Add a footer.");
  const rootRow = changed.get(roots[3]!)!;
  assert.equal(rootRow.messageCount, 11);
  assert.equal(rootRow.latestMessage?.text, "Root 3 has news.");
  const unchanged = (rows: Row[]) => rows.filter(row => row.sessionId !== `${work.id}:${job}` && row.sessionId !== roots[3]);
  assert.deepEqual(unchanged(second.rows), unchanged(first.rows));
});
