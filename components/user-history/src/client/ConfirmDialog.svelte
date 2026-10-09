<script lang="ts">
  import Modal from "./Modal.svelte";

  /** A small yes-or-no modal: the question as the title, one line of consequence, Cancel and the action. Escape and the backdrop cancel. */
  let { title, body, label, danger = false, busy = false, onconfirm, onclose }: {
    title: string; body: string; label: string; danger?: boolean; busy?: boolean; onconfirm: () => void; onclose: () => void;
  } = $props();
</script>

<Modal {title} width="420px" {onclose}>
  <form class="confirm" onsubmit={event => { event.preventDefault(); if (!busy) onconfirm(); }}>
    <p>{body}</p>
    <div class="actions">
      <button type="button" class="button" onclick={onclose}>Cancel</button>
      <!-- svelte-ignore a11y_autofocus -->
      <button type="submit" class="button {danger ? 'danger' : 'primary'}" disabled={busy} autofocus>{#if busy}<span class="spinner tiny"></span>{/if}{label}</button>
    </div>
  </form>
</Modal>

<style>
  .confirm { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 16px; }
  .confirm p { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
