/**
 * While pi-host stops, a new model request or tool call waits for the close and runs once after the restart (`drain-gate.ts`): no cut
 * answer to pay twice, and no tool call reported interrupted.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { drainGate } from "../../src/durable/drain-gate.ts";
import { threadEnv } from "../../src/durable/registry.ts";
import { MODEL } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const scratch = mkdtempSync(join(tmpdir(), "pi-host-drain-gate-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One pi-host's Harness on `file`, with the gate reading `stopping`, and the count of requests its model got. */
async function open(file: string, stopping: () => boolean, respond: FauxResponseFactory) {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] });
  const sent = { count: 0 };
  faux.setResponses(Array.from({ length: 10 }, () => ((...args: Parameters<FauxResponseFactory>) => { sent.count++; return respond(...args); }) as FauxResponseFactory));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(drainGate(stopping));
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry, env: threadEnv("drain-gate-test", () => scratch) }, context);
  return { harness, sent };
}

const records = async (harness: Harness): Promise<EntryRecord[]> =>
  (await (await harness.root(context)).entries({ order: "ascending" }, 1000, undefined, context)).items as EntryRecord[];
const json = (entries: EntryRecord[]): string => JSON.stringify(entries);

test("a request that would start while pi-host stops is sent once, after the restart", async () => {
  const file = join(scratch, "request.sqlite");
  const first = await open(file, () => true, () => fauxAssistantMessage("OK"));
  const root = await first.harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await root.submit({ type: "input", content: "Reply with OK.", requestId: "r1" }, context);
  await wait(300);
  assert.equal(first.sent.count, 0, "the held request reached no model");
  await first.harness.close(context);

  const second = await open(file, () => false, () => fauxAssistantMessage("OK"));
  second.harness.resume();
  await (await second.harness.root(context)).waitForIdle(context);
  const entries = await records(second.harness);
  await second.harness.close(context);
  assert.equal(second.sent.count, 1, "one request after the restart");
  assert.doesNotMatch(json(entries), /"stopReason":"(aborted|error)"/, "no cut or failed answer");
  assert.match(json(entries), /"text":"OK"/);
});

test("a tool call that would start while pi-host stops runs once after the restart and is not reported interrupted", async () => {
  const file = join(scratch, "tool.sqlite");
  const mark = join(scratch, "ran.txt");
  let stopping = false;
  const respond: FauxResponseFactory = transcript => {
    if (transcript.messages.some(m => m.role === "toolResult")) return fauxAssistantMessage("DONE");
    // The answer that asks for the call arrives as pi-host starts to stop.
    stopping = true;
    return fauxAssistantMessage([fauxToolCall("bash", { command: `echo ran >> ${mark}; echo hi` })], { stopReason: "toolUse" });
  };
  const first = await open(file, () => stopping, respond);
  const root = await first.harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", cwd: scratch } });
  await root.submit({ type: "input", content: "Run the command.", requestId: "t1" }, context);
  await wait(400);
  assert.equal(first.sent.count, 1);
  assert.equal(existsSync(mark), false, "the held call did not run before the close");
  await first.harness.close(context);

  stopping = false;
  const second = await open(file, () => false, respond);
  second.harness.resume();
  await (await second.harness.root(context)).waitForIdle(context);
  const entries = await records(second.harness);
  await second.harness.close(context);
  assert.equal(readFileSync(mark, "utf8"), "ran\n", "the call ran exactly once");
  assert.doesNotMatch(json(entries), /interrupted/, "no interrupted result");
  assert.match(json(entries), /"text":"DONE"/);
  assert.equal(second.sent.count, 1, "the answer after the tool is the only request after the restart");
});
