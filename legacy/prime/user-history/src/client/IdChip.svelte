<script lang="ts">
  import { idClass } from "./board.ts";

  /** An item's board id in mono with a dot colored by a hash of the chat and item ids. A click copies the id and the chip reads "Copied" for 1.2 s. */
  let { chat, id }: { chat: string; id: string } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function copy(): void {
    void navigator.clipboard?.writeText(id);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied = false; }, 1200);
  }
</script>

<button type="button" class="id-chip {idClass(chat, id)}" class:copied aria-label="Copy the id {id}" title={copied ? "Copied" : `Copy ${id}`} onclick={copy}>
  <span class="dot" aria-hidden="true"></span>{id}</button>

<style>
  .id-chip { display: inline-flex; vertical-align: top; align-items: center; gap: 4px; height: 18px; padding: 0 3px; margin: 0 -1px; border-radius: 4px; font-family: var(--mono); font-size: 11px; line-height: 18px; color: var(--text); opacity: 0.6; font-variant-numeric: tabular-nums; }
  .id-chip:hover, .id-chip:focus-visible { opacity: 1; background: var(--bg-hover); }
  .id-chip.copied { opacity: 1; color: var(--accent-bold); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot); }
</style>
