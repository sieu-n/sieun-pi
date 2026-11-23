<script lang="ts">
  /**
   * Markdown in an inset box that folds past 320 px: the rest fades out and opens with Show more, instead of scrolling inside the page.
   * The Brief tab shows the brief, the working memory and a job's first input this way.
   */
  import { Markdown } from "$lib/ui";

  let { text }: { text: string } = $props();

  const FOLDED = 320;
  let expanded = $state(false);
  let contentHeight = $state(0);
  const long = $derived(contentHeight > FOLDED);
</script>

<div class="text" class:folded={long && !expanded} style:--folded="{FOLDED}px"><div bind:clientHeight={contentHeight}><Markdown {text} /></div></div>
{#if long}
  <button type="button" class="toggle t-caption" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : "Show more"}</button>
{/if}

<style>
  .text {
    overflow: hidden;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    font: var(--text-body-sm);
    color: var(--text-standard);
  }
  .text.folded {
    max-height: var(--folded);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 72px), transparent);
  }
  .toggle {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-standard);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
