<script lang="ts">
  import Spinner from "./Spinner.svelte";

  type Props = {
    text?: string;
    /** Wait this long before showing anything, so fast loads never flicker. */
    delay?: number;
    spinner?: boolean;
  };
  let { text = "Loading…", delay = 1000, spinner = false }: Props = $props();
  let visible = $state(false);

  $effect(() => {
    const t = setTimeout(() => (visible = true), delay);
    return () => clearTimeout(t);
  });
</script>

<span class="loading" class:visible role="status" aria-live="polite">
  {#if visible}
    {#if spinner}<Spinner size={14} />{/if}
    <span>{text}</span>
  {/if}
</span>

<style>
  .loading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
    opacity: 0;
    transition: opacity var(--duration-slow) var(--ease-standard);
  }
  .visible {
    opacity: 1;
  }
</style>
