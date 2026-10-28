/**
 * One durable thread with Prime's `ipython` (`rlm.ts`) on a faux model, shared by rlm.test.ts and the worker it kills (rlm-worker.ts).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { threadRegistry } from "../../src/durable/registry.ts";
import { DurableRlm, type RlmThread } from "../../src/durable/rlm.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

export const context = BACKGROUND_CONTEXT;
export { textOf };

export const cell = (code: string) => fauxAssistantMessage([fauxToolCall("ipython", { code })], { stopReason: "toolUse" });
export const call = (name: string, args: Record<string, string>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
export const say = (words: string) => fauxAssistantMessage([fauxText(words)]);

/** The newest message's text: the input or the tool result the model answers. */
export const lastText = (messages: readonly Message[]): string => {
  const last = messages.at(-1);
  return last && last.role !== "system" ? textOf(last.content as never) : "";
};
export const firstUser = (messages: readonly Message[]): string => textOf((messages.find(m => m.role === "user")?.content ?? "") as never);

/** The agent dir the tests share: the fixture Prime agent dir, with an empty bundled skills folder. */
export function rlmOptions(dir: string) {
  const bundled = join(dir, "bundled-skills");
  mkdirSync(bundled, { recursive: true });
  return { agentDir: join(dir, "agent"), bundledSkillsDir: bundled, venvRoot: join(dir, "venv"), idleMs: 60_000 };
}

export async function openThread(file: string, id: string, rlm: DurableRlm, respond: FauxResponseFactory, cwd: string) {
  let harness: Harness | undefined;
  const thread: RlmThread = { id, file, name: () => `thread ${id}`, cwd, harness: () => harness };
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  models.setProvider(faux.provider);
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: threadRegistry(undefined, undefined, { thread: { id, file }, rlm: rlm.extension(thread) }) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", cwd } });
  harness.resume();
  return { harness, root, thread };
}

export async function entriesOf(harness: Harness, conversation = 1): Promise<EntryRecord[]> {
  const conv = await harness.conversation(conversation as never, context);
  return conv ? [...(await conv.entries({ order: "ascending" }, 2000, undefined, context)).items] : [];
}

export const results = (entries: readonly EntryRecord[]) => entries.flatMap(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError, details: (message as { details?: unknown }).details }] : [];
});
export const inputs = (entries: readonly EntryRecord[]) => entries.flatMap(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "user" ? [{ kind: entry.kind, data: entry.data as { from?: string; via?: string } | undefined, text: textOf(message.content), id: entry.id }] : [];
});

export async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
