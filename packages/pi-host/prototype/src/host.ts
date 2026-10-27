import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, ROOT_CONVERSATION_ID, section, type Conversation, type HarnessSettings, type ReportInfo } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PRIME_BASE_PROMPT } from "../../../pi-family/preamble.ts";
import { Subagent } from "./subagent.ts";

/** Anthropic refuses a subscription token under an unknown preamble (../shared/preamble.ts), so every conversation gets Prime's. */
export const Preamble = defineExtension({ name: "preamble", sections: [section("preamble", () => PRIME_BASE_PROMPT, { tag: false })] });

export interface OpenOptions {
  /** The SQLite file that holds the whole session: conversations, entries, tasks, documents. */
  file: string;
  models: Models;
  model: { provider: string; modelId: string };
  thinkingLevel?: ModelThinkingLevel;
  settings?: HarnessSettings;
  readOnly?: boolean;
  onReport?: (error: unknown, info: ReportInfo) => void;
}

export interface DurableHost {
  harness: Harness;
  root: Conversation;
}

/** Opens one durable session on SQLite, with the root conversation on `model` and the subagent tool installed. */
export async function openDurableHost(opts: OpenOptions, context: Context): Promise<DurableHost> {
  const registry = createRegistry();
  registry.install(Preamble);
  registry.install(Subagent);
  const storage = await openNodeSqliteStorage(opts.file);
  const harness = await Harness.open(storage, {
    models: opts.models,
    registry,
    ...(opts.settings === undefined ? {} : { settings: opts.settings }),
    ...(opts.readOnly ? { readOnly: true } : {}),
    ...(opts.onReport === undefined ? {} : { onReport: opts.onReport }),
  }, context);
  const root = opts.readOnly
    ? await harness.conversation(ROOT_CONVERSATION_ID, context)
    : await harness.root(context, { agent: { model: opts.model, ...(opts.thinkingLevel === undefined ? {} : { thinkingLevel: opts.thinkingLevel }) } });
  if (root === undefined) throw new Error(`${opts.file} has no root conversation`);
  return { harness, root };
}
