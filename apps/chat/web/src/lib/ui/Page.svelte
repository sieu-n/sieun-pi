<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    /** Fixed content above the scroll area, for example a PanelHeader. */
    header?: Snippet;
    /** Max width of the centered column. "full" fills the panel. */
    measure?: "narrow" | "default" | "wide" | "full";
    children: Snippet;
  };
  let { header, measure = "default", children }: Props = $props();
</script>

<div class="page">
  {#if header}{@render header()}{/if}
  <div class="scroll">
    <div class="column {measure}">{@render children()}</div>
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-section-gap);
    margin: 0 auto;
    padding: 32px var(--space-panel-inset) 48px;
  }
  .narrow {
    max-width: 40rem;
  }
  .default {
    max-width: var(--timeline-measure);
  }
  .wide {
    max-width: 72rem;
  }
  .full {
    max-width: none;
  }
</style>
