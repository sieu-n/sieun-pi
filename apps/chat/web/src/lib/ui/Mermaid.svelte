<script lang="ts">
  import { drawMermaid } from "./mermaid";
  import LoadingText from "./LoadingText.svelte";

  type Props = { source: string };
  let { source }: Props = $props();
  let svg = $state("");
  let error = $state("");
  let colorMode = $state(document.documentElement.dataset.colorMode);

  $effect(() => {
    const observer = new MutationObserver(() => (colorMode = document.documentElement.dataset.colorMode));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
    return () => observer.disconnect();
  });

  $effect(() => {
    void colorMode;
    let live = true;
    error = "";
    drawMermaid(source).then(
      (out) => live && (svg = out),
      (e: unknown) => live && (error = e instanceof Error ? e.message.split("\n")[0]! : String(e)),
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="mermaid-view">
  {#if error}
    <p class="error">Could not draw this diagram: {error}</p>
    <pre><code>{source}</code></pre>
  {:else if svg}
    {@html svg}
  {:else}
    <LoadingText text="Drawing diagram…" />
  {/if}
</div>

<style>
  .mermaid-view {
    display: flex;
    justify-content: center;
    overflow-x: auto;
  }
  .mermaid-view :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .error {
    margin: 0 0 8px;
    font: var(--text-caption);
    color: var(--border-danger);
  }
  pre {
    margin: 0;
    font: var(--text-mono);
    white-space: pre-wrap;
  }
</style>
