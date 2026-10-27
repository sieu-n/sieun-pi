<script lang="ts">
  import type { Snippet } from "svelte";
  import TopBar from "./TopBar.svelte";
  import Sidebar from "./Sidebar.svelte";
  import SidePanelHost from "./SidePanelHost.svelte";
  import { sidebar } from "./sidebar.svelte";
  import { router } from "$lib/router.svelte";

  type Props = { children: Snippet; ownerName?: string };
  let { children, ownerName }: Props = $props();

  let bodyWidth = $state(1440);
  /** The main panel keeps at least this much room when the side panel grows. */
  const MAIN_MIN = 420;
  /** Below this window width the side panel floats over the main panel. */
  const OVERLAY_BELOW = 1000;
  /** Below this width the sidebar becomes a drawer and the side panel fills the window. */
  const NARROW_BELOW = 650;

  const narrow = $derived(bodyWidth < NARROW_BELOW);
  const overlay = $derived(bodyWidth < OVERLAY_BELOW);
  const sidebarShown = $derived(narrow ? sidebar.drawerOpen : !sidebar.collapsed);
  const sideMax = $derived(overlay ? bodyWidth - 16 : bodyWidth - (sidebar.collapsed ? 0 : sidebar.width + 8) - MAIN_MIN - 8);

  $effect(() => {
    sidebar.narrow = narrow;
    if (!narrow) sidebar.drawerOpen = false;
  });
  $effect(() => {
    void router.route;
    sidebar.drawerOpen = false;
  });
</script>

<div class="shell texture-dots" data-layout={narrow ? "narrow" : overlay ? "overlay" : "wide"}>
  <TopBar {ownerName} />
  <div class="body" bind:clientWidth={bodyWidth}>
    {#if narrow && sidebar.drawerOpen}
      <button class="scrim" type="button" aria-label="Close sidebar" onclick={() => (sidebar.drawerOpen = false)}></button>
    {/if}
    <div class="nav-slot" class:collapsed={!sidebarShown} class:drawer={narrow} style:--w="{narrow ? 220 : sidebar.width}px">
      {#if sidebarShown}<Sidebar />{/if}
    </div>
    <main class="main-panel" data-testid="main-panel">
      {@render children()}
    </main>
    <SidePanelHost maxWidth={sideMax} {overlay} full={narrow} />
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
    position: relative;
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
  .nav-slot.drawer {
    position: absolute;
    top: 0;
    bottom: var(--space-panel-gap);
    left: var(--space-panel-gap);
    z-index: 20;
    margin: 0;
    box-shadow: var(--shadow-float);
    border-radius: var(--radius-container);
  }
  .nav-slot.drawer.collapsed {
    display: none;
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 19;
    border: 0;
    background: var(--bg-scrim);
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
