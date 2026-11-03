/**
 * Prime's thread goal in durable threads (`goal.ts`), driven through real kernel cells of the `goal` Python module:
 * 1. `goal.create` starts an active goal, the settled run gets one `[goal: continuation]` input from "goal", `goal.complete()` charges the
 *    turns spent on the goal and ends the continuations, and the goal is still there after pi-host restarts.
 * 2. A run that crosses the token budget marks the goal budget_limited and gets one `[goal: budget-limit]` input and no continuation, and
 *    `goal.create` refuses with Prime's text while it is pending.
 * 3. A run that ends with a live `bash()` handle gets no continuation; the run its bash-done notice starts gets it.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { GoalDoc, goalObjective } from "../../src/durable/goal.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, context, inputs, results, rlmOptions, say, textOf, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-goal-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

let rlm: DurableRlm;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** The model's answer to the newest input: a cell the first time, then a line once the cell's result is in. */
function model(messages: Message[]): ReturnType<typeof say> {
  const at = messages.findLastIndex(m => m.role === "user");
  const text = at < 0 ? "" : textOf(messages[at]!.content as never);
  const answered = messages.slice(at + 1).some(m => m.role === "toolResult");
  const step = (code: string, line: string) => (answered ? say(line) : cell(code));
  if (text === "start a goal") {
    return step("try:\n    await goal.complete()\nexcept Exception as e:\n    print('refused:', e)\nr = await goal.create('finish the report', token_budget=10**9)\nprint(r['goal']['status'])", "goal set");
  }
  if (text === "start a tiny goal") return step("r = await goal.create('a tiny goal', token_budget=1)\nprint(r['goal']['status'], r['remaining_tokens'])", "tiny set");
  if (text === "start a goal and a job") return step("await goal.create('wait for the job')\nh = bash('sleep 2; echo hi')", "waiting for the job");
  if (text === "try again") {
    return step("try:\n    await goal.create('another')\nexcept Exception as e:\n    print('refused:', e)", "refused");
  }
  if (text === "status?") return step("import json\nprint(json.dumps(await goal.get()))", "status read");
  if (text.startsWith("[goal: continuation]")) return step("import json\nprint(json.dumps(await goal.complete()))", "done");
  if (text.startsWith("[goal: budget-limit]")) return step("import json\nprint(json.dumps(await goal.get()))", "wrapping up");
  if (text.startsWith("[bash-done")) return say("job noted");
  return say("ok");
}

function newThreads(): DurableThreads {
  return new DurableThreads({
    dir: join(dir, "threads"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 50 }, () => ({ messages }: { messages: Message[] }) => model(messages)));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
}

const entriesOf = async (threads: DurableThreads, id: string): Promise<EntryRecord[]> => (await threads.entries(id, { after: 0, limit: 500 })).entries;
const goalInputs = (entries: readonly EntryRecord[]) => inputs(entries).filter(i => i.data?.from === "goal");
const said = (entries: readonly EntryRecord[], line: string) => entries.some(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "assistant" && textOf(message.content as never) === line;
});
/** Submits an input and waits for its run to settle. */
async function ask(threads: DurableThreads, id: string, text: string): Promise<void> {
  const submitted = await threads.submit(id, { text });
  assert.equal((await threads.wait(id, submitted.submission)).status, "done");
}
const usageOf = (entry: EntryRecord): number => {
  const usage = (entry.model?.[0] as { usage?: { input: number; output: number } } | undefined)?.usage;
  return (usage?.input ?? 0) + (usage?.output ?? 0);
};

test("a goal gets one continuation, completion charges the turns spent on it, and the goal survives a restart", { timeout: 120_000 }, async () => {
  let threads = newThreads();
  let id = "";
  try {
    ({ id } = await threads.create({ name: "goal" }));
    await ask(threads, id, "start a goal");
    await until("the goal's continuation and its done", async () => said(await entriesOf(threads, id), "done"), 30_000);
    // A later input settles after the done run's settle, so a second continuation would be in by then.
    await ask(threads, id, "status?");
    const entries = await entriesOf(threads, id);
    const sent = goalInputs(entries);
    assert.equal(sent.length, 1, sent.map(i => i.text.split("\n")[0]).join(" | "));
    assert.equal(sent[0]!.data?.via, "goal-continuation");
    assert.match(sent[0]!.text, /^\[goal: continuation\]\n\nContinue working toward the active thread goal\.[\s\S]*<objective>\nfinish the report\n<\/objective>/);
    const out = results(entries).map(r => r.text.trim());
    assert.match(out[0]!, /^refused: cannot complete goal because this thread has no goal\nactive$/);
    const completed = JSON.parse(out[1]!) as { goal: { status: string; tokens_used: number; token_budget: number }; remaining_tokens: number; completion_budget_report: string };
    // Charged: the "goal set" line and the cell that completes the goal; not the cell that created it, nor anything after the completion.
    const assistants = entries.filter(e => (e.model?.[0] as Message | undefined)?.role === "assistant");
    const spent = usageOf(assistants[1]!) + usageOf(assistants[2]!);
    assert.ok(spent > 0);
    assert.equal(completed.goal.status, "complete");
    assert.equal(completed.goal.tokens_used, spent);
    assert.equal(completed.remaining_tokens, 10 ** 9 - spent);
    assert.match(completed.completion_budget_report, new RegExp(`^Goal achieved\\. Report final budget usage to the user: tokens used: ${spent} of 1000000000`));
    assert.equal((JSON.parse(out[2]!) as { goal: { tokens_used: number } }).goal.tokens_used, spent);
  } finally {
    await threads.shutdown();
  }
  threads = newThreads();
  try {
    const { harness } = await threads.thread(id);
    assert.equal(await goalObjective(harness, 1), "finish the report");
    assert.equal((await harness.snapshot(GoalDoc, 1 as ConversationId, context))?.goal?.status, "complete");
  } finally {
    await threads.shutdown();
  }
});

test("a run that crosses the budget gets one budget-limit input and no continuation, and create refuses with Prime's text", { timeout: 120_000 }, async () => {
  const threads = newThreads();
  try {
    const { id } = await threads.create({ name: "goal budget" });
    await ask(threads, id, "start a tiny goal");
    await until("the budget-limit answer", async () => said(await entriesOf(threads, id), "wrapping up"), 30_000);
    await ask(threads, id, "try again");
    const entries = await entriesOf(threads, id);
    const sent = goalInputs(entries);
    assert.deepEqual(sent.map(i => i.data?.via), ["goal-budget-limit"]);
    assert.match(sent[0]!.text, /^\[goal: budget-limit\]\n\nThe active thread goal has reached its token budget\.[\s\S]*- status: budget_limited\n- tokens used: [1-9]\d*\n- token budget: 1\n/);
    const out = results(entries).map(r => r.text.trim());
    assert.equal(out[0], "active 1");
    const limited = JSON.parse(out[1]!) as { goal: { status: string }; remaining_tokens: number };
    assert.equal(limited.goal.status, "budget_limited");
    assert.equal(limited.remaining_tokens, 0);
    assert.equal(out[2], "refused: cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear");
  } finally {
    await threads.shutdown();
  }
});

test("a run that ends with a live bash() handle waits for the bash-done run to get its continuation", { timeout: 120_000 }, async () => {
  const threads = newThreads();
  try {
    const { id } = await threads.create({ name: "goal job" });
    await ask(threads, id, "start a goal and a job");
    await until("the continuation's done", async () => said(await entriesOf(threads, id), "done"), 30_000);
    await ask(threads, id, "status?");
    const order = inputs(await entriesOf(threads, id)).map(i => i.text.split("\n")[0]!.replace(/^\[bash-done.*/, "[bash-done]"));
    assert.deepEqual(order, ["start a goal and a job", "[bash-done]", "[goal: continuation]", "status?"]);
  } finally {
    await threads.shutdown();
  }
});
