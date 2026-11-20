<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    label?: string;
    /** Subtle prefix such as "from:" or "in:". */
    prefix?: string;
    icon?: string;
    leading?: Snippet;
    selected?: boolean;
    size?: "sm" | "md";
    onclick?: (e: MouseEvent) => void;
    /** Shows an x button that calls this. */
    onremove?: () => void;
    removeLabel?: string;
    /** The chip opens a dropdown, such as a search filter's: it reads as a menu button with a chevron instead of a toggle. */
    popup?: { kind: "menu" | "dialog"; open: boolean };
    /** The chip's box, which a dropdown anchors to. */
    element?: HTMLSpanElement | undefined;
    children?: Snippet;
  };
  let { label, prefix, icon, leading, selected = false, size = "md", onclick, onremove, removeLabel, popup, element = $bindable(), children }: Props = $props();
</script>

<span class="chip {size}" class:selected class:clickable={!!onclick} bind:this={element}>
  {#if onclick}
    <button
      type="button"
      class="hit"
      {onclick}
      aria-pressed={popup ? undefined : selected}
      aria-haspopup={popup?.kind}
      aria-expanded={popup ? popup.open : undefined}
    >
      {@render body()}
      {#if popup}<Icon name="chevron-down" size={14} />{/if}
    </button>
  {:else}
    {@render body()}
  {/if}
  {#if onremove}
    <button type="button" class="remove" aria-label={removeLabel ?? `Remove ${prefix ?? ""}${label ?? ""}`} onclick={onremove}><Icon name="close" size={12} /></button>
  {/if}
</span>

{#snippet body()}
  {#if leading}{@render leading()}{:else if icon}<Icon name={icon} size={14} />{/if}
  {#if prefix}<span class="prefix">{prefix}</span>{/if}
  {#if children}{@render children()}{:else if label}<span class="label">{label}</span>{/if}
{/snippet}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface-inset);
    color: var(--text-standard);
    font: var(--text-body-sm);
    letter-spacing: var(--tracking-body-sm);
    white-space: nowrap;
  }
  .sm {
    padding: 0 6px;
    font: var(--text-caption);
  }
  .chip.selected {
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
  }
  .clickable:hover:not(.selected) {
    background: var(--affordance-subtle);
  }
  .hit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
  }
  /* The ring goes around the whole chip, so a chip with an x reads as one control under the keyboard. */
  .hit:focus-visible {
    outline: none;
  }
  :global(html[data-keyboard-navigation]) .chip:has(.hit:focus-visible) {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .prefix {
    color: var(--text-subtle);
  }
  .selected .prefix {
    color: inherit;
    opacity: 0.7;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .remove {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    margin-right: -4px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-subtle);
  }
  .selected .remove {
    color: inherit;
    opacity: 0.75;
  }
  .remove:hover {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
</style>
