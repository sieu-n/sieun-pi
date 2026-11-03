/**
 * A durable thread compacts at the size a Prime chat on the same host compacts at.
 *
 * Prime compacts when a request's context passes the model's context window minus `compaction.reserveTokens` (prime-agent
 * coding-agent `shouldCompact`, reserve 16384 by default), and pi-durable's generation applies the same rule
 * (`thresholdCompaction`), so the two agree once they agree on the window and the reserve. The host owner set Prime's
 * windows below a model's full window in `~/.prime/agent/models.json`, such as 500K for Claude Opus 5.5 where the catalog
 * says 1M, so Opus 5.5 compacts at 483,616 tokens.
 *
 * A model's window comes from the first of these that names it:
 * 1. This host's Prime `<agentDir>/models.json`, a `models` entry of the provider and then its `modelOverrides` entry, the
 *    order Prime applies them in, so a change there reaches pi-host with no release.
 * 2. PRIME_WINDOWS, the windows that file set on us-metal02 and the owner's Mac on 2026-11-03, so a new host that has no
 *    models.json compacts where those two do.
 * 3. Prime's fetched catalog `<agentDir>/models/provider-model-catalog.v1.json`, where Prime has 272K for Codex's gpt-6.1-sol
 *    and pi-ai's catalog has 500K.
 * 4. pi-ai's catalog, the model as the provider lists it.
 *
 * `enabled`, `reserveTokens` and `keepRecentTokens` come from Prime's `<agentDir>/settings.json` `compaction`, else
 * pi-durable's defaults, which equal Prime's. Both files are read again when they change. pi-durable's background
 * compaction, which Prime lacks, still starts `backgroundTokens` (32,768) below that point without holding the turn.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { CompactionSettings, HarnessSettings } from "@earendil-works/pi-durable";

/** Where a window came from, in the order above. */
export type WindowSource = "models.json" | "pi-host" | "prime-catalog" | "pi-ai";

/** `provider/id` to window, as `models.json` set them on us-metal02 and the Mac (mtime 2026-10-17) when pi-host took them on 11-03. */
export const PRIME_WINDOWS: Readonly<Record<string, number>> = {
  "anthropic/claude-opus-5-5": 500_000,
  "anthropic/claude-opus-5": 500_000,
  "anthropic/claude-fable-5": 500_000,
  "anthropic/claude-fable-5-1": 500_000,
  "anthropic/claude-opus-4-6": 500_000,
  "anthropic/claude-opus-4-7": 500_000,
  "anthropic/claude-opus-4-8": 500_000,
  "anthropic/claude-sonnet-4-5": 500_000,
  "anthropic/claude-sonnet-4-5-20250929": 500_000,
  "anthropic/claude-sonnet-4-6": 500_000,
  "anthropic/claude-sonnet-5": 500_000,
  "anthropic/claude-sonnet-5-5": 500_000,
  "openai-codex/gpt-6-astra": 1_000_000,
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const files = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
/** The parsed file, parsed again only when its mtime or size changed; a file that does not parse keeps the last one read. */
function readJson(path: string): unknown {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    files.delete(path);
    return undefined;
  }
  const last = files.get(path);
  if (last && last.mtimeMs === stat.mtimeMs && last.size === stat.size) return last.value;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = last?.value;
  }
  files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function modelsJsonWindow(agentDir: string, provider: string, id: string): number | undefined {
  const file = readJson(join(agentDir, "models.json"));
  const config = isRecord(file) && isRecord(file.providers) ? file.providers[provider] : undefined;
  if (!isRecord(config)) return undefined;
  const override = isRecord(config.modelOverrides) ? config.modelOverrides[id] : undefined;
  if (isRecord(override) && isCount(override.contextWindow) && override.contextWindow > 0) return override.contextWindow;
  const entry = Array.isArray(config.models) ? config.models.find(model => isRecord(model) && model.id === id) : undefined;
  return isRecord(entry) && isCount(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : undefined;
}

function catalogWindow(agentDir: string, provider: string, id: string): number | undefined {
  const file = readJson(join(agentDir, "models/provider-model-catalog.v1.json"));
  const models = isRecord(file) && isRecord(file.payload) && Array.isArray(file.payload.models) ? file.payload.models : [];
  const entry = models.find(model => isRecord(model) && model.provider === provider && model.id === id);
  return isRecord(entry) && isCount(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : undefined;
}

/** The window Prime runs `provider/id` with on the host whose agent dir is `agentDir`, or undefined to keep pi-ai's. */
export function primeWindow(agentDir: string | undefined, provider: string, id: string): { tokens: number; source: Exclude<WindowSource, "pi-ai"> } | undefined {
  const fromFile = agentDir === undefined ? undefined : modelsJsonWindow(agentDir, provider, id);
  if (fromFile !== undefined) return { tokens: fromFile, source: "models.json" };
  const shipped = PRIME_WINDOWS[`${provider}/${id}`];
  if (shipped !== undefined) return { tokens: shipped, source: "pi-host" };
  const fromCatalog = agentDir === undefined ? undefined : catalogWindow(agentDir, provider, id);
  return fromCatalog === undefined ? undefined : { tokens: fromCatalog, source: "prime-catalog" };
}

/** `inner` with every chat model's context window set to Prime's, read at each lookup. */
export function withPrimeWindows(inner: Provider, agentDir: string | undefined): Provider {
  const windowed = <M extends { provider: string; id: string; contextWindow?: number }>(model: M): M => {
    if (typeof model.contextWindow !== "number") return model;
    const window = primeWindow(agentDir, model.provider, model.id);
    return window === undefined || window.tokens === model.contextWindow ? model : { ...model, contextWindow: window.tokens };
  };
  const all = inner.getAllModels;
  return {
    ...inner,
    getModels: () => inner.getModels().map(windowed),
    ...(all ? { getAllModels: () => all.call(inner).map(windowed) } : {}),
  };
}

/** Prime's `compaction` settings that pi-durable shares: `enabled`, `reserveTokens` and `keepRecentTokens`, each when set. */
export function primeCompaction(agentDir: string | undefined): CompactionSettings {
  const file = agentDir === undefined ? undefined : readJson(join(agentDir, "settings.json"));
  const compaction = isRecord(file) && isRecord(file.compaction) ? file.compaction : {};
  return {
    ...(typeof compaction.enabled === "boolean" ? { enabled: compaction.enabled } : {}),
    ...(isCount(compaction.reserveTokens) ? { reserveTokens: compaction.reserveTokens } : {}),
    ...(isCount(compaction.keepRecentTokens) ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
  };
}

/** `settings` with a live `compaction` getter: its own compaction fields under Prime's, read at every use as pi-durable reads settings. */
export function withPrimeCompaction(settings: HarnessSettings, agentDir: string | undefined): HarnessSettings {
  const own = settings.compaction;
  return Object.defineProperty(settings, "compaction", { get: () => ({ ...own, ...primeCompaction(agentDir) }), enumerable: true, configurable: true });
}

/**
 * One line for the host log: where each model Prime sets a window for compacts, as window minus reserve, and the file
 * that set it. `models` is each provider's catalog list, pi-ai's windows before Prime's.
 */
export function compactionLine(agentDir: string | undefined, models: readonly { provider: string; id: string; contextWindow: number }[]): string {
  const reserve = primeCompaction(agentDir).reserveTokens ?? 16_384;
  const parts = models.flatMap(model => {
    const window = primeWindow(agentDir, model.provider, model.id);
    return window === undefined ? [] : [`${model.provider}/${model.id} ${window.tokens - reserve} (${window.tokens} from ${window.source}, pi-ai ${model.contextWindow})`];
  });
  return `durable compaction at window - reserve ${reserve}: ${parts.join(", ")}`;
}
