<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The floating action bar over the top right of a row or card, as Slack draws it over a message. It shows while its host, the nearest
   * `[data-action-host]` around it, is hovered or holds keyboard focus, and stays up while `open` is set, such as while its menu or picker is open.
   * A host sets `--action-bar-top`, `--action-bar-right` and `--action-bar-left` to move it, and `inside` drops it within the host's top
   * edge when the host sits at the top of its scroller, where the space above would cut it off.
   */
  type Props = { label: string; open?: boolean; inside?: boolean; children: Snippet };
  let { label, open = false, inside = false, children }: Props = $props();
</script>

<div class="bar" class:open class:inside role="toolbar" aria-label={label} data-action-bar>
  {@render children()}
</div>

<style>
  .bar {
    position: absolute;
    top: var(--action-bar-top, -18px);
    right: var(--action-bar-right, 8px);
    left: var(--action-bar-left, auto);
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
  :global([data-action-host]:focus-visible) .bar,
  :global([data-action-host]:has(:focus-visible)) .bar,
  .bar.open {
    opacity: 1;
    pointer-events: auto;
  }
  .bar.inside {
    top: 2px;
  }
  /* A host that mounts its bar on the first hover still fades it in, as on every later hover. */
  @starting-style {
    :global([data-action-host]:hover) .bar {
      opacity: 0;
    }
  }
  .bar :global([role="separator"]) {
    align-self: center;
    width: 1px;
    height: 16px;
    margin: 0 2px;
    background: var(--border-standard);
  }
</style>
