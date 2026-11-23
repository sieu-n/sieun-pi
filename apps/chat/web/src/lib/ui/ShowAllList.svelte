<script lang="ts" generics="T">
  /**
   * A long list that shows its first 10 rows and then a "Show all N" control that expands it (owner rule c123). The row snippet draws one
   * `<li>`. Expanded, it draws 10 more rows at once and then twice as many each frame, so hundreds of rows never block the first paint.
   */
  import type { Snippet } from "svelte";

  type Props = {
    items: readonly T[];
    key: (item: T) => string;
    row: Snippet<[T, number]>;
    /** The plural noun the control names, as in "Show all 31 skills". */
    noun: string;
    limit?: number;
    open?: boolean;
    /** Rows that sit flush, one line each, rather than cards with a gap between them. */
    dense?: boolean;
    label?: string;
    testid?: string;
  };
  let { items, key, row, noun, limit = 10, open = $bindable(false), dense = false, label, testid }: Props = $props();

  let drawn = $state(0);
  $effect(() => {
    if (!open) return void (drawn = limit);
    if (drawn >= items.length) return;
    const frame = requestAnimationFrame(() => (drawn = Math.min(items.length, Math.max(limit, drawn) * 2)));
    return () => cancelAnimationFrame(frame);
  });
  const shown = $derived(items.length <= limit ? items : items.slice(0, open ? Math.max(drawn, limit) : limit));
</script>

<ul class="show-all-list" class:dense aria-label={label} data-testid={testid}>
  {#each shown as item, index (key(item))}{@render row(item, index)}{/each}
</ul>
{#if items.length > limit}
  <button type="button" class="show-all t-caption" aria-expanded={open} onclick={() => (open = !open)}>
    {open ? `Show fewer ${noun}` : `Show all ${items.length} ${noun}`}
  </button>
{/if}

<style>
  .show-all-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .dense {
    gap: 0;
  }
  .show-all {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-decoration: underline;
    white-space: nowrap;
    cursor: pointer;
  }
  .show-all:hover {
    color: var(--text-standard);
  }
</style>
