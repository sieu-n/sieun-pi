<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    /** panel is the white joined surface with --shadow-panel; inset is the recessed fill; card is a bordered card. */
    variant?: "panel" | "inset" | "card";
    radius?: "container" | "panel" | "control" | "row";
    padding?: number | string;
    /** Lay children out as a column with the header on top and a scrolling body. */
    column?: boolean;
    class?: string;
    element?: HTMLElement | undefined;
    children: Snippet;
    [key: string]: unknown;
  };
  let { variant = "panel", radius = "container", padding = 0, column = false, class: className = "", element = $bindable(), children, ...rest }: Props = $props();
</script>

<section
  bind:this={element}
  class="panel {variant} {className}"
  class:column
  style:border-radius="var(--radius-{radius})"
  style:padding={typeof padding === "number" ? `${padding}px` : padding}
  {...rest}
>
  {@render children()}
</section>

<style>
  .panel {
    position: relative;
    min-width: 0;
    min-height: 0;
    color: var(--text-standard);
  }
  .column {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel.panel {
    background: var(--surface-panel);
    box-shadow: var(--shadow-panel);
  }
  .inset {
    background: var(--surface-inset);
  }
  .card {
    background: var(--surface-panel);
    box-shadow: inset 0 0 0 1px var(--border-standard);
  }
</style>
