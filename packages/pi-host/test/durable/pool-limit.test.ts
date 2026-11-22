/**
 * A run whose requests meet transient errors keeps retrying with backoff and answers. On 10-29 at 08:03 KST agent factory's run met
 * five 429s from the pool's one account in a row, and on 11-22 the Fable auditor's turn on the owner's post 43 met four
 * `lock_wait_timeout` answers from the token hook in 164 s (thread d41329f0, task 12); pi-durable ended both as failed on its retry count.
 * Here the runs meet 429s, 529s and hook failures past that count and must still answer, and a 400 still ends the run at once.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableSettings, poolProvider } from "@sieun-pi/pi-pool/durable";
import { Preamble } from "../../src/durable/open.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_POOL = join(here, "..", "..", "..", "pi-pool", "test", "fake-pool.mjs");
const dir = mkdtempSync(join(tmpdir(), "pi-host-pool-limit-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.FAKE_POOL_DIR = dir;
const LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

const BAD_IMAGE = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.426.content.1.image.source.base64.media_type: Input should be \'image/jpeg\', \'image/png\', \'image/gif\' or \'image/webp\'"}}';

async function run(name: string, answers: Array<"limit" | "overloaded" | "bad" | "ok">, pool: { failTimes?: number; failReason?: string } = {}) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ accounts: ["only"], current: 0, slotAfterSec: 0.05, ...pool }));
  const treeKey = `pi-durable:${name}`;
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let sent = 0;
  faux.setResponses(answers.map(kind => () => {
    sent++;
    if (kind === "limit") return fauxAssistantMessage([], { stopReason: "error", errorMessage: LIMIT });
    if (kind === "bad") return fauxAssistantMessage([], { stopReason: "error", errorMessage: BAD_IMAGE });
    if (kind === "overloaded") return fauxAssistantMessage([], { stopReason: "error", errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    return fauxAssistantMessage("The answer after the waits.");
  }));
  const models = createModels();
  models.setProvider(poolProvider({ treeKey, bin: FAKE_POOL, inner: faux.provider }));
  const registry = createRegistry();
  registry.install(Preamble);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${name}.sqlite`)), { models, registry, settings: durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  const settled = await (await root.submit({ type: "input", content: "How is the relay?" }, context)).wait(context);
  const entries = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return { settled, sent, entries };
}

const lastText = (entries: Awaited<ReturnType<typeof run>>["entries"]): string => {
  const last = entries.at(-1)?.model?.[0];
  assert.equal(last?.role, "assistant");
  return textOf(last && "content" in last ? last.content : []);
};

test("a run that meets eight pool-handled 429s in a row waits on the pool and answers", async () => {
  const { settled, sent, entries } = await run("limits", [...Array(8).fill("limit"), "ok"]);
  assert.equal(settled.status, "done");
  assert.equal(sent, 9);
  assert.equal(lastText(entries), "The answer after the waits.");
});

test("a run that meets more 529s than pi-durable's default 3 retries keeps retrying and answers", async () => {
  const { settled, sent, entries } = await run("overloaded", [...Array(6).fill("overloaded"), "ok"]);
  assert.equal(settled.status, "done");
  assert.equal(sent, 7, "the first request, six retries after a 529 each, and the answer");
  assert.equal(lastText(entries), "The answer after the waits.");
});

test("a token hook that fails with lock_wait_timeout retries the hook and the turn answers", async () => {
  const { settled, sent, entries } = await run("lock-wait", ["ok"], { failTimes: 1, failReason: "lock_wait_timeout" });
  assert.equal(settled.status, "done");
  assert.equal(sent, 1, "the failed vend sent nothing, and the retry sent the one request");
  const failed = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "assistant" && message.stopReason === "error");
  assert.match(String(failed[0] && "errorMessage" in failed[0] ? failed[0].errorMessage : ""), /lock_wait_timeout/);
  assert.equal(lastText(entries), "The answer after the waits.");
});

test("a 400 such as a bad image media type ends the run at once with no retry", async () => {
  const { settled, sent } = await run("bad-image", ["bad", "ok"]);
  assert.equal(settled.status, "unanswered");
  assert.equal(sent, 1);
  assert.equal(settled.status === "unanswered" ? settled.reason : "", "model_error");
});
