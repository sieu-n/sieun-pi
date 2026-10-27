<script lang="ts">
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import ResizeHandle from "$lib/ui/ResizeHandle.svelte";
  import { SIDE_PANEL_DEFAULT, SIDE_PANEL_MIN, sidePanel } from "./side-panel.svelte";

  type Props = { maxWidth: number };
  let { maxWidth }: Props = $props();
  const content = $derived(sidePanel.content);
  const width = $derived(Math.min(sidePanel.width, Math.max(SIDE_PANEL_MIN, maxWidth)));
</script>

{#if content}
  <aside class="side-panel" style:width="{width}px" aria-label={content.title} data-panel-key={content.key} data-testid="side-panel">
    <ResizeHandle
      size={width}
      min={SIDE_PANEL_MIN}
      max={Math.max(SIDE_PANEL_MIN, maxWidth)}
      edge="end"
      label="Resize side panel"
      onresize={(px) => (sidePanel.width = px)}
      oncommit={(px) => sidePanel.setWidth(px)}
      ondoubleclick={() => sidePanel.setWidth(SIDE_PANEL_DEFAULT)}
    />
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
