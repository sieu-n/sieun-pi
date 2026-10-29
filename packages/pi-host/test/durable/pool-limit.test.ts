/**
 * A run whose requests meet the pool's limits waits on the pool and answers. On 10-29 at 08:03 KST agent factory's run met
 * five 429s from the pool's one account in a row, and pi-durable ended it as failed at attempt 5, because each pool-handled
 * retry spent its budget. Here the faux provider answers 429 eight times, the fake pool marks the one account and names a
 * slot each time, and the run must still answer, while a real error after that still ends a run on pi-durable's own count.
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
import { durableSettings, poolProvider, pooledRetries } from "@sieun-pi/pi-pool/durable";
import { Preamble } from "../../src/durable/open.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_POOL = join(here, "..", "..", "..", "pi-pool", "test", "fake-pool.mjs");
const dir = mkdtempSync(join(tmpdir(), "pi-host-pool-limit-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.FAKE_POOL_DIR = dir;
const LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

async function run(name: string, answers: Array<"limit" | "overloaded" | "ok">) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ accounts: ["only"], current: 0, slotAfterSec: 0.05 }));
  const treeKey = `pi-durable:${name}`;
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let sent = 0;
  faux.setResponses(answers.map(kind => () => {
    sent++;
    if (kind === "limit") return fauxAssistantMessage([], { stopReason: "error", errorMessage: LIMIT });
    if (kind === "overloaded") return fauxAssistantMessage([], { stopReason: "error", errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    return fauxAssistantMessage("The answer after the waits.");
  }));
  const models = createModels();
  models.setProvider(poolProvider({ treeKey, bin: FAKE_POOL, inner: faux.provider }));
  const registry = createRegistry();
  registry.install(Preamble);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${name}.sqlite`)), { models, registry, settings: durableSettings(treeKey, { baseDelayMs: 5, maxAgentDelayMs: 20 }) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  const settled = await (await root.submit({ type: "input", content: "How is the relay?" }, context)).wait(context);
  const entries = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return { settled, sent, entries, treeKey };
}

test("a run that meets eight pool-handled 429s in a row waits on the pool and answers", async () => {
  const { settled, sent, entries, treeKey } = await run("limits", [...Array(8).fill("limit"), "ok"]);
  assert.equal(settled.status, "done");
  assert.equal(sent, 9);
  const last = entries.at(-1)?.model?.[0];
  assert.equal(last?.role, "assistant");
  assert.equal(textOf(last && "content" in last ? last.content : []), "The answer after the waits.");
  assert.equal(pooledRetries(treeKey), 0, "an answer clears the run's pool-handled count");
});

test("an error the pool does not take on still ends the run on pi-durable's own budget", async () => {
  const { settled, sent } = await run("overloaded", Array(10).fill("overloaded"));
  assert.notEqual(settled.status, "done");
  assert.equal(sent, 4, "the first request and pi-durable's default 3 retries");
});
