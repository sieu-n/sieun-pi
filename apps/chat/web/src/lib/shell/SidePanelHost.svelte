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
  let aside = $state<HTMLElement>();

  /** A field with text in it, whose Esc is its own; an empty one, such as the pane's reply box before typing, lets Esc close the pane. */
  function typedIn(target: Element | null): boolean {
    const field = target?.closest<HTMLElement>("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    if (!field) return false;
    return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement ? field.value !== "" : !!field.textContent?.trim();
  }

  /**
   * Cmd+. (Ctrl+. off a Mac) closes the pane, as Slack closes its right pane, and so does Esc unless a menu, a dialog or a field with text
   * takes it. Focus in the pane goes back to the main composer.
   */
  function onkeydown(e: KeyboardEvent) {
    if (!content || e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey) return;
    const dot = e.key === "." && (e.metaKey || e.ctrlKey);
    const target = e.target instanceof Element ? e.target : null;
    const inPane = !!target && !!aside?.contains(target);
    const esc = e.key === "Escape" && !e.metaKey && !e.ctrlKey && !document.querySelector("[role=menu], dialog[open]") && !typedIn(target);
    if (!dot && !esc) return;
    e.preventDefault();
    sidePanel.close();
    if (inPane || !document.activeElement || document.activeElement === document.body) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("section.conversation [data-testid=composer-input]")?.focus());
    }
  }
</script>

<svelte:window {onkeydown} />

{#if content}
  <aside bind:this={aside} class="side-panel" class:overlay class:full style:width={full ? undefined : `${width}px`} aria-label={content.title} data-panel-key={content.key} data-testid="side-panel">
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
