<script lang="ts">
  import type { Snippet } from "svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import ResizeHandle from "$lib/ui/ResizeHandle.svelte";
  import { sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar.svelte";

  /**
   * The left sidebar panel every root draws its own list in: a title row, an optional loading or offline line, the scrolling list and the
   * resize handle on its right edge. A root's sidebar renders one SidebarFrame and fills it with SidebarSection blocks and SidebarRow rows.
   */
  type Props = {
    /** The root's name, shown in the title row and as the nav landmark's name, such as "Messages" or "Agents". */
    title: string;
    /** The root, on `data-root`, so specs and styles can tell the sidebars apart. */
    root: string;
    /** The nav landmark's name when it should differ from the title, such as "Conversations" for Messages. */
    label?: string;
    /** Buttons at the right of the title row, such as a New button. */
    actions?: Snippet;
    /** Rows above the scrolling list that stay put, such as a filter field. */
    head?: Snippet;
    state?: "loading" | "ready" | "offline";
    loadingText?: string;
    offlineText?: string;
    children: Snippet;
  };
  let { title, root, label, actions, head, state = "ready", loadingText = "Loading…", offlineText = "Offline · Showing the last list.", children }: Props = $props();
</script>

<nav class="sidebar" aria-label={label ?? title} data-root={root} data-testid="sidebar">
  <div class="title">
    <h1 class="t-label">{title}</h1>
    {#if actions}<span class="actions">{@render actions()}</span>{/if}
  </div>
  {#if head}<div class="head">{@render head()}</div>{/if}

  <div class="scroll">
    {#if state === "loading"}
      <div class="note"><LoadingText text={loadingText} /></div>
    {:else if state === "offline"}
      <div class="note"><span>{offlineText}</span></div>
    {/if}
    {@render children()}
  </div>

  {#if !sidebar.narrow}<ResizeHandle
    size={sidebar.width}
    min={SIDEBAR_MIN}
    max={SIDEBAR_MAX}
    edge="start"
    label="Resize sidebar"
    onresize={(px) => sidebar.setWidth(px)}
    oncommit={() => sidebar.saveWidth()}
    ondoubleclick={() => {
      sidebar.setWidth(SIDEBAR_DEFAULT);
      sidebar.saveWidth();
    }}
  />{/if}
</nav>

<style>
  .sidebar {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    flex: none;
    min-height: 0;
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    box-shadow: var(--shadow-panel);
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 44px;
    padding: 8px 12px 4px 20px;
  }
  h1 {
    margin: 0;
    overflow: hidden;
    color: var(--text-standard);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .head {
    padding: 4px 12px 8px;
  }
  .scroll {
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 12px 12px;
  }
  .note {
    padding: 8px;
    font: var(--text-caption);
    color: var(--text-subtle);
  }
</style>
