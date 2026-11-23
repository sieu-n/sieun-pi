/**
 * A compaction summary that needs more than 0.8 x reserveTokens of output no longer fails the thread's turns (`summary-room.ts`). On 11-23
 * agent factory's work thread failed ten turns in a row with "Compaction failed: Summarization hit the token limit; the summary is
 * incomplete", because pi-durable asked the summary for at most 13,107 tokens and each turn started the same compaction again.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage, type FauxResponseFactory, type Message, type Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { withPrimeCompaction, withPrimeWindows } from "../../src/durable/prime-compaction.ts";
import { CUT_LINE, isSummaryRequest, SUMMARY_SYSTEM_START, withSummaryRoom } from "../../src/durable/summary-room.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-summary-room-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
/** The output this thread's summary needs, thinking included: more than 0.8 x the reserve of 1,000 and less than the faux model's 16,384. */
const NEEDS = 5_000;
const SUMMARY = "## Goal\nBuild the relay page.";

const textOf = (message: Message | undefined): string => {
  const content = message && "content" in message ? message.content : "";
  return typeof content === "string" ? content : content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
};
const length = (): AssistantMessage => fauxAssistantMessage("## Goal\nBuild the rel", { stopReason: "length" });

/** A model whose summary ends `length` when its output budget is under NEEDS, as Claude's did at 13,107 with high thinking. */
const reply: FauxResponseFactory = (request, options, _state, model) => {
  if (!isSummaryRequest(request.messages)) return fauxAssistantMessage("ok");
  const budget = options?.maxTokens ?? model.maxTokens;
  return budget < NEEDS ? length() : fauxAssistantMessage(SUMMARY);
};

async function run(name: string, wrap: (inner: Provider) => Provider) {
  const at = join(dir, name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "models.json"), JSON.stringify({ providers: { anthropic: { models: [{ id: MODEL.modelId, contextWindow: 3_000 }] } } }));
  writeFileSync(join(at, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 1_000, keepRecentTokens: 200 } }));
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 20 }, () => reply));
  const models = createModels();
  models.setProvider(wrap(withPrimeWindows(faux.provider, at)));
  const settings = withPrimeCompaction({ compaction: { backgroundTokens: 0 } } as never, at);
  const harness = await Harness.open(await openNodeSqliteStorage(join(at, "thread.sqlite")), { models, registry: createRegistry(), settings }, context);
  try {
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "high" } });
    const page = "word ".repeat(1_000);
    await (await root.submit({ type: "input", content: `first ${page}` }, context)).wait(context);
    const second = await (await root.submit({ type: "input", content: `second ${page}` }, context)).wait(context);
    await harness.waitForIdle(context);
    const entries = (await root.entries({ order: "ascending" }, 1000, undefined, context)).items;
    return { second, entries, kinds: entries.map(entry => entry.kind) };
  } finally {
    await harness.close(context);
  }
}

test("pi-durable's own summary budget of 0.8 x reserveTokens ends `length`, and the turn that waits for it fails", { timeout: 60_000 }, async () => {
  const { second, kinds } = await run("today", inner => inner);
  assert.equal(second.status, "unanswered", `the turn fails: ${JSON.stringify(second)}`);
  assert.ok(!kinds.includes("pi.compaction"), `no summary is placed: ${kinds.join(", ")}`);
});

test("with the model's output limit the summary is placed and the turn completes", { timeout: 60_000 }, async () => {
  const { second, entries, kinds } = await run("room", withSummaryRoom);
  assert.equal(second.status, "done", JSON.stringify(second));
  const summary = entries.find(entry => entry.kind === "pi.compaction");
  assert.ok(summary, `a summary is placed: ${kinds.join(", ")}`);
  assert.match(JSON.stringify(summary), /Build the relay page\./);
  assert.equal(kinds.at(-1), "pi.assistant", `the turn ends on the model's answer: ${kinds.join(", ")}`);
});

/** The summaries a wrapped faux model gives for one summary request, with each request it saw. */
async function summarize(responses: FauxResponseFactory[]) {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  const seen: { text: string; maxTokens: number | undefined }[] = [];
  faux.setResponses(responses.map(respond => (request, options, state, model) => {
    seen.push({ text: textOf(request.messages.at(-1)), maxTokens: options?.maxTokens });
    return respond(request, options, state, model);
  }));
  const models = createModels();
  models.setProvider(withSummaryRoom(faux.provider));
  const model = models.getModel(MODEL.provider, MODEL.modelId)!;
  const messages: Message[] = [
    { role: "system", content: `${SUMMARY_SYSTEM_START}\n\nDo NOT continue the conversation.`, timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "<conversation>...</conversation>\n\nUse this EXACT format:" }], timestamp: 1 },
  ];
  const message = await models.completeSimple(model, { messages }, { maxTokens: 13_107, reasoning: "high" });
  return { message, seen };
}

test("a summary that ends `length` with the full limit is asked once for a shorter one, and the usage covers both", async () => {
  const { message, seen } = await summarize([length, () => fauxAssistantMessage(SUMMARY)]);
  assert.deepEqual(seen.map(request => request.maxTokens), [undefined, undefined], "both requests get the model's own limit, not 13,107");
  assert.match(seen[0]!.text, /Use this EXACT format:$/, "the first request keeps Prime's prompt as it is");
  const retry = /Use this EXACT format:\s+Your first summary .* after (\d+) tokens\. Write the same structured summary in at most half that length/.exec(seen[1]!.text);
  assert.ok(retry, seen[1]!.text);
  assert.equal(message.stopReason, "stop");
  assert.equal(textOf(message), SUMMARY);
  const alone = (await summarize([() => fauxAssistantMessage(SUMMARY)])).message.usage.output;
  assert.equal(message.usage.output, Number(retry[1]) + alone);
});

test("a summary that ends `length` twice is placed as it stands with a line saying where it stops", async () => {
  const { message, seen } = await summarize([length, length]);
  assert.equal(seen.length, 2, "one shorter retry, no more");
  assert.equal(message.stopReason, "stop");
  assert.ok(textOf(message).endsWith(CUT_LINE), textOf(message));
});

test("a request that is not a compaction summary passes through with its own budget", async () => {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let budget: number | undefined;
  faux.setResponses([(_request, options) => { budget = options?.maxTokens; return fauxAssistantMessage("ok"); }]);
  const models = createModels();
  models.setProvider(withSummaryRoom(faux.provider));
  const model = models.getModel(MODEL.provider, MODEL.modelId)!;
  await models.completeSimple(model, { systemPrompt: "You are an agent.", messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { maxTokens: 900 });
  assert.equal(budget, 900);
});
