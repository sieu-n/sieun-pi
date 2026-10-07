import { readFile, rename, stat, writeFile } from "node:fs/promises";

/**
 * Model prices from LiteLLM's public table (the same file tokscale reads, pricing/litellm.rs). Fetched at most once a
 * day into `<data dir>/litellm-prices.json`; the last good copy is used when the fetch fails or the Mac is offline.
 * A missing price only leaves cost null: the store joins prices at query time, so a later table prices old calls.
 */
export const pricesUrl = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const dayMs = 24 * 60 * 60 * 1000;

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceTable = Map<string, Price>;

export async function loadPrices(path: string, fetchJson: (url: string) => Promise<unknown> = defaultFetch): Promise<{ table: PriceTable; fetchedAt: number | null }> {
  const age = await stat(path).then(info => Date.now() - info.mtimeMs, () => Infinity);
  if (age > dayMs) {
    try {
      const value = await fetchJson(pricesUrl);
      const table = toTable(value);
      if (table.size > 100) {
        await writeFile(path + ".tmp", JSON.stringify(value));
        await rename(path + ".tmp", path);
        return { table, fetchedAt: Date.now() };
      }
    } catch { /* offline: the cached copy below */ }
  }
  try { return { table: toTable(JSON.parse(await readFile(path, "utf8"))), fetchedAt: Date.now() - age }; }
  catch { return { table: new Map(), fetchedAt: null }; }
}

async function defaultFetch(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Prices: HTTP ${response.status}`);
  return response.json();
}

export function toTable(value: unknown): PriceTable {
  const table: PriceTable = new Map();
  if (typeof value !== "object" || value === null) return table;
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const rate = (name: string) => typeof r[name] === "number" && Number.isFinite(r[name]) ? r[name] as number : null;
    const input = rate("input_cost_per_token"), output = rate("output_cost_per_token");
    if (input === null || output === null) continue;
    table.set(key.toLowerCase(), { input, output, cacheRead: rate("cache_read_input_token_cost") ?? input, cacheWrite: rate("cache_creation_input_token_cost") ?? input });
  }
  return table;
}

/**
 * The price row for a model name as transcripts write it. A reduced form of tokscale's pricing/lookup.rs: the exact
 * key, then with the provider prefix added or removed, then without a date or `@` suffix, then with version dots and
 * dashes swapped (`claude-opus-4-5` and `claude-opus-4.5`). No fuzzy match: an unknown model stays unpriced.
 */
export function resolvePrice(model: string, provider: string | null, table: PriceTable): { key: string; price: Price } | null {
  const name = model.toLowerCase().trim();
  const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const candidates = new Set<string>();
  for (const base of [name, bare]) {
    for (const stem of new Set([base, base.replace(/@.*$/, ""), base.replace(/-\d{8}$/, "")])) {
      for (const variant of [stem, stem.replace(/(\d)-(\d)(?!\d)/g, "$1.$2"), stem.replace(/(\d)\.(\d)/g, "$1-$2")]) {
        candidates.add(variant);
        if (provider) candidates.add(`${provider.toLowerCase()}/${variant}`);
      }
    }
  }
  for (const key of candidates) {
    const price = table.get(key);
    if (price) return { key, price };
  }
  return null;
}
