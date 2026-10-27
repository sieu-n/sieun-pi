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
    /** row: 32 px list row. search: 52 px two-line result row. card: a padded row inside a settings card. */
    variant?: "row" | "search" | "card";
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
</script>

<svelte:element
  this={href ? "a" : "button"}
  {href}
  type={href ? undefined : "button"}
  class="nav-item {variant}"
  class:selected
  class:highlighted
  class:unread
  aria-current={selected && href ? "page" : undefined}
  aria-selected={role === "option" ? highlighted || selected : undefined}
  aria-disabled={disabled || undefined}
  {role}
  {id}
  {onclick}
  {oncontextmenu}
  {onpointerenter}
  {...rest}
>
  {#if leading || icon}
    <span class="lead">{#if leading}{@render leading()}{:else if icon}<Icon name={icon} size={variant === "search" ? 20 : 18} />{/if}</span>
  {/if}
  <span class="text">
    <span class="label">{#if labelContent}{@render labelContent()}{:else}{label}{/if}</span>
    {#if detailContent || detail}<span class="detail">{#if detailContent}{@render detailContent()}{:else}{detail}{/if}</span>{/if}
  </span>
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
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
    min-height: 52px;
    padding: 6px 12px;
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
  .nav-item:hover,
  .highlighted {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .search:hover,
  .search.highlighted,
  .card:hover {
    background: var(--bg-app);
    color: var(--text-standard);
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
