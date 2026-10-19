<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { ChatDefaults, ChatDefaultsInput, ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import Select, { type SelectOption } from "./ui/Select.svelte";
  import SettingsActions from "./SettingsActions.svelte";

  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let defaults = $state<ChatDefaults | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  /** The New chat box's start skill (null: no checkbox there) and the skills this Mac has, for the picker. */
  let startSkill = $state<string | null>(null);
  let skills = $state<string[]>([]);
  const skillOptions = $derived<SelectOption[]>([{ value: "", label: "None" },
    ...[...new Set([...(startSkill ? [startSkill] : []), ...skills])].sort().map(name => ({ value: name, label: name }))]);

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
    const [nextCatalog, nextDefaults, nextNewChat, nextCommands] = await Promise.allSettled([api.models(null), api.defaults(), api.newChat(), api.commands(null)]);
    if (nextNewChat.status === "fulfilled") startSkill = nextNewChat.value.startSkill;
    if (nextCommands.status === "fulfilled") skills = nextCommands.value.filter(command => command.source === "skill" && command.name.startsWith("skill:")).map(command => command.name.slice("skill:".length));
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
  async function chooseStartSkill(value: string): Promise<void> {
    const next = await store.run(api.setNewChat({ startSkill: value || null }));
    if (next) { startSkill = next.startSkill; store.defaultsRevision++; }
  }
  const choose = (next: ModelInfo) => save({ provider: next.provider, modelId: next.id, thinkingLevel: effort && next.thinkingLevels?.includes(effort) ? effort : null });
  const chooseEffort = (level: ThinkingLevel | null) => { if (model && level) void save({ provider: model.provider, modelId: model.id, thinkingLevel: level }); };
</script>

<section class="pane" aria-label="New chats">
  <SettingsActions>
    <button class="icon-button small" disabled={loading} aria-label="Reload defaults" use:tooltip={"Reload defaults"} onclick={() => void load()}>
      {#if loading}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
    </button>
  </SettingsActions>
  {#if error && !defaults}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Defaults unavailable. {error}</div>
      <button class="button small" onclick={() => void load()}>Retry</button>
    </div>
  {:else if !defaults || (!catalog && !catalogError)}
    <div class="empty muted"><Spinner size="normal" /> Loading defaults</div>
  {:else}
    <p class="current" aria-live="polite">
      {#if saving}<Spinner />{/if}
      <span class:muted={!model}>{sentence}</span>
    </p>
    <p class="note">The model and effort every new chat starts with, here and in the terminal. Changing the model or effort on a thread changes them too.</p>
    <div class="menu" class:busy={saving}>
      <ModelMenu {catalog} error={catalogError} current={model} {effort} {levels} onchoose={choose} oneffort={chooseEffort} />
    </div>
    <div class="start-skill">
      <Select label="Start skill" options={skillOptions} value={startSkill ?? ""} resetValue="" width={280} onchange={value => void chooseStartSkill(value)} />
      <p class="note">{startSkill ? `New threads and chats start their first message with /skill:${startSkill}. The New chat box has a checkbox to skip it once.` : "Pick a skill to start the first message of every new thread and chat with it."}</p>
    </div>
  {/if}
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .note { margin: -6px 0 0; color: var(--text-muted); line-height: 1.4; }
  .menu { max-height: 420px; overflow: auto; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .start-skill { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .start-skill .note { margin: 0; }
  .menu.busy { opacity: 0.7; pointer-events: none; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
