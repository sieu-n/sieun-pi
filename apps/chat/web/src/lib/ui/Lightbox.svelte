<script lang="ts">
  import IconButton from "./IconButton.svelte";
  import { nextLayer, portal } from "./floating";

  type Props = {
    /** Image URL to show; null hides the lightbox. */
    src: string | null;
    alt?: string;
    /** SVG markup drawn inline in place of the image, fitted to the screen; Open original still opens `src`. */
    svg?: string;
    onclose: () => void;
  };
  let { src, alt = "", svg, onclose }: Props = $props();
  let z = $state(5000);

  $effect(() => {
    if (!src) return;
    z = nextLayer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onclose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
</script>

{#if src}
  <div use:portal class="lightbox" style:z-index={z} role="dialog" aria-modal="true" aria-label={alt || "Image"} tabindex="-1" onclick={onclose} onkeydown={() => {}}>
    {#if svg}
      <div class="svg-frame">{@html svg}</div>
    {:else}
      <img {src} {alt} />
    {/if}
    <div class="bar">
      <IconButton icon="external" label="Open original" variant="glass" onclick={(e) => (e.stopPropagation(), window.open(src, "_blank", "noopener"))} />
      <IconButton icon="close" label="Close" variant="glass" onclick={onclose} />
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 48px;
    background: rgb(0 0 0 / 80%);
    animation: fade var(--duration-base) var(--ease-standard);
  }
  img {
    max-width: 100%;
    max-height: 100%;
    border-radius: 12px;
    box-shadow: 0 8px 40px rgb(0 0 0 / 40%);
    cursor: default;
  }
  .svg-frame {
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    border-radius: 12px;
    box-shadow: 0 8px 40px rgb(0 0 0 / 40%);
  }
  .svg-frame :global(svg) {
    display: block;
    width: auto;
    height: auto;
    max-width: calc(100vw - 96px);
    max-height: calc(100vh - 96px);
  }
  .bar {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 8px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
