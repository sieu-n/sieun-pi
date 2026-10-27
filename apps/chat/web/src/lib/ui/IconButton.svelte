<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import Spinner from "./Spinner.svelte";
  import { tooltip } from "./tooltip";

  type Props = Omit<HTMLButtonAttributes, "children"> & {
    icon: string;
    /** Accessible name, also shown as the tooltip unless `tip` is false. */
    label: string;
    variant?: "ghost" | "glass" | "chrome" | "outline" | "accent" | "primary";
    size?: "xs" | "sm" | "md" | "lg";
    loading?: boolean;
    pressed?: boolean;
    tip?: boolean;
    /** Keyboard hint shown in the tooltip, for example "⌘K". */
    shortcut?: string;
    element?: HTMLButtonElement | undefined;
  };
  let {
    icon,
    label,
    variant = "ghost",
    size = "md",
    loading = false,
    pressed,
    tip = true,
    shortcut,
    disabled = false,
    type = "button",
    class: className = "",
    element = $bindable(),
    ...rest
  }: Props = $props();
  const px = $derived({ xs: 20, sm: 28, md: 32, lg: 40 }[size]);
  const iconPx = $derived(size === "xs" ? 14 : size === "lg" ? 20 : 18);
</script>

<button
  bind:this={element}
  class="icon-btn {variant} {className}"
  style:width="{px}px"
  style:height="{px}px"
  {type}
  aria-label={label}
  aria-pressed={pressed}
  disabled={disabled || loading}
  use:tooltip={tip ? { text: label, shortcut } : null}
  {...rest}
>
  {#if loading}<Spinner size={iconPx - 4} />{:else}<Icon name={icon} size={iconPx} />{/if}
</button>

<style>
  .icon-btn {
    display: inline-grid;
    place-items: center;
    flex: none;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-icon-button);
    color: var(--text-subtle);
    background: transparent;
    transition:
      background-color var(--duration-fast) var(--ease-standard),
      color var(--duration-fast) var(--ease-standard);
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text-standard);
  }
  .icon-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ghost:hover:not(:disabled),
  .ghost[aria-pressed="true"] {
    background: var(--affordance-ghost-hover);
  }
  .glass {
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
    box-shadow: var(--shadow-sm);
  }
  .chrome {
    background: var(--affordance-chrome);
    color: var(--text-chrome-subtle);
    border-radius: var(--radius-pill);
  }
  .chrome:hover:not(:disabled),
  .chrome[aria-pressed="true"] {
    background: var(--bg-chrome-selected);
  }
  .outline {
    border-color: var(--border-standard);
    background: var(--surface-panel);
  }
  .outline:hover:not(:disabled) {
    background: var(--surface-inset);
  }
  .accent {
    background: var(--affordance-accent-prominent);
    color: var(--text-on-accent);
    border-radius: 50%;
  }
  .accent:hover:not(:disabled) {
    background: var(--affordance-accent-prominent-hover);
    color: var(--text-on-accent);
  }
  .primary {
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
    border-radius: 50%;
  }
  .primary:hover:not(:disabled) {
    color: var(--text-on-prominent);
  }
</style>
