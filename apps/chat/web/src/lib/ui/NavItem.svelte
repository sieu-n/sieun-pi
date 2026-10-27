<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    label: string;
    /** Second line in subtle ink. */
    detail?: string;
    icon?: string;
    /** Replaces the icon, for example an Avatar. */
    leading?: Snippet;
    /** Trailing content, for example a time, badge or chevron. */
    trailing?: Snippet;
    /** Rich label content, for example highlighted search matches. Replaces `label` in the view. */
    labelContent?: Snippet;
    detailContent?: Snippet;
    href?: string;
    selected?: boolean;
    /** Keyboard highlight in a list driven by arrow keys, separate from selection. */
    highlighted?: boolean;
    /**
     * row: 32 px list row. search: 64 px two-line result row. card: a padded row inside a settings card.
     * inbox: a top-aligned row with a 32 px lead, a heading with a trailing time that gives way to `action` on hover,
     * a two-line preview and a gray selected fill.
     */
    variant?: "row" | "search" | "card" | "inbox";
    /** Inbox rows: controls shown in place of `trailing` on hover or keyboard focus. */
    action?: Snippet;
    unread?: boolean;
    disabled?: boolean;
    role?: string;
    id?: string;
    onclick?: (e: MouseEvent) => void;
    oncontextmenu?: (e: MouseEvent) => void;
    onpointerenter?: (e: PointerEvent) => void;
    [key: string]: unknown;
  };
  let {
    label,
    detail,
    icon,
    leading,
    trailing,
    action,
    labelContent,
    detailContent,
    href,
    selected = false,
    highlighted = false,
    variant = "row",
    unread = false,
    disabled = false,
    role,
    id,
    onclick,
    oncontextmenu,
    onpointerenter,
    ...rest
  }: Props = $props();

  const tag = $derived(href ? "a" : variant === "inbox" && action ? "div" : "button");
  function onDivKey(e: KeyboardEvent) {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).click();
  }
</script>

<!-- An inbox row with actions is a focusable div, because a button cannot hold the action buttons. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
  this={tag}
  {href}
  type={tag === "button" ? "button" : undefined}
  tabindex={tag === "div" ? 0 : undefined}
  onkeydown={tag === "div" ? onDivKey : undefined}
  class="nav-item {variant}"
  class:selected
  class:highlighted
  class:unread
  aria-current={selected && href ? "page" : undefined}
  aria-selected={role === "option" ? highlighted || selected : undefined}
  aria-disabled={disabled || undefined}
  role={role ?? (tag === "div" ? "button" : undefined)}
  {id}
  {onclick}
  {oncontextmenu}
  {onpointerenter}
  {...rest}
>
  {#if leading || icon}
    <span class="lead">{#if leading}{@render leading()}{:else if icon}<Icon name={icon} size={variant === "search" ? 20 : 18} />{/if}</span>
  {/if}
  {#if variant === "inbox"}
    <span class="text">
      <span class="head">
        <span class="label">{#if labelContent}{@render labelContent()}{:else}{label}{/if}</span>
        {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
        {#if action}<span class="action">{@render action()}</span>{/if}
      </span>
      {#if detailContent || detail}<span class="detail">{#if detailContent}{@render detailContent()}{:else}{detail}{/if}</span>{/if}
    </span>
  {:else}
    <span class="text">
      <span class="label">{#if labelContent}{@render labelContent()}{:else}{label}{/if}</span>
      {#if detailContent || detail}<span class="detail">{#if detailContent}{@render detailContent()}{:else}{detail}{/if}</span>{/if}
    </span>
    {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
  {/if}
</svelte:element>

<style>
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: var(--text-navigation);
    text-align: left;
    text-decoration: none;
    font: var(--text-body-sm);
    letter-spacing: var(--tracking-body-sm);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .row {
    min-height: 32px;
  }
  .search {
    min-height: 64px;
    padding: 12px;
    border-radius: var(--radius-control);
    gap: 12px;
    color: var(--text-standard);
  }
  .card {
    min-height: 52px;
    padding: 10px 16px;
    border-radius: 0;
    color: var(--text-standard);
  }
  .inbox {
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    border-radius: var(--radius-control);
    color: var(--text-standard);
  }
  .inbox .lead {
    min-width: 32px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }
  .head .label {
    flex: 1;
    min-width: 0;
  }
  .inbox .detail {
    display: -webkit-box;
    max-width: 64ch;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: normal;
  }
  .action {
    display: none;
    align-items: center;
    gap: 2px;
    margin: -6px -4px -6px 0;
  }
  .inbox:hover .action,
  .inbox:focus-within .action,
  .inbox:focus-visible .action {
    display: inline-flex;
  }
  .inbox:hover:has(.action) .trail,
  .inbox:focus-within:has(.action) .trail,
  .inbox:focus-visible:has(.action) .trail {
    display: none;
  }
  .nav-item:hover,
  .highlighted {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .search:hover,
  .search.highlighted,
  .card:hover,
  .inbox:hover,
  .inbox.highlighted {
    background: var(--bg-app);
    color: var(--text-standard);
  }
  .inbox.selected,
  .inbox.selected:hover {
    background: var(--interaction-selected);
    color: var(--text-standard);
  }
  .inbox.selected .detail {
    opacity: 1;
  }
  .selected,
  .selected:hover {
    background: var(--surface-sidebar-selected);
    color: var(--text-sidebar-selected);
  }
  .unread .label {
    font-weight: 500;
    color: var(--text-navigation-unread);
  }
  .nav-item[aria-disabled="true"] {
    opacity: 0.45;
    pointer-events: none;
  }
  .lead {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: 20px;
    color: var(--text-subtle);
  }
  .selected .lead {
    color: inherit;
  }
  .search .lead {
    min-width: 24px;
  }
  .text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
  }
  .label,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .row .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .selected .detail {
    color: inherit;
    opacity: 0.75;
  }
  .trail {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
</style>
