<script module lang="ts">
  export interface LightboxImage { src: string; alt: string }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "../Icon.svelte";

  /** A full-viewport view of one image out of a message's set. Esc, the backdrop or the close button closes; Left and Right move when there are several. */
  let { images, index, onclose }: { images: readonly LightboxImage[]; index: number; onclose: () => void } = $props();
  let dialog: HTMLDialogElement | undefined = $state();
  let current = $state(untrack(() => index));
  const image = $derived(images[current] ?? images[0]);
  const many = $derived(images.length > 1);

  $effect(() => {
    const node = dialog;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    node.querySelector<HTMLElement>(".close")?.focus();
    return () => {
      if (node.open) node.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  });

  function step(delta: number): void { current = (current + delta + images.length) % images.length; }
  function onKeydown(event: KeyboardEvent): void {
    if (!many) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  }
</script>

{#if image}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <dialog bind:this={dialog} class="lightbox" aria-label={many ? `Image ${current + 1} of ${images.length}` : image.alt}
    oncancel={event => { event.preventDefault(); onclose(); }} onkeydown={onKeydown}
    onclick={event => { const target = event.target as HTMLElement; if (target === dialog || target.classList.contains("stage")) onclose(); }}>
    <div class="stage">
      <img src={image.src} alt={image.alt} />
    </div>
    <button type="button" class="control close" aria-label="Close" onclick={onclose}><Icon name="x" size={18} /></button>
    {#if many}
      <button type="button" class="control prev" aria-label="Previous image" onclick={() => step(-1)}><Icon name="chevronLeft" size={20} /></button>
      <button type="button" class="control next" aria-label="Next image" onclick={() => step(1)}><Icon name="chevronRight" size={20} /></button>
      <div class="counter">{current + 1} / {images.length}</div>
    {/if}
  </dialog>
{/if}

<style>
  .lightbox { width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; color: #fff; overflow: hidden; }
  .lightbox::backdrop { background: rgba(0, 0, 0, 0.82); }
  .lightbox[open] { animation: pop 0.14s ease-out; }
  @keyframes pop { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
  .lightbox:focus { outline: none; }
  .stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); }
  .control { position: absolute; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: rgba(255, 255, 255, 0.12); color: #fff; transition: background-color 0.12s; }
  .control:hover, .control:focus-visible { background: rgba(255, 255, 255, 0.24); }
  .close { top: 14px; right: 14px; }
  .prev { left: 14px; top: 50%; transform: translateY(-50%); }
  .next { right: 14px; top: 50%; transform: translateY(-50%); }
  .counter { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 2px 10px; border-radius: 999px; background: rgba(0, 0, 0, 0.5); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
