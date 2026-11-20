<script lang="ts">
  import IconButton from "./IconButton.svelte";
  import { portal } from "./floating";

  type Props = {
    /** Image URL to show; null hides the lightbox. */
    src: string | null;
    alt?: string;
    /** SVG markup drawn inline in place of the image, fitted to the screen; Open original still opens `src`. */
    svg?: string;
    onclose: () => void;
  };
  let { src, alt = "", svg, onclose }: Props = $props();

  /** A modal dialog in the top layer: the page behind it is inert, and Esc fires cancel. */
  function modal(node: HTMLDialogElement) {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    return {
      destroy() {
        node.close();
        if (returnTo?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) returnTo.focus({ preventScroll: true });
      },
    };
  }
</script>

{#if src}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions: Esc closes it through cancel, and the Close button is the keyboard path. -->
  <dialog use:portal use:modal class="lightbox" aria-label={alt || "Image"} onclick={onclose} oncancel={(e) => (e.preventDefault(), onclose())} onclose={(e) => e.currentTarget.isConnected && onclose()}>
    {#if svg}
      <div class="svg-frame">{@html svg}</div>
    {:else}
      <img {src} {alt} />
    {/if}
    <div class="bar">
      <IconButton icon="external" label="Open original" variant="glass" onclick={(e) => (e.stopPropagation(), window.open(src, "_blank", "noopener"))} />
      <IconButton icon="close" label="Close" variant="glass" onclick={onclose} />
    </div>
  </dialog>
{/if}

<style>
  .lightbox[open] {
    display: grid;
  }
  .lightbox {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0;
    padding: 48px;
    border: none;
    place-items: center;
    background: transparent;
    overscroll-behavior: contain;
  }
  .lightbox::backdrop {
    overflow: hidden;
    overscroll-behavior: contain;
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
