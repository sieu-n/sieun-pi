/**
 * The models a durable thread can run: each pooled provider (pi-pool's POOLED_PROVIDERS, anthropic and openai-codex) through
 * pi-pool, which vends every request's token. A provider left out here makes every run on its models settle `unanswered`
 * with reason `no_model`, which the chat shows as a failed agent, as gpt guy (openai-codex/gpt-6.1-sol) did on 10-29.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { poolProvider, type TurnQueue } from "@sieun-pi/pi-pool/durable";

export interface DurableModelsOptions {
  /** The agent dir whose auth.json pi-pool's `adopt-logins` reads. */
  agentDir?: string;
  /** The machine's turn queue every request takes its place in. */
  turns?: TurnQueue;
}

/** One thread's model registry; the thread is its own pi-pool tree, `pi-durable:<thread id>`. */
export function durableModels(threadId: string, options: DurableModelsOptions = {}): ReturnType<typeof createModels> {
  const models = createModels();
  for (const inner of [anthropicProvider(), openaiCodexProvider()]) {
    models.setProvider(poolProvider({ treeKey: `pi-durable:${threadId}`, agentDir: options.agentDir, turns: options.turns, inner }));
  }
  return models;
}
