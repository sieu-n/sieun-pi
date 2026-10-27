<script lang="ts" generics="T extends string">
  import Icon from "./Icon.svelte";
  import Badge from "./Badge.svelte";
  import type { TabItem } from "./types";

  type Props = {
    items: TabItem<T>[];
    value: T;
    /** segmented: inset track with a pill selection. chrome: the top bar capsule tabs. underline: panel tabs. */
    variant?: "segmented" | "chrome" | "underline";
    size?: "sm" | "md";
    label?: string;
    full?: boolean;
    /** Drop the track fill and padding, for tabs that sit inside another capsule. */
    embedded?: boolean;
    onchange?: (value: T) => void;
  };
  let { items, value = $bindable(), variant = "segmented", size = "md", label, full = false, embedded = false, onchange }: Props = $props();

  function pick(item: TabItem<T>) {
    if (item.disabled) return;
    value = item.id;
    onchange?.(item.id);
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const enabled = items.filter((i) => !i.disabled);
    const at = enabled.findIndex((i) => i.id === value);
    const next = enabled[(at + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    if (!next) return;
    e.preventDefault();
    pick(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
  }
</script>

<div class="tabs {variant} {size}" class:full class:embedded role="tablist" aria-label={label} tabindex="-1" onkeydown={onKeydown}>
  {#each items as item (item.id)}
    {@const selected = item.id === value}
    <svelte:element
      this={item.href ? "a" : "button"}
      href={item.href}
      type={item.href ? undefined : "button"}
      class="tab"
      role="tab"
      data-tab={item.id}
      aria-selected={selected}
      aria-disabled={item.disabled || undefined}
      tabindex={selected ? 0 : -1}
      onclick={() => pick(item)}
    >
      {#if item.icon}<Icon name={item.icon} size={size === "sm" ? 16 : 18} />{/if}
      <span>{item.label}</span>
      {#if item.badge != null && item.badge !== 0}<Badge value={item.badge} tone={variant === "chrome" ? "danger" : "neutral"} />{/if}
    </svelte:element>
  {/each}
</div>

<style>
  .tabs {
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
  .full {
    display: flex;
    width: 100%;
  }
  .full .tab {
    flex: 1;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 0;
    background: transparent;
    white-space: nowrap;
    text-decoration: none;
    transition:
      background-color var(--duration-fast) var(--ease-standard),
      color var(--duration-fast) var(--ease-standard),
      box-shadow var(--duration-fast) var(--ease-standard);
  }
  .tab[aria-disabled="true"] {
    opacity: 0.45;
    cursor: default;
  }

  .segmented {
    height: 32px;
    padding: 2px;
    gap: 2px;
    border-radius: var(--radius-pill);
    background: var(--surface-inset);
  }
  .segmented.sm {
    height: 28px;
  }
  .segmented .tab {
    height: 100%;
    padding: 0 12px;
    border-radius: var(--radius-pill);
    font: var(--text-label-sm);
    letter-spacing: var(--tracking-label-sm);
    color: var(--text-subtle);
  }
  .segmented .tab:hover {
    color: var(--text-standard);
  }
  .segmented .tab[aria-selected="true"] {
    background: var(--surface-panel);
    color: var(--text-standard);
    box-shadow: var(--shadow-panel);
  }

  .chrome {
    height: var(--size-nav-track);
    padding: 4px;
    gap: 2px;
    border-radius: var(--radius-pill);
    background: var(--affordance-chrome);
  }
  .chrome .tab {
    height: var(--size-nav-tab);
    padding: 0 16px;
    border-radius: var(--radius-pill);
    font: var(--text-label);
    color: var(--text-chrome-subtle);
  }
  .chrome .tab:hover {
    background: var(--affordance-chrome-hover);
  }
  .chrome .tab[aria-selected="true"] {
    background: var(--bg-chrome-selected);
    color: var(--text-standard);
    box-shadow: var(--shadow-xs);
  }

  .embedded {
    height: auto;
    padding: 0;
    background: transparent;
  }

  .underline {
    gap: 16px;
    height: 40px;
    border-bottom: 1px solid var(--border-standard);
  }
  .underline .tab {
    height: 100%;
    padding: 0 2px;
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    font: var(--text-label-sm);
    color: var(--text-subtle);
  }
  .underline .tab:hover {
    color: var(--text-standard);
  }
  .underline .tab[aria-selected="true"] {
    color: var(--text-standard);
    border-bottom-color: var(--text-standard);
  }
</style>
