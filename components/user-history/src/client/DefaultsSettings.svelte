<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { ChatDefaults, ChatDefaultsInput, ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let defaults = $state<ChatDefaults | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let saving = $state(false);

  const model = $derived.by(() => {
    const saved = defaults;
    return catalog && saved ? catalog.models.find(entry => entry.provider === saved.provider && entry.id === saved.modelId) ?? null : null;
  });
  const levels = $derived(model?.thinkingLevels ?? []);
  const effort = $derived(defaults?.thinkingLevel && levels.includes(defaults.thinkingLevel) ? defaults.thinkingLevel : null);
  const sentence = $derived.by(() => {
    if (!defaults || !catalog) return "";
    if (model) return `New chats start with ${model.name}${effort ? ` at ${effort} effort` : ""}.`;
    if (defaults.modelId) return `The saved default ${defaults.provider}/${defaults.modelId} is not in the catalog. Choose a model below.`;
    return "No default set. Choose a model below.";
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    const [nextCatalog, nextDefaults] = await Promise.allSettled([api.models(null), api.defaults()]);
    if (nextCatalog.status === "fulfilled") { catalog = nextCatalog.value; catalogError = null; }
    else catalogError = nextCatalog.reason instanceof Error ? nextCatalog.reason.message : String(nextCatalog.reason);
    if (nextDefaults.status === "fulfilled") defaults = nextDefaults.value;
    else error = nextDefaults.reason instanceof Error ? nextDefaults.reason.message : String(nextDefaults.reason);
    loading = false;
  }
  onMount(() => { void load(); });

  async function save(input: ChatDefaultsInput): Promise<void> {
    saving = true;
    const next = await store.run(api.setDefaults(input));
    if (next) { defaults = next; store.defaultsRevision++; }
    saving = false;
  }
  const choose = (next: ModelInfo) => save({ provider: next.provider, modelId: next.id, thinkingLevel: effort && next.thinkingLevels?.includes(effort) ? effort : null });
  const chooseEffort = (level: ThinkingLevel | null) => { if (model && level) void save({ provider: model.provider, modelId: model.id, thinkingLevel: level }); };
</script>

<section class="defaults" aria-label="Defaults">
  <header class="bar">
    <h3>New chats</h3>
    <span class="spacer"></span>
    <button class="icon-button small" disabled={loading} aria-label="Reload defaults" use:tooltip={"Reload defaults"} onclick={() => void load()}>
      {#if loading}<span class="spinner tiny"></span>{:else}<Icon name="refresh" size={14} />{/if}
    </button>
  </header>
  {#if error && !defaults}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Defaults unavailable. {error}</div>
      <button class="button small" onclick={() => void load()}>Retry</button>
    </div>
  {:else if !defaults || (!catalog && !catalogError)}
    <div class="empty muted"><span class="spinner"></span> Loading defaults</div>
  {:else}
    <p class="current" aria-live="polite">
      {#if saving}<span class="spinner tiny"></span>{/if}
      <span class:muted={!model}>{sentence}</span>
    </p>
    <p class="note">The model and effort every new chat starts with, here and in the terminal. Changing the model or effort on a thread changes them too.</p>
    <div class="menu" class:busy={saving}>
      <ModelMenu {catalog} error={catalogError} current={model} {effort} {levels} onchoose={choose} oneffort={chooseEffort} />
    </div>
  {/if}
</section>

<style>
  .defaults { display: flex; flex-direction: column; gap: 12px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .spacer { flex: 1; }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .note { margin: -6px 0 0; color: var(--text-muted); line-height: 1.4; }
  .menu { max-height: 420px; overflow: auto; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .menu.busy { opacity: 0.7; pointer-events: none; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
