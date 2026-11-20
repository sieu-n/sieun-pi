<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/ui/Icon.svelte";

  /**
   * One block of a root's sidebar: a heading and its rows, as Slack draws Channels or Direct messages. With `ontoggle` the heading is a fold
   * button and `folded` hides the rows the caller leaves out; the caller decides which rows stay, such as the open one.
   */
  type Props = {
    /** On `data-section`, for specs and drop targets. */
    id: string;
    label: string;
    /** A count after the label in light ink, such as the number of rows a folded block hides. */
    count?: number;
    folded?: boolean;
    ontoggle?: () => void;
    /** Hover buttons at the right of the heading, such as "+" or "...". */
    actions?: Snippet;
    /** Shown in place of the rows when the block is open and has none. */
    empty?: string;
    /** True when the block has no rows, so `empty` shows. */
    isEmpty?: boolean;
    children?: Snippet;
  };
  let { id, label, count, folded = false, ontoggle, actions, empty, isEmpty = false, children }: Props = $props();
</script>

<section class="section" data-section={id} aria-label={label}>
  <div class="heading">
    <h2>
      {#if ontoggle}
        <button type="button" class="fold" aria-expanded={!folded} data-fold={id} onclick={ontoggle}>
          <Icon name="chevron-right" size={14} />
          <span class="label">{label}</span>
          {#if count !== undefined}<span class="count">{count}</span>{/if}
        </button>
      {:else}
        <span class="plain"><span class="label">{label}</span>{#if count !== undefined}<span class="count">{count}</span>{/if}</span>
      {/if}
    </h2>
    {#if actions}<span class="actions">{@render actions()}</span>{/if}
  </div>
  <div class="rows">
    {@render children?.()}
    {#if isEmpty && !folded && empty}<p class="empty">{empty}</p>{/if}
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 28px;
    padding: 0 4px 0 0;
  }
  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .fold,
  .plain {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    height: 28px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .plain {
    padding-left: 8px;
  }
  .fold {
    cursor: pointer;
  }
  .fold:hover {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .fold :global(.icon) {
    flex: none;
    margin: 0 3px;
    transition: transform var(--duration-base) var(--ease-standard);
  }
  .fold[aria-expanded="true"] :global(.icon) {
    transform: rotate(90deg);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    margin-left: 6px;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
  }
  .heading:hover .actions,
  .actions:focus-within,
  .actions:has(:global([aria-expanded="true"])) {
    opacity: 1;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .empty {
    margin: 0;
    padding: 4px 8px;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
</style>
