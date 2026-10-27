<script lang="ts">
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import ResizeHandle from "$lib/ui/ResizeHandle.svelte";
  import { SIDE_PANEL_DEFAULT, SIDE_PANEL_MIN, sidePanel } from "./side-panel.svelte";

  type Props = {
    maxWidth: number;
    /** Float over the main panel instead of taking room beside it. */
    overlay?: boolean;
    /** Fill the body, for narrow windows. */
    full?: boolean;
  };
  let { maxWidth, overlay = false, full = false }: Props = $props();
  const content = $derived(sidePanel.content);
  const width = $derived(Math.min(sidePanel.width, Math.max(SIDE_PANEL_MIN, maxWidth)));
</script>

{#if content}
  <aside class="side-panel" class:overlay class:full style:width={full ? undefined : `${width}px`} aria-label={content.title} data-panel-key={content.key} data-testid="side-panel">
    {#if !full}<ResizeHandle
      size={width}
      min={SIDE_PANEL_MIN}
      max={Math.max(SIDE_PANEL_MIN, maxWidth)}
      edge="end"
      label="Resize side panel"
      onresize={(px) => (sidePanel.width = px)}
      oncommit={(px) => sidePanel.setWidth(px)}
      ondoubleclick={() => sidePanel.setWidth(SIDE_PANEL_DEFAULT)}
    />{/if}
    {#if content.header}
      {@render content.header()}
    {:else}
      <PanelHeader title={content.title} icon={content.icon} actions={content.actions} closeLabel="Close {content.title.toLowerCase()}" onclose={() => sidePanel.close()} />
    {/if}
    <div class="body">{@render content.body()}</div>
  </aside>
{/if}

<style>
  .side-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: none;
    min-height: 0;
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    box-shadow: var(--shadow-panel);
    animation: slide var(--duration-slow) var(--ease-enter);
  }
  .overlay {
    position: absolute;
    top: 0;
    right: var(--space-panel-gap);
    bottom: var(--space-panel-gap);
    z-index: 15;
    box-shadow: var(--shadow-float);
  }
  .full {
    left: var(--space-panel-gap);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }
</style>
