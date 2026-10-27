<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";

  type Props = {
    title?: string;
    icon?: string;
    /** Replaces the title text, for example a tab strip or an editable name. */
    titleContent?: Snippet;
    /** Trailing controls, before the close button. */
    actions?: Snippet;
    /** Show a close button with this label, for example "Close thread". */
    closeLabel?: string;
    onclose?: () => void;
    /** Draw a bottom hairline. */
    divider?: boolean;
    level?: 1 | 2 | 3;
  };
  let { title = "", icon, titleContent, actions, closeLabel = "Close", onclose, divider = false, level = 2 }: Props = $props();
</script>

<header class="panel-header" class:divider>
  {#if icon}<Icon name={icon} size={18} />{/if}
  <div class="title">
    {#if titleContent}
      {@render titleContent()}
    {:else}
      <svelte:element this={`h${level}`} class="t-label-sm">{title}</svelte:element>
    {/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if onclose}<IconButton icon="close" label={closeLabel} size="sm" onclick={onclose} />{/if}
</header>

<style>
  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: var(--size-panel-header);
    padding: 4px 8px 4px 16px;
  }
  .panel-header > :global(.icon) {
    color: var(--text-subtle);
  }
  .divider {
    border-bottom: 1px solid var(--border-standard);
  }
  .title {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }
  .title > :global(h1),
  .title > :global(h2),
  .title > :global(h3) {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
</style>
