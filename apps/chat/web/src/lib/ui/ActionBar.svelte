<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The floating action bar over the top right of a row or card, as Slack draws it over a message. It shows while its host, the nearest
   * `[data-action-host]` around it, is hovered or holds focus, and stays up while `open` is set, such as while its menu or picker is open.
   */
  type Props = { label: string; open?: boolean; children: Snippet };
  let { label, open = false, children }: Props = $props();
</script>

<div class="bar" class:open role="toolbar" aria-label={label} data-action-bar>
  {@render children()}
</div>

<style>
  .bar {
    position: absolute;
    top: -18px;
    right: 8px;
    z-index: 2;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-row);
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
    box-shadow: var(--shadow-sm);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }
  :global([data-action-host]:hover) .bar,
  :global([data-action-host]:focus-within) .bar,
  .bar.open {
    opacity: 1;
    pointer-events: auto;
  }
  .bar :global([role="separator"]) {
    align-self: center;
    width: 1px;
    height: 16px;
    margin: 0 2px;
    background: var(--border-standard);
  }
</style>
