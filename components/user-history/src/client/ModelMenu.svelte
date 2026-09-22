<script lang="ts">
  import type { ModelCatalog, ModelInfo } from "../shared/types.ts";
  import { compactNumber } from "./format.ts";

  let { catalog, error, current, onchoose, defaultLabel = null, ondefault }: {
    catalog: ModelCatalog | null; error: string | null; current: { provider: string; id: string } | null; onchoose: (model: ModelInfo) => void;
    defaultLabel?: string | null; ondefault?: () => void;
  } = $props();
  let query = $state("");

  const groups = $derived.by(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    const configured = new Set(catalog.configuredProviders);
    const groups = new Map<string, ModelInfo[]>();
    for (const model of catalog.models) {
      if (needle && !model.name.toLowerCase().includes(needle) && !model.id.toLowerCase().includes(needle) && !model.provider.toLowerCase().includes(needle)) continue;
      const list = groups.get(model.provider);
      if (list) list.push(model); else groups.set(model.provider, [model]);
    }
    return [...groups.entries()].sort(([a], [b]) => Number(configured.has(b)) - Number(configured.has(a)) || a.localeCompare(b)).map(([provider, models]) => ({ provider, models, configured: configured.has(provider) }));
  });
  function focus(node: HTMLInputElement): void { node.focus(); }
</script>

{#if error}
  <div class="note">{error}</div>
{:else if !catalog}
  <div class="note"><span class="spinner tiny"></span> Loading models</div>
{:else}
  <input class="field filter" placeholder="Filter models" aria-label="Filter models" bind:value={query} use:focus />
  {#if defaultLabel !== null}
    <button class="menu-item" class:current={current === null} onclick={() => ondefault?.()}>Default{#if defaultLabel}<span class="hint">{defaultLabel}</span>{/if}</button>
  {/if}
  {#each groups as group (group.provider)}
    <div class="menu-heading" class:faint={!group.configured}>{group.provider}{group.configured ? "" : " (no key)"}</div>
    {#each group.models as model (group.provider + "/" + model.id)}
      <button class="menu-item" class:current={current?.id === model.id && current.provider === model.provider} onclick={() => onchoose(model)}>
        <span class="name">{model.name}</span>
        <span class="hint">{compactNumber(model.contextWindow)}{model.input.includes("image") ? " · images" : ""}</span>
      </button>
    {/each}
  {/each}
  {#if !groups.length}<div class="note">No model matches.</div>{/if}
{/if}

<style>
  .note { display: flex; align-items: center; gap: 8px; padding: 10px; font-size: 13px; color: var(--text-muted); }
  .filter { margin: 2px 2px 6px; width: calc(100% - 4px); font-size: 13px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
</style>
