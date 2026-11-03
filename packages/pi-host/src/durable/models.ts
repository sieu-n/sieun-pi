/**
 * The models a durable thread can run: each pooled provider (pi-pool's POOLED_PROVIDERS, anthropic and openai-codex) through
 * pi-pool, which vends every request's token. A provider left out here makes every run on its models settle `unanswered`
 * with reason `no_model`, which the chat shows as a failed agent, as gpt guy (openai-codex/gpt-6.1-sol) did on 10-29.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { poolProvider, type TurnQueue } from "@sieun-pi/pi-pool/durable";
import { compactionLine, withPrimeWindows } from "./prime-compaction.ts";

export interface DurableModelsOptions {
  /** The agent dir whose auth.json pi-pool's `adopt-logins` reads, and whose models.json sets each model's window (prime-compaction.ts). */
  agentDir?: string;
  /** The machine's turn queue every request takes its place in. */
  turns?: TurnQueue;
  /** The thread's pi-pool tree at each request (`PoolLabels.tree`); default its own, `pi-durable:<thread id>`. */
  tree?: () => string;
}

/** One thread's model registry with Prime's context windows, asking pi-pool for the thread's tree (`pool-labels.ts`). */
export function durableModels(threadId: string, options: DurableModelsOptions = {}): ReturnType<typeof createModels> {
  const models = createModels();
  const treeKey = options.tree ?? `pi-durable:${threadId}`;
  for (const inner of [anthropicProvider(), openaiCodexProvider()]) {
    models.setProvider(poolProvider({ treeKey, agentDir: options.agentDir, turns: options.turns, inner: withPrimeWindows(inner, options.agentDir) }));
  }
  return models;
}

/** The host log's line of where each model Prime sets a window for compacts on this host. */
export function durableCompactionLine(agentDir: string): string {
  return compactionLine(agentDir, [...anthropicProvider().getModels(), ...openaiCodexProvider().getModels()]);
}
