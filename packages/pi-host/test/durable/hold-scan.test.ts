/**
 * A delivery's `hold` phase (children.ts) reads only the tasks that are not over yet, so a parent conversation with a long past holds the
 * loop no longer than a new one. Before, each hold ran ten scans named by conversation, kind and status, which SQLite answered by walking
 * every task of the conversation: 72ba1ed2's root had 5,640 tasks on 11-23, each scan took 14 to 80 ms, and the holds that resumed after a
 * pi-host restart held the loop for seconds (~/work/pi-host-stalls/h-restart-resume/report.md).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-hold-scan-"));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Past tasks of the root conversation, 44 times the 5,640 of 72ba1ed2's root on 11-23. On us-metal02 at load average 140 the longest loop
 * turn of a subagent call was 545 and 597 ms on the old hold, and 76 to 88 ms on the new one, which reads none of them.
 */
const PAST_TASKS = 250_000;
/**
 * The time a subagent call may spend in task scans, which run in one loop turn per hold. The test sums the scans' own time, because a loop
 * turn also holds other work and the box's load: at load average 628 one new-code run had a 483 ms turn.
 */
const SCAN_BOUND_MS = 100;

/** The ms node:sqlite spent in task scans while `scanning.on` is set. */
const scanning = { on: false, ms: 0, count: 0 };
const all = StatementSync.prototype.all;
Object.defineProperty(StatementSync.prototype, "all", {
  value: function (this: StatementSync, ...params: unknown[]) {
    if (!scanning.on || !/FROM\s+"?\w*tasks"?\s+WHERE/.test(this.sourceSQL)) return Reflect.apply(all, this, params);
    const start = performance.now();
    try {
      return Reflect.apply(all, this, params);
    } finally {
      scanning.ms += performance.now() - start;
      scanning.count++;
    }
  },
});

const lastUser = (messages: readonly Message[]) => textOf(([...messages].reverse().find(m => m.role === "user")?.content ?? "") as never);

/** The root's `[subagent-answer ...]` inputs once there are `count` of them. */
async function answered(threads: DurableThreads, id: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const inputs = (await threads.entries(id, { after: 0, limit: 500 })).entries
      .flatMap(entry => (entry.model ?? []) as Message[])
      .filter(message => message.role === "user")
      .map(message => textOf(message.content as never))
      .filter(text => text.startsWith("[subagent-answer"));
    if (inputs.length >= count) return inputs;
    if (Date.now() > deadline) throw new Error(`${inputs.length} of ${count} subagent answers came: ${JSON.stringify(inputs)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function open(): DurableThreads {
  return new DurableThreads({
    dir: join(dir, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 20 }, () => ({ messages }: { messages: Message[] }) => {
        if (lastUser(messages) === "child task") return fauxAssistantMessage("child answer");
        if (lastUser(messages) === "delegate" && messages.at(-1)?.role !== "toolResult") {
          return fauxAssistantMessage([fauxToolCall("subagent", { task: "child task" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("ok");
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: dir,
    primeRoots: null,
  });
}

test("a subagent's hold on a root with 250,000 past tasks scans tasks for under 100 ms, with the same answer", { timeout: 120_000 }, async t => {
  let threads = open();
  const { id } = await threads.create({ name: "long past" });
  const ask = async (text: string) => {
    const { submission } = await threads.submit(id, { text });
    assert.equal((await threads.wait(id, submission)).status, "done");
  };
  await ask("delegate");
  await answered(threads, id, 1);
  await threads.shutdown();

  // The root's past: terminal tool tasks, written straight into the closed file, with ids far above any the thread hands out here.
  const db = new DatabaseSync(threads.fileOf(id));
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, 'terminal', 0, 0, ?)");
  for (let i = 0; i < PAST_TASKS; i++) {
    const taskId = 10_000_000 + i;
    insert.run(taskId, ROOT_CONVERSATION_ID, JSON.stringify("pi.tool"), JSON.stringify({ id: taskId, conversationId: ROOT_CONVERSATION_ID, kind: "pi.tool", version: 1, input: {}, background: false, abortRequested: false, state: {}, startedAt: 0, memos: {} }));
  }
  db.exec("COMMIT");
  db.close();

  threads = open();
  try {
    // One subagent call first, so the code paths a first call compiles and loads are warm when the timer runs.
    await ask("delegate");
    await answered(threads, id, 2);
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last - 2);
      last = now;
    }, 2);
    let answers: string[];
    scanning.on = true;
    try {
      await ask("delegate");
      answers = await answered(threads, id, 3);
    } finally {
      scanning.on = false;
      clearInterval(timer);
    }
    t.diagnostic(`${scanning.count} task scans took ${Math.round(scanning.ms)} ms; the longest loop turn was ${Math.round(longest)} ms`);
    for (const answer of answers) assert.equal(answer, "[subagent-answer child:child task]\n\nchild answer");
    assert.ok(scanning.ms < SCAN_BOUND_MS, `${scanning.count} task scans took ${Math.round(scanning.ms)} ms`);
  } finally {
    await threads.shutdown();
  }
});
