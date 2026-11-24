<script lang="ts">
  import { later } from "$lib/later.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import MemoField from "./MemoField.svelte";

  /**
   * The save toast's Add memo (lib/later.svelte.ts `memoPrompt`): a small titled popover with the memo field opens above where the toast
   * sat, and above any composer under it, so it covers no button. Enter or a click outside saves, and Esc drops it, so he can save first
   * and write the memo only if he wants one.
   */
  const prompt = $derived(later.memoPrompt);
  let draft = $state("");
  let escaped = false;
  $effect(() => {
    if (!prompt) return;
    draft = prompt.memo;
    escaped = false;
  });
  const WIDTH = 360;
  /** The toast's top edge (lib/ui/Toaster.svelte: 24 px from the bottom, 40 px high), or a composer's top when one sits under the popover. */
  function spot(): { x: number; y: number } {
    const x = window.innerWidth / 2;
    let y = window.innerHeight - 64;
    for (const composer of document.querySelectorAll<HTMLElement>("[data-composer]")) {
      const box = composer.getBoundingClientRect();
      if (box.width && box.left < x + WIDTH / 2 && box.right > x - WIDTH / 2) y = Math.min(y, box.top);
    }
    return { x, y: y - 8 };
  }
  const anchor = $derived(prompt ? spot() : null);
  const title = $derived(prompt?.kind === "page" ? "Memo for this saved page" : "Memo for this saved message");

  function close(save: boolean) {
    const open = later.memoPrompt;
    later.memoPrompt = null;
    if (open && save) void later.setMemo(open.id, draft);
  }
</script>

<svelte:window onkeydowncapture={(e) => (escaped = e.key === "Escape")} onpointerdowncapture={() => (escaped = false)} />

{#if prompt}{#key prompt.id}
  <Popover open anchor={anchor} placement="top" width={WIDTH} padding={12} label={title} autofocus={false} onclose={() => close(!escaped)}>
    <p class="title t-label-sm" data-memo-title>{title}</p>
    <MemoField bind:value={draft} label={title} onsave={() => close(true)} oncancel={() => close(false)} />
  </Popover>
{/key}{/if}

<style>
  .title {
    margin: 0 0 8px;
    color: var(--text-standard);
  }
</style>
