<script lang="ts">
  /** Square checkbox after the Virev SelectionCheckbox: ocean fill with a check, a softer fill with a bar when mixed, a hairline box when off. */
  let { checked, indeterminate = false, label, tabindex, onchange, visual = false }: {
    checked: boolean; indeterminate?: boolean; label?: string; tabindex?: number; onchange?: (next: boolean) => void;
    /** Draw only the box, for rows that are themselves the checkbox (menu rows, option rows). */
    visual?: boolean;
  } = $props();
  const state = $derived(checked ? "on" : indeterminate ? "mixed" : "off");
</script>

{#snippet box()}
  <span class="box {state}" aria-hidden="true">
    {#if state === "on"}<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
    {:else if state === "mixed"}<svg viewBox="0 0 24 24"><path d="M6 12h12" /></svg>{/if}
  </span>
{/snippet}

{#if visual}
  {@render box()}
{:else}
  <button type="button" class="checkbox" role="checkbox" aria-checked={indeterminate && !checked ? "mixed" : checked} aria-label={label} {tabindex}
    onclick={event => { event.stopPropagation(); onchange?.(!checked); }}>{@render box()}</button>
{/if}

<style>
  .checkbox { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 5px; vertical-align: middle; }
  .box { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--border-strong);
    background: var(--bg-elevated); color: #fff; transition: background-color 0.12s, border-color 0.12s; }
  .checkbox:hover .box.off { border-color: var(--accent); }
  .box.on { background: var(--accent-fill); border-color: var(--accent-fill); }
  .box.mixed { background: color-mix(in srgb, var(--accent-fill) 60%, transparent); border-color: var(--accent-fill); }
  svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
</style>
