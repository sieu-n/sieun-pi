<script module lang="ts">
  const FAVORITES_KEY = "chat.favoriteModels";
  const DEFAULT_FAVORITES = ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"];

  function loadFavorites(): string[] {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "null");
      if (Array.isArray(stored) && stored.every(entry => typeof entry === "string")) return stored;
    } catch { /* fall back to the defaults */ }
    return DEFAULT_FAVORITES;
  }
</script>

<script lang="ts">
  import type { ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import { compactNumber } from "./format.ts";
  import Icon from "./Icon.svelte";

  let { catalog, error, current, onchoose, defaultLabel = null, ondefault, effort, levels, oneffort, defaultEffort = false, note = "" }: {
    catalog: ModelCatalog | null; error: string | null; current: { provider: string; id: string } | null; onchoose: (model: ModelInfo) => void;
    defaultLabel?: string | null; ondefault?: () => void;
    effort: ThinkingLevel | null; levels: readonly ThinkingLevel[]; oneffort: (level: ThinkingLevel | null) => void; defaultEffort?: boolean; note?: string;
  } = $props();
  let query = $state("");
  let favorites = $state(loadFavorites());

  const keyOf = (model: { provider: string; id: string }) => model.provider + "/" + model.id;
  const favoriteModels = $derived(catalog ? favorites.flatMap(key => catalog.models.filter(model => keyOf(model) === key)) : []);
  const groups = $derived.by(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    const configured = new Set(catalog.configuredProviders);
    const favored = new Set(favorites);
    const groups = new Map<string, ModelInfo[]>();
    for (const model of catalog.models) {
      if (needle ? !(model.name + " " + model.id + " " + model.provider).toLowerCase().includes(needle) : !configured.has(model.provider) || favored.has(keyOf(model))) continue;
      const list = groups.get(model.provider);
      if (list) list.push(model); else groups.set(model.provider, [model]);
    }
    return [...groups.entries()].sort(([a], [b]) => Number(configured.has(b)) - Number(configured.has(a)) || a.localeCompare(b)).map(([provider, models]) => ({ provider, models, configured: configured.has(provider) }));
  });

  function toggleFavorite(model: ModelInfo): void {
    const key = keyOf(model);
    favorites = favorites.includes(key) ? favorites.filter(entry => entry !== key) : [...favorites, key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }
  function focus(node: HTMLInputElement): void { node.focus(); }
</script>

{#snippet row(model: ModelInfo)}
  {@const favorite = favorites.includes(keyOf(model))}
  <div class="row">
    <button class="menu-item" class:current={current?.id === model.id && current.provider === model.provider} onclick={() => onchoose(model)}>
      <span class="name">{model.name}</span>
      <span class="hint">{compactNumber(model.contextWindow)}{model.input.includes("image") ? " · images" : ""}</span>
    </button>
    <button class="star" class:on={favorite} aria-pressed={favorite} aria-label={favorite ? "Remove " + model.name + " from favorites" : "Add " + model.name + " to favorites"}
      title={favorite ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(model)}><Icon name="star" size={13} /></button>
  </div>
{/snippet}

<div class="picker">
  {#if error}
    <div class="note">{error}</div>
  {:else if !catalog}
    <div class="note"><span class="spinner tiny"></span> Loading models</div>
  {:else}
    {#if defaultLabel !== null}
      <button class="menu-item" class:current={current === null} onclick={() => ondefault?.()}>Default{#if defaultLabel}<span class="hint">{defaultLabel}</span>{/if}</button>
    {/if}
    {#if favoriteModels.length}
      <div class="menu-heading">Favorites</div>
      {#each favoriteModels as model (keyOf(model))}{@render row(model)}{/each}
    {/if}
    <input class="field filter" placeholder="Search models" aria-label="Search models" bind:value={query} use:focus />
    {#each groups as group (group.provider)}
      <div class="menu-heading" class:faint={!group.configured}>{group.provider}{group.configured ? "" : " (no key)"}</div>
      {#each group.models as model (keyOf(model))}{@render row(model)}{/each}
    {/each}
    {#if query.trim() && !groups.length}<div class="note">No model matches.</div>{/if}
  {/if}
  {#if levels.length}
    <div class="effort">
      <span class="effort-label">Effort</span>
      <div class="segmented" role="radiogroup" aria-label="Effort">
        {#if defaultEffort}
          <button role="radio" aria-checked={effort === null} class:on={effort === null} onclick={() => oneffort(null)}>Default</button>
        {/if}
        {#each levels as level (level)}
          <button role="radio" aria-checked={effort === level} class:on={effort === level} onclick={() => oneffort(level)}>{level}</button>
        {/each}
      </div>
    </div>
  {/if}
  {#if note}<div class="footnote">{note}</div>{/if}
</div>

<style>
  .picker { display: flex; flex-direction: column; }
  .note { display: flex; align-items: center; gap: 8px; padding: 10px; font-size: 13px; color: var(--text-muted); }
  .filter { margin: 6px 2px; width: calc(100% - 4px); font-size: 13px; }
  .row { display: flex; align-items: center; gap: 2px; }
  .row .menu-item { flex: 1; min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .star { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--radius-small); color: var(--text-faint); opacity: 0; }
  .row:hover .star, .star:focus-visible, .star.on { opacity: 1; }
  .star:hover { background: var(--bg-hover); color: var(--text); }
  .star.on { color: var(--warning); }
  .star.on :global(svg) { fill: currentColor; }
  .effort { position: sticky; bottom: -6px; display: flex; align-items: center; gap: 8px; margin: 6px -6px -6px; padding: 8px 10px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
  .effort-label { font-size: 12px; color: var(--text-muted); }
  .segmented { display: inline-flex; flex-wrap: wrap; padding: 2px; border-radius: var(--radius-small); background: var(--bg-hover); }
  .segmented button { height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--text-muted); }
  .segmented button:hover { color: var(--text); }
  .segmented button.on { background: var(--bg-elevated); color: var(--text); box-shadow: 0 1px 2px var(--shadow-near); }
  .footnote { padding: 6px 10px 2px; font-size: 11px; color: var(--text-faint); }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
</style>
