<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    open?: boolean;
    title: string;
    /** Subtle text after the title, for example a count. */
    detail?: string;
    /** Controls drawn at the right of the header, outside the toggle button. */
    actions?: Snippet;
    children: Snippet;
  };
  let { open = $bindable(false), title, detail, actions, children }: Props = $props();
  const bodyId = `disc-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div class="disclosure" class:open>
  <div class="head">
    <button type="button" class="toggle" aria-expanded={open} aria-controls={bodyId} onclick={() => (open = !open)}>
      <Icon name="chevron-right" size={16} />
      <span class="title">{title}</span>
      {#if detail}<span class="detail">{detail}</span>{/if}
    </button>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
  {#if open}<div class="body" id={bodyId}>{@render children()}</div>{/if}
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    min-height: 28px;
    padding: 0 4px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    text-align: left;
  }
  .toggle:hover {
    background: var(--affordance-ghost-hover);
  }
  .toggle :global(.icon) {
    color: var(--text-subtle);
    transition: transform var(--duration-base) var(--ease-standard);
  }
  .open .toggle :global(.icon) {
    transform: rotate(90deg);
  }
  .title {
    font: var(--text-label-sm);
  }
  .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .actions {
    display: flex;
    gap: 4px;
  }
  .body {
    padding: 4px 0 4px 26px;
  }
</style>
