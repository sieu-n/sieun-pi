/**
 * A child conversation's task input is written by the conversation that owns it, so the search index credits it to that conversation and
 * never to the owner of the box. On 10-29 search on :5184 answered `from:owner` with 21 job briefs, such as "You are subagent G. ...", as
 * if the owner had typed them: children from before 8116f3dd got their task as a plain input, which the index read as the owner's.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Preamble } from "../../src/durable/open.ts";
import { ForegroundSubagent } from "../../src/durable/subagent.ts";
import { DurableThreads, taskAuthor } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-task-author-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const respond = ({ messages }: { messages: Message[] }) => {
  const users = messages.filter(m => m.role === "user").map(m => textOf(m.content));
  if (users.some(text => text.includes("count the otters"))) return fauxAssistantMessage("three otters");
  if (users.at(-1) === "delegate the otters" && messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("subagent", { task: "count the otters in the pond" })], { stopReason: "toolUse" });
  return fauxAssistantMessage("ok");
};

function models() {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const out = createModels();
  out.setProvider(faux.provider);
  return out;
}

const threadsAt = (durable: string) => new DurableThreads({ dir: durable, models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir });

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("an old-style subagent's task is its root's words in search, after a backfill and after a rebuild of the index", async () => {
  const durable = join(dir, "durable");
  let threads = threadsAt(durable);
  const thread = await threads.create({ name: "otters" });
  const file = threads.fileOf(thread.id);
  await threads.shutdown();

  // The thread's turn runs as before 8116f3dd: the foreground subagent submits its task to the child as a plain input.
  const registry = createRegistry();
  registry.install(Preamble);
  registry.install(ForegroundSubagent);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models: models(), registry }, context);
  const root = await harness.root(context);
  const settled = await (await root.submit({ type: "input", content: "delegate the otters" }, context)).wait(context);
  assert.equal(settled.status, "done");
  await harness.close(context);

  const check = async (what: string) => {
    await threads.entries(thread.id, { after: 0, limit: 1 });
    const task = await until(what, () => threads.search({ q: "pond" }).hits.find(hit => hit.conversation !== 1 && hit.kind === "pi.user"));
    assert.equal(task.author, taskAuthor(thread.id, 1), what);
    assert.equal(threads.search({ q: "pond", from: "owner" }).total, 0, `${what}: from:owner holds no task the root wrote`);
    assert.equal(threads.search({ q: "delegate", from: "owner" }).total, 1, `${what}: the owner's own input stays his`);
  };
  threads = threadsAt(durable);
  try {
    await threads.start();
    await check("the backfill");
  } finally {
    await threads.shutdown();
  }

  // An index from before task authors starts its search rows over, and the rebuild credits the task the same way.
  const old = new DatabaseSync(join(durable, "index.sqlite"));
  old.exec("UPDATE entries SET author = 'owner' WHERE kind = 'pi.user'; PRAGMA user_version = 0;");
  old.close();
  threads = threadsAt(durable);
  try {
    await threads.start();
    await check("the rebuild");
  } finally {
    await threads.shutdown();
  }
});
