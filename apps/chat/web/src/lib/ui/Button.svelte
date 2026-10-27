<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import Spinner from "./Spinner.svelte";

  type Variant = "primary" | "accent" | "outline" | "ghost" | "plain" | "danger";
  type Size = "sm" | "md" | "lg";
  type Props = Omit<HTMLButtonAttributes, "children"> & {
    /** primary is the black (white in dark) prominent button, accent is the lime Send-style button. */
    variant?: Variant;
    size?: Size;
    /** Leading icon name. */
    icon?: string;
    /** Trailing icon name, for example "chevron-down" on a menu button. */
    trailingIcon?: string;
    loading?: boolean;
    /** Render as a link. */
    href?: string;
    full?: boolean;
    /** The rendered button or link, for anchoring a Menu or Picker. */
    element?: HTMLElement | undefined;
    children?: Snippet;
  };
  let {
    variant = "outline",
    size = "md",
    icon,
    trailingIcon,
    loading = false,
    href,
    full = false,
    disabled = false,
    type = "button",
    class: className = "",
    element = $bindable(),
    children,
    ...rest
  }: Props = $props();
  const iconSize = $derived(size === "lg" ? 20 : 16);
</script>

{#snippet inner()}
  {#if loading}
    <Spinner size={iconSize - 2} />
  {:else if icon}
    <Icon name={icon} size={iconSize} />
  {/if}
  {#if children}<span class="label">{@render children()}</span>{/if}
  {#if trailingIcon}<Icon name={trailingIcon} size={iconSize} />{/if}
{/snippet}

{#if href}
  <a bind:this={element} class="btn {variant} {size} {className}" class:full {href} aria-disabled={disabled || loading} data-variant={variant}>
    {@render inner()}
  </a>
{:else}
  <button
    bind:this={element}
    class="btn {variant} {size} {className}"
    class:full
    {type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    data-variant={variant}
    {...rest}
  >
    {@render inner()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    font: var(--text-label-sm);
    letter-spacing: var(--tracking-label-sm);
    white-space: nowrap;
    text-decoration: none;
    user-select: none;
    transition:
      background-color var(--duration-fast) var(--ease-standard),
      border-color var(--duration-fast) var(--ease-standard),
      transform var(--duration-fast) var(--ease-standard);
  }
  .btn:active:not(:disabled) {
    transform: scale(0.98);
  }
  .btn:disabled,
  .btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }
  .full {
    width: 100%;
  }
  .sm {
    height: 28px;
    padding: 0 12px;
  }
  .md {
    height: 32px;
    padding: 0 14px;
  }
  .lg {
    height: 40px;
    padding: 0 20px;
    font: var(--text-label);
  }
  .primary {
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
  }
  .primary:hover {
    background: var(--affordance-prominent-hover);
  }
  .accent {
    background: var(--affordance-accent-prominent);
    color: var(--text-on-accent);
  }
  .accent:hover {
    background: var(--affordance-accent-prominent-hover);
  }
  .accent:active {
    background: var(--affordance-accent-prominent-pressed);
  }
  .outline {
    background: var(--surface-panel);
    border-color: var(--border-standard);
    color: var(--text-standard);
  }
  .outline:hover {
    background: var(--surface-inset);
  }
  .ghost {
    background: transparent;
    color: var(--text-standard);
  }
  .ghost:hover {
    background: var(--affordance-ghost-hover);
  }
  .ghost:active {
    background: var(--affordance-ghost-pressed);
  }
  .plain {
    background: transparent;
    color: var(--text-subtle);
    padding-inline: 4px;
    height: auto;
  }
  .plain:hover {
    color: var(--text-standard);
  }
  .danger {
    background: var(--border-danger);
    color: #fff;
  }
  .danger:hover {
    filter: brightness(0.95);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
