<script module lang="ts">
  const FAVORITES_KEY = "chat.favoriteModels";
  const DEFAULT_FAVORITES = ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"];
  const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "OpenAI Codex", openai: "OpenAI", google: "Google" };
  const providerName = (provider: string): string => PROVIDER_NAME[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);

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
  import { tooltip } from "./ui/tooltip.ts";
  import Icon from "./Icon.svelte";

  let { catalog, error, current, onchoose, defaultLabel = null, ondefault, effort, levels, oneffort, defaultEffort = false }: {
    catalog: ModelCatalog | null; error: string | null; current: { provider: string; id: string } | null; onchoose: (model: ModelInfo) => void;
    defaultLabel?: string | null; ondefault?: () => void;
    effort: ThinkingLevel | null; levels: readonly ThinkingLevel[]; oneffort: (level: ThinkingLevel | null) => void; defaultEffort?: boolean;
  } = $props();
  let query = $state("");
  let favorites = $state(loadFavorites());
  let active = $state(-1);
  let list: HTMLElement | undefined = $state();

  const keyOf = (model: { provider: string; id: string }) => model.provider + "/" + model.id;
  const needle = $derived(query.trim().toLowerCase());
  const favoriteModels = $derived(catalog && !needle ? favorites.flatMap(key => catalog.models.filter(model => keyOf(model) === key)) : []);
  const groups = $derived.by(() => {
    if (!catalog) return [];
    const configured = new Set(catalog.configuredProviders);
    const favored = new Set(favorites);
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of catalog.models) {
      if (needle ? !(model.name + " " + model.id + " " + model.provider).toLowerCase().includes(needle) : !configured.has(model.provider) || favored.has(keyOf(model))) continue;
      const entries = byProvider.get(model.provider);
      if (entries) entries.push(model); else byProvider.set(model.provider, [model]);
    }
    return [...byProvider.entries()].sort(([a], [b]) => Number(configured.has(b)) - Number(configured.has(a)) || a.localeCompare(b)).map(([provider, models]) => ({ provider, models, configured: configured.has(provider) }));
  });
  const flat = $derived([...favoriteModels, ...groups.flatMap(group => group.models)]);
  $effect(() => { void needle; active = needle ? 0 : -1; });

  function toggleFavorite(model: ModelInfo): void {
    const key = keyOf(model);
    favorites = favorites.includes(key) ? favorites.filter(entry => entry !== key) : [...favorites, key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }
  function move(to: number): void {
    if (!flat.length) return;
    active = (to + flat.length) % flat.length;
    requestAnimationFrame(() => list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }));
  }
  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Enter") { event.preventDefault(); const model = flat[Math.max(0, active)]; if (model) onchoose(model); }
  }
</script>

{#snippet row(model: ModelInfo, index: number)}
  {@const favorite = favorites.includes(keyOf(model))}
  <div class="row">
    <button type="button" class="menu-item" id="model-option-{index}" data-index={index} data-active={index === active}
      class:current={current?.id === model.id && current.provider === model.provider} onpointermove={() => { active = index; }} onclick={() => onchoose(model)}>
      <span class="name">{model.name}</span>
      <span class="hint">{compactNumber(model.contextWindow)}{model.input.includes("image") ? " · images" : ""}</span>
    </button>
    <button type="button" class="star" class:on={favorite} tabindex="-1" aria-pressed={favorite} aria-label={favorite ? "Remove " + model.name + " from favorites" : "Add " + model.name + " to favorites"}
      use:tooltip={favorite ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(model)}><Icon name="star" size={13} /></button>
  </div>
{/snippet}

<div class="picker">
  {#if error}
    <div class="note">{error}</div>
  {:else if !catalog}
    <div class="note"><span class="spinner tiny"></span> Loading models</div>
  {:else}
    <input class="field filter" placeholder="Search models" aria-label="Search models" data-autofocus bind:value={query} onkeydown={onKey}
      role="combobox" aria-expanded="true" aria-controls="model-options" aria-activedescendant={active >= 0 ? "model-option-" + active : undefined} />
    <div id="model-options" bind:this={list}>
      {#if defaultLabel !== null && !needle}
        <button type="button" class="menu-item" class:current={current === null} onclick={() => ondefault?.()}>Default{#if defaultLabel}<span class="hint">{defaultLabel}</span>{/if}</button>
      {/if}
      {#if favoriteModels.length}
        <div class="menu-heading">Favorites</div>
        {#each favoriteModels as model, index (keyOf(model))}{@render row(model, index)}{/each}
      {/if}
      {#each groups as group (group.provider)}
        {@const offset = favoriteModels.length + groups.slice(0, groups.indexOf(group)).reduce((sum, entry) => sum + entry.models.length, 0)}
        <div class="menu-heading" class:faint={!group.configured}>{providerName(group.provider)}{group.configured ? "" : ", no key"}</div>
        {#each group.models as model, index (keyOf(model))}{@render row(model, offset + index)}{/each}
      {/each}
      {#if needle && !groups.length}<div class="note">No model matches.</div>{/if}
    </div>
  {/if}
  {#if levels.length}
    <div class="effort">
      <span class="effort-label" id="effort-label">Effort</span>
      <div class="segmented" role="radiogroup" aria-labelledby="effort-label">
        {#if defaultEffort}
          <button type="button" role="radio" aria-checked={effort === null} class:on={effort === null} onclick={() => oneffort(null)}>Default</button>
        {/if}
        {#each levels as level (level)}
          <button type="button" role="radio" aria-checked={effort === level} class:on={effort === level} onclick={() => oneffort(level)}>{level}</button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .picker { display: flex; flex-direction: column; }
  .note { display: flex; align-items: center; gap: 8px; padding: 10px; font-size: 12.5px; color: var(--text-muted); }
  .filter { margin: 2px 0 4px; }
  .row { display: flex; align-items: center; gap: 2px; }
  .row .menu-item { flex: 1; min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .star { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--radius-small); color: var(--text-faint); opacity: 0; }
  .row:hover .star, .star:focus-visible, .star.on { opacity: 1; }
  .star:hover { background: var(--bg-hover); color: var(--text); }
  .star.on { color: var(--warning); }
  .star.on :global(svg) { fill: currentColor; }
  .effort { position: sticky; bottom: -4px; display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin: 4px -4px -4px; padding: 8px 10px 10px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
  .effort-label { font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .effort .segmented { display: flex; }
  .effort .segmented > button { flex: 1 1 0; min-width: 0; padding: 0 2px; font-size: 11.5px; }
</style>
