<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, onclose, width = "720px", header, children }: {
    title: string; onclose: () => void; width?: string; header?: Snippet; children: Snippet;
  } = $props();
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    const node = dialog;
    if (!node) return;
    node.showModal();
    return () => { if (node.open) node.close(); };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="modal" style:--modal-width={width} aria-label={title}
  oncancel={event => { event.preventDefault(); onclose(); }}
  onclick={event => { if (event.target === dialog) onclose(); }}>
  <div class="frame">
    <header class="head">
      <h2>{title}</h2>
      {#if header}<div class="extra">{@render header()}</div>{/if}
      <button class="icon-button" aria-label="Close" title="Close (Esc)" onclick={onclose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>
    <div class="body">{@render children()}</div>
  </div>
</dialog>

<style>
  .modal { width: min(var(--modal-width), calc(100vw - 32px)); max-height: min(86vh, 900px); padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); color: var(--text); box-shadow: var(--shadow); overflow: hidden; }
  .modal::backdrop { background: rgba(0, 0, 0, 0.35); }
  .modal[open] { animation: pop 0.14s ease-out; }
  @keyframes pop { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
  .frame { display: flex; flex-direction: column; max-height: min(86vh, 900px); }
  .head { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 18px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 15px; font-weight: 600; flex: none; }
  .extra { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .head > .icon-button { margin-left: auto; }
  .body { flex: 1; min-height: 0; overflow: auto; }
</style>
