/**
 * A durable turn names its model to the pool, and the pool's no_model_room setting decides what a turn does when no
 * account with room serves that model. From 10-30 22:32Z to 11-01 12:00Z pi-durable:4a871e83 on gpt-6.1-sol took the free
 * Codex account ungsugoe5, whose plan lacks the model, and each turn failed in about 1 s, since this provider never named
 * the model. fake-pool.mjs stands in for the hook: `modelWait` waits a request on one model, `final` ends the turn, and
 * `switchModels` lists the models of an account that lacks the request's.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createRegistry, Harness, type LiveState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableSettings, poolProvider } from "../src/durable/pool-provider.ts";

const context = BACKGROUND_CONTEXT;
const FAKE_POOL = fileURLToPath(new URL("./fake-pool.mjs", import.meta.url));
const MODEL = { provider: "anthropic", modelId: "gpt-6.1-sol" };
const OTHER = "gpt-6-sol-mini";
const dir = mkdtempSync(join(tmpdir(), "pi-pool-durable-model-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.FAKE_POOL_DIR = dir;

interface Call { argv: string[]; model: string | null }
const calls = (): Call[] => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Call);
const vends = (): Call[] => calls().filter(c => c.argv[0] === "--provider");

function rig(name: string, pool: Record<string, unknown>) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ accounts: ["free"], current: 0, ...pool }));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const treeKey = `pi-durable:${name}`;
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }, { id: OTHER }], tokensPerSecond: 0 });
  const ran: string[] = [];
  faux.setResponses(Array.from({ length: 4 }, () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
    ran.push(model.id);
    return fauxAssistantMessage(`answered on ${model.id}`);
  }));
  const open = async () => {
    const models = createModels();
    models.setProvider(poolProvider({ treeKey, bin: FAKE_POOL, inner: faux.provider }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${name}.sqlite`)), { models, registry: createRegistry(), settings: durableSettings(treeKey, { baseDelayMs: 5, maxAgentDelayMs: 20 }) }, context);
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    return { harness, root };
  };
  return { open, ran };
}

async function lastAssistant(root: Awaited<ReturnType<ReturnType<typeof rig>["open"]>>["root"]): Promise<AssistantMessage | undefined> {
  const entries = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  return entries.map(e => e.model?.[0]).filter((m): m is AssistantMessage => m?.role === "assistant").at(-1);
}

test("a turn on a model only a full account serves sleeps on the slot, survives a restart and runs when the slot opens", async () => {
  const until = Date.now() / 1000 + 3;
  const { open, ran } = rig("wait", { modelWait: { [MODEL.modelId]: until } });
  const first = await open();
  const watch = await first.root.watch(context);
  const deferred = new Promise<number>(resolve => watch.start(async value => {
    const pollAt = (value.docs["pi.live"] as LiveState | undefined)?.generation?.deferred?.pollAt;
    if (pollAt !== undefined) resolve(pollAt);
  }));
  const submission = await first.root.submit({ type: "input", content: "Which model?", requestId: "wait-1" }, context);
  const ranFirst = submission.wait(context).then(() => assert.fail("the turn ran with no slot wait"));
  assert.ok((await Promise.race([deferred, ranFirst])) > Date.now(), "the turn sleeps until a later poll");
  await watch.stop();
  await first.harness.close(context);
  assert.deepEqual(ran, [], "nothing ran before the restart");
  assert.ok(vends().every(c => c.model === MODEL.modelId), JSON.stringify(vends()));

  writeFileSync(join(dir, "calls.jsonl"), "");
  const second = await open();
  second.harness.resume();
  const settled = await (await second.root.submit({ type: "input", content: "Which model?", requestId: "wait-1" }, context)).wait(context);
  await second.harness.waitForIdle(context);
  assert.equal(settled.status, "done");
  assert.deepEqual(ran, [MODEL.modelId]);
  assert.ok(Date.now() / 1000 >= until);
  assert.ok(vends().length >= 2, "the poll after the restart and the request each asked the hook");
  assert.ok(vends().every(c => c.model === MODEL.modelId), JSON.stringify(vends()));
  await second.harness.close(context);
});

test("no_model_room fail ends the turn with the pool's reason and no retry", async () => {
  const text = `pi-pool: no openai-codex account with room serves ${MODEL.modelId}, and no_model_room is fail: free@x does not serve ${MODEL.modelId}, pro@x has its first free slot at 2026-11-03T10:00:00Z.`;
  const { open, ran } = rig("fail", { final: text });
  const { harness, root } = await open();
  await (await root.submit({ type: "input", content: "Which model?" }, context)).wait(context);
  const last = await lastAssistant(root);
  await harness.close(context);
  assert.deepEqual(ran, []);
  assert.equal(last?.stopReason, "error");
  assert.equal(last?.errorMessage, text);
  assert.equal(isRetryableAssistantError(last!), false);
  assert.equal(vends().length, 1, "the hook ran once");
});

test("no_model_room switch runs the request on the first listed model the provider knows", async () => {
  const { open, ran } = rig("switch", { switchModels: ["gpt-unknown", OTHER] });
  const { harness, root } = await open();
  const settled = await (await root.submit({ type: "input", content: "Which model?" }, context)).wait(context);
  const last = await lastAssistant(root);
  await harness.close(context);
  assert.equal(settled.status, "done");
  assert.deepEqual(ran, [OTHER]);
  assert.equal(last?.model, OTHER);
  assert.equal(vends()[0]?.model, MODEL.modelId);
});

test("a request that asks for no deferred answer, as compaction's summary does, waits in the request and runs at the slot", async () => {
  const until = Date.now() / 1000 + 2;
  writeFileSync(join(dir, "state.json"), JSON.stringify({ accounts: ["free"], current: 0, modelWait: { [MODEL.modelId]: until } }));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  const seen: unknown[] = [];
  faux.setResponses(Array.from({ length: 2 }, () => (_context: unknown, options: { deferred?: unknown } | undefined) => {
    seen.push(options?.deferred);
    return fauxAssistantMessage("summary");
  }));
  const provider = poolProvider({ treeKey: "pi-durable:inline", bin: FAKE_POOL, inner: faux.provider });
  const model = faux.provider.getModels()[0]!;
  const ask = { messages: [{ role: "user", content: "Summarize.", timestamp: Date.now() }] } as unknown as Parameters<typeof provider.streamSimple>[1];

  const deferred = await provider.streamSimple(model, ask, { sessionId: "inline", deferred: true }).result();
  assert.equal(deferred.stopReason, "deferred", "a generation, which asks for deferred answers, gets the wait back to store");

  const inline = await provider.streamSimple(model, ask, { sessionId: "inline" }).result();
  assert.equal(inline.stopReason, "stop", inline.errorMessage);
  assert.ok(Date.now() / 1000 >= until, "the request waited for the slot");
  assert.deepEqual(seen, [undefined], "the inner provider never sees the deferred ask");
});
