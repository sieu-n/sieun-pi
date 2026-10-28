<script lang="ts">
  import { drawMermaid } from "./mermaid";
  import LoadingText from "./LoadingText.svelte";

  type Props = {
    source: string;
    /** The source does not parse or draw. Without it the view shows the error and the source itself. */
    onerror?: (message: string) => void;
  };
  let { source, onerror }: Props = $props();
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
      (e: unknown) => {
        if (!live) return;
        error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        onerror?.(error);
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="mermaid-view" data-state={error ? "error" : svg ? "drawn" : "drawing"}>
  {#if error}
    {#if !onerror}
      <p class="error">Could not draw this diagram: {error}</p>
      <pre><code>{source}</code></pre>
    {/if}
  {:else if svg}
    {@html svg}
  {:else}
    <LoadingText text="Drawing diagram…" />
  {/if}
</div>

<style>
  .mermaid-view {
    display: flex;
    justify-content: safe center;
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
