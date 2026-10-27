<script lang="ts">
  import type { Snippet } from "svelte";
  import TopBar from "./TopBar.svelte";
  import Sidebar from "./Sidebar.svelte";
  import SidePanelHost from "./SidePanelHost.svelte";
  import { sidebar } from "./sidebar.svelte";

  type Props = { children: Snippet; ownerName?: string };
  let { children, ownerName }: Props = $props();

  let bodyWidth = $state(1440);
  /** The main panel keeps at least this much room when the side panel grows. */
  const MAIN_MIN = 420;
  const sideMax = $derived(bodyWidth - (sidebar.collapsed ? 0 : sidebar.width + 8) - MAIN_MIN - 8);
</script>

<div class="shell texture-dots">
  <TopBar {ownerName} />
  <div class="body" bind:clientWidth={bodyWidth}>
    <div class="nav-slot" class:collapsed={sidebar.collapsed} style:--w="{sidebar.width}px">
      {#if !sidebar.collapsed}<Sidebar />{/if}
    </div>
    <main class="main-panel" data-testid="main-panel">
      {@render children()}
    </main>
    <SidePanelHost maxWidth={sideMax} />
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: var(--space-panel-gap);
    padding: 0 var(--space-panel-gap) var(--space-panel-gap);
  }
  .nav-slot {
    display: flex;
    flex: none;
    width: var(--w);
    transition:
      width var(--duration-slow) var(--ease-enter),
      margin var(--duration-slow) var(--ease-enter);
  }
  .nav-slot:has(:global(.dragging)) {
    transition: none;
  }
  .nav-slot.collapsed {
    width: 0;
    margin-right: calc(var(--space-panel-gap) * -1);
  }
  .main-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    box-shadow: var(--shadow-panel);
  }
</style>
