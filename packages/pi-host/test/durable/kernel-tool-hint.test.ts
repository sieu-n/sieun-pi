/**
 * A call of a kernel module as a tool (`kernel-tool-hint.ts`): pi-durable's "Tool agent_message.send is not available" reaches the model as
 * how to make the same call in ipython, in a real thread run, and any other unavailable tool or error keeps its answer.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context as ModelContext, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { KernelToolHint, kernelHint, withKernelHints } from "../../src/durable/kernel-tool-hint.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-kernel-hint-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const result = (toolName: string, text: string, isError = true): Message =>
  ({ role: "toolResult", toolCallId: "c1", toolName, content: [{ type: "text", text }], isError, timestamp: 1 }) as Message;

test("an unavailable kernel module reads as its ipython call, and other tools and errors keep their answer", () => {
  assert.match(kernelHint("agent_message.send")!, /^agent_message\.send is a Python module in your ipython kernel, not a tool, so nothing ran\. .*`await agent_message\.send\(text, receiver_role="parent"\)`\.$/);
  assert.match(kernelHint("attach_image")!, /attach_image\.attach_image\("\/absolute\/path\.png"\)/);
  assert.equal(kernelHint("frobnicate"), undefined);
  const hinted = withKernelHints([result("agent_message.send", "<harness>\n[error] Tool agent_message.send is not available\n</harness>")])!;
  assert.equal(textOf((hinted[0] as Extract<Message, { role: "toolResult" }>).content), kernelHint("agent_message.send"));
  assert.equal(withKernelHints([result("frobnicate", "<harness>\n[error] Tool frobnicate is not available\n</harness>")]), undefined);
  assert.equal(withKernelHints([result("attach_image", "some other error")]), undefined);
  assert.equal(withKernelHints([result("attach_image", "[error] Tool attach_image is not available", false)]), undefined);
});

test("in a thread run, the model's next request carries the hint where pi-durable answered the call as unavailable", async () => {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  const seen: ModelContext[] = [];
  faux.setResponses([
    (request: ModelContext) => { seen.push(request); return fauxAssistantMessage([fauxToolCall("agent_message.send", { message: "the report" })], { stopReason: "toolUse" }); },
    (request: ModelContext) => { seen.push(request); return fauxAssistantMessage("done"); },
  ]);
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(KernelToolHint);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "t.sqlite")), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Report." }, context)).wait(context);
  await harness.close(context);
  const answered = seen[1]!.messages.find(m => m.role === "toolResult") as Extract<Message, { role: "toolResult" }>;
  assert.equal(textOf(answered.content), kernelHint("agent_message.send"));
});
