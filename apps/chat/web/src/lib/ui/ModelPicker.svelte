<script lang="ts">
  import Icon from "./Icon.svelte";
  import Input from "./Input.svelte";
  import Picker from "./Picker.svelte";
  import Tabs from "./Tabs.svelte";
  import type { ModelOption } from "./types";

  type Props = {
    models: ModelOption[];
    /** Selected model id. */
    value: string;
    /** Thinking effort levels in order, for example ["low", "medium", "high"]. Empty hides the control. */
    efforts?: string[];
    effort?: string;
    /** pill: the inline glass-ghost trigger for cards and the composer. field: a bordered control for forms. */
    variant?: "pill" | "field";
    /** Allow a model id that is not in the list. */
    allowCustom?: boolean;
    disabled?: boolean;
    /** Open state, bindable so a card menu's "Change model" can open the picker. */
    open?: boolean;
    onchange: (next: { model: string; effort?: string }) => void;
  };
  let { models, value, efforts = [], effort, variant = "pill", allowCustom = true, disabled = false, open = $bindable(false), onchange }: Props = $props();

  let trigger = $state<HTMLButtonElement>();
  let custom = $state("");
  const current = $derived(models.find((m) => m.id === value));
  const items = $derived(models.map((m) => ({ id: m.id, label: m.label, detail: m.detail, group: m.family, keywords: [m.id] })));
  const effortTabs = $derived(efforts.map((e) => ({ id: e, label: e[0]!.toUpperCase() + e.slice(1) })));
</script>

<button bind:this={trigger} type="button" class="trigger {variant}" {disabled} aria-haspopup="dialog" aria-expanded={open} onclick={() => (open = !open)}>
  <span class="name">{current?.label ?? value}</span>
  {#if effort}<span class="effort">{effort}</span>{/if}
  <Icon name="chevron-down" size={14} />
</button>

<Picker bind:open anchor={trigger} {items} {value} width={320} searchable={models.length > 7} placeholder="Search models" label="Model" onselect={(id) => onchange({ model: id, ...(effort ? { effort } : {}) })}>
  {#snippet footer({ query, close })}
    {#if efforts.length}
      <div class="efforts">
        <span class="row-label">Thinking</span>
        <Tabs items={effortTabs} value={effort ?? efforts[0]!} size="sm" full label="Thinking effort" onchange={(e) => onchange({ model: value, effort: e })} />
      </div>
    {/if}
    {#if allowCustom}
      <form
        class="row"
        onsubmit={(e) => {
          e.preventDefault();
          const id = (custom || query).trim();
          if (!id) return;
          onchange({ model: id, ...(effort ? { effort } : {}) });
          custom = "";
          close();
        }}
      >
        <Input size="sm" bind:value={custom} placeholder={query || "Custom model ID"} aria-label="Custom model ID" />
        <button type="submit" class="use">Use model</button>
      </form>
    {/if}
  {/snippet}
</Picker>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    border: 0;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .trigger:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pill {
    height: 24px;
    padding: 0 8px;
    border-radius: var(--radius-pill);
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
  }
  .pill:hover:not(:disabled),
  .pill[aria-expanded="true"] {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
  .field {
    height: 40px;
    width: 100%;
    padding: 0 12px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--surface-panel);
    font: var(--text-body);
    color: var(--text-standard);
  }
  .field .name {
    flex: 1;
    text-align: left;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .effort {
    color: var(--text-metadata);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px 2px;
  }
  .efforts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 4px 2px;
  }
  .efforts :global(.tab) {
    min-width: 0;
    padding: 0 4px;
    font: var(--text-caption);
    font-weight: 500;
  }
  .row-label {
    flex: 1;
    padding-left: 6px;
    font: var(--text-caption);
    color: var(--text-subtle);
  }
  .use {
    flex: none;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
    font: var(--text-caption);
    font-weight: 500;
  }
</style>
