/**
 * The models a durable thread can run: each pooled provider (pi-pool's POOLED_PROVIDERS, anthropic and openai-codex) through
 * pi-pool, which vends every request's token. A provider left out here makes every run on its models settle `unanswered`
 * with reason `no_model`, which the chat shows as a failed agent, as gpt guy (openai-codex/gpt-6.1-sol) did on 10-29.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { join } from "node:path";
import { poolProvider, type TurnQueue } from "@sieun-pi/pi-pool/durable";
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { compactionLine, readJson, withPrimeWindows } from "./prime-compaction.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Prime's `models.json` model entries that pi-host ships for a host whose file lacks them, as PRIME_WINDOWS ships windows. Claude Fable 5.2
 * came out on 2026-11-09, pi-ai 1.4.0's catalog lacks it, and it became every thread's default on 11-10 (c221). Anthropic answers it
 * with 400 claude_code_version_too_old under pi-ai's user-agent claude-cli/2.1.280 and with 200 from claude-cli/2.1.290 on, so the entry
 * sends claude-cli/2.1.311 as us-metal02's models.json does.
 */
export const PRIME_MODELS: Readonly<Record<string, readonly Json[]>> = {
  anthropic: [{
    id: "claude-fable-5-2", name: "Claude Fable 5.2", reasoning: true, input: ["text", "image"], contextWindow: 500_000, maxTokens: 128_000,
    cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, headers: { "user-agent": "claude-cli/2.1.311" },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  }],
};

/** The host's `models.json` `models` entries of `provider`, then each PRIME_MODELS entry the file does not name. */
function primeEntries(agentDir: string | undefined, provider: string): Json[] {
  const file = agentDir === undefined ? undefined : readJson(join(agentDir, "models.json"));
  const config = isRecord(file) && isRecord(file.providers) ? file.providers[provider] : undefined;
  const own = isRecord(config) && Array.isArray(config.models) ? config.models.filter(isRecord).filter(entry => typeof entry.id === "string") : [];
  return [...own, ...(PRIME_MODELS[provider] ?? []).filter(entry => !own.some(o => o.id === entry.id))];
}

const sharedPrefix = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * `models` with each Prime entry whose id the catalog lacks, built on the catalog model whose id shares the longest prefix with it, so
 * claude-fable-5-2 keeps claude-fable-5-1's `compat`. That compat's `forceAdaptiveThinking` is what turns a thinking level into Anthropic's
 * `effort`; Prime's own composer takes a new entry's compat from models.json alone. The entry's own fields win over the base's.
 */
export function withPrimeEntries<M extends { id: string; type?: string; compat?: unknown }>(models: readonly M[], entries: readonly Json[]): M[] {
  const chat = models.filter(m => m.type === undefined || m.type === "chat");
  const added = entries.flatMap(entry => {
    const id = entry.id as string;
    if (chat.length === 0 || chat.some(m => m.id === id)) return [];
    const base = chat.reduce((best, m) => sharedPrefix(m.id, id) > sharedPrefix(best.id, id) ? m : best);
    const { api: _api, baseUrl: _baseUrl, compat, ...fields } = entry;
    return [{ ...base, ...fields, id, name: typeof entry.name === "string" ? entry.name : id, compat: isRecord(compat) ? { ...(base.compat as Json | undefined), ...compat } : base.compat }];
  });
  return [...models, ...added];
}

function withPrimeModels(inner: Provider, agentDir: string | undefined): Provider {
  const all = inner.getAllModels;
  return {
    ...inner,
    getModels: () => withPrimeEntries(inner.getModels(), primeEntries(agentDir, inner.id)),
    ...(all ? { getAllModels: () => withPrimeEntries(all.call(inner), primeEntries(agentDir, inner.id)) } : {}),
  };
}

/** A thread's model and thinking level when none is named, while Prime's settings.json names none (c221, 2026-11-10). */
export const FALLBACK_DEFAULTS: { model: ModelRef; thinkingLevel: ModelThinkingLevel } = { model: { provider: "anthropic", modelId: "claude-fable-5-2" }, thinkingLevel: "medium" };
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The model and thinking level a Prime chat on this host starts with: `defaultProvider`, `defaultModel` and `defaultThinkingLevel` of
 * `<agentDir>/settings.json`, read again when the file changes, so pi-host and Prime cannot drift. Each one the file lacks is FALLBACK_DEFAULTS'.
 */
export function primeDefaults(agentDir: string | undefined): { model: ModelRef; thinkingLevel: ModelThinkingLevel } {
  const file = agentDir === undefined ? undefined : readJson(join(agentDir, "settings.json"));
  const settings = isRecord(file) ? file : {};
  const id = typeof settings.defaultModel === "string" && settings.defaultModel ? settings.defaultModel : undefined;
  const provider = typeof settings.defaultProvider === "string" && settings.defaultProvider ? settings.defaultProvider : FALLBACK_DEFAULTS.model.provider;
  const level = settings.defaultThinkingLevel;
  return {
    model: id === undefined ? FALLBACK_DEFAULTS.model : { provider, modelId: id },
    thinkingLevel: typeof level === "string" && THINKING_LEVELS.includes(level) ? level as ModelThinkingLevel : FALLBACK_DEFAULTS.thinkingLevel,
  };
}

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
    models.setProvider(poolProvider({ treeKey, agentDir: options.agentDir, turns: options.turns, inner: withPrimeWindows(withPrimeModels(inner, options.agentDir), options.agentDir) }));
  }
  return models;
}

/** The host log's line of where each model Prime sets a window for compacts on this host. */
export function durableCompactionLine(agentDir: string): string {
  const providers: Provider[] = [anthropicProvider(), openaiCodexProvider()];
  return compactionLine(agentDir, providers.flatMap(inner => withPrimeEntries(inner.getModels(), primeEntries(agentDir, inner.id))));
}
