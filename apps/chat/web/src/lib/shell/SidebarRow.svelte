<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import Badge from "$lib/ui/Badge.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";

  type Props = {
    href: string;
    label: string;
    icon?: string;
    /** Replaces the icon, for example an Avatar for a DM. */
    leading?: Snippet;
    selected?: boolean;
    /** Count badge, for mentions of the owner and open todos. */
    unread?: number;
    /** New activity since the read mark: bold label and a dot when there is no count. */
    fresh?: boolean;
    /** Agents working here now; non-empty shows typing dots in place of the badge. */
    working?: string[];
    title?: string;
    oncontextmenu?: (e: MouseEvent) => void;
    /** A hover button at the right end, such as the row's "..." menu; the badge or typing dots move left of it. */
    actions?: Snippet;
    /** Makes the row draggable, for moving a channel between sidebar sections. */
    ondragstart?: (e: DragEvent) => void;
    /** Shown at the right end when the row has no typing dots, count or dot, such as a light count or a danger badge. */
    trailing?: Snippet;
  };
  let { href, label, icon, leading, selected = false, unread = 0, fresh = false, working = [], title, oncontextmenu, actions, ondragstart, trailing }: Props = $props();
  const workingLabel = $derived(working.length ? `${working.join(", ")} working in ${label}` : "");
</script>

{#snippet link()}
  <a
    {href}
    class="row"
    class:selected
    class:unread={fresh || unread > 0}
    aria-current={selected ? "page" : undefined}
    title={title ?? label}
    data-sidebar-row
    data-unread={fresh || unread > 0 || undefined}
    data-working={working.length > 0 || undefined}
    {oncontextmenu}
    {ondragstart}
    draggable={ondragstart ? "true" : undefined}
  >
    <span class="lead">
      {#if leading}{@render leading()}{:else if icon}<Icon name={icon} size={16} />{/if}
    </span>
    <span class="label">{label}</span>
    <span class="trail">
      {#if working.length}
        <span class="working" title={workingLabel}><TypingDots label={workingLabel} /></span>
      {:else if unread > 0}
        <Badge value={unread} title="{unread} unread" />
      {:else if fresh}
        <Badge dot title="New activity" />
      {:else if trailing}
        {@render trailing()}
      {/if}
    </span>
  </a>
{/snippet}

{#if actions}
  <div class="item" class:selected>
    {@render link()}
    <span class="actions">{@render actions()}</span>
  </div>
{:else}
  {@render link()}
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--size-row);
    padding: 0 8px;
    border-radius: var(--radius-row);
    color: var(--text-navigation);
    font: var(--text-body-sm);
    letter-spacing: var(--tracking-body-sm);
    text-decoration: none;
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .row:hover {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .row.unread {
    color: var(--text-navigation-unread);
    font-weight: 500;
  }
  .row.selected {
    background: var(--surface-sidebar-selected);
    color: var(--text-sidebar-selected);
  }
  .lead {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex: none;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trail {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .working {
    display: inline-flex;
    color: var(--text-subtle);
  }
  .selected .trail :global(.dot) {
    background: var(--text-sidebar-selected);
  }
  .selected .working {
    color: var(--text-sidebar-selected);
  }
  .item {
    position: relative;
  }
  .actions {
    position: absolute;
    top: 50%;
    right: 4px;
    display: inline-flex;
    transform: translateY(-50%);
    opacity: 0;
  }
  .item:hover .row:not(.selected) {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .item:hover .row,
  .item:focus-within .row,
  .item:has(.actions :global([aria-expanded="true"])) .row {
    padding-right: 28px;
  }
  .item:hover .actions,
  .item:focus-within .actions,
  .actions:has(:global([aria-expanded="true"])) {
    opacity: 1;
  }
  .item.selected .actions :global(.icon-btn) {
    color: var(--text-sidebar-selected);
  }
</style>
