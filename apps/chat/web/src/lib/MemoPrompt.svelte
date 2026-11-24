<script lang="ts">
  import { later } from "$lib/later.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import type { Anchor, Placement } from "$lib/ui/floating";
  import MemoField from "./MemoField.svelte";

  /**
   * The save toast's Add memo (lib/later.svelte.ts `memoPrompt`): a small titled popover with the memo field opens at the thing he saved,
   * under the saved post (over it when a composer sits below) or under the wiki pane's Save button. When that is gone, scrolled away or
   * closed, it opens above where the toast sat. Enter or a click outside saves, and Esc drops it, so he can save first and write the memo
   * only if he wants one.
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
  /** The popover's height and gap: 80 px measured in Chrome and WebKit (title, one-line field, padding), plus the 6 px gap. */
  const TALL = 86;
  /** The top of the highest composer under the span from `left` to `right`, or the window's bottom. */
  function composerTop(left: number, right: number): number {
    let top = window.innerHeight;
    for (const composer of document.querySelectorAll<HTMLElement>("[data-composer]")) {
      const box = composer.getBoundingClientRect();
      if (box.width && box.left < right && box.right > left) top = Math.min(top, box.top);
    }
    return top;
  }
  const inView = (el: Element | null): el is HTMLElement => {
    const box = el?.getBoundingClientRect();
    return !!box && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
  };
  /** Where the popover opens: at the saved post or the page's Save button, else above the toast's spot (24 px from the bottom, 40 px high). */
  function place(open: NonNullable<typeof prompt>): { anchor: Anchor; placement: Placement } {
    if (open.kind === "page") {
      const button = document.querySelector("[data-save-page]");
      if (inView(button)) return { anchor: button, placement: "bottom-end" };
    } else {
      const row = [...document.querySelectorAll(`[data-message-id="${CSS.escape(open.post)}"]`)].find(inView);
      if (row) {
        const box = row.getBoundingClientRect();
        return { anchor: row, placement: composerTop(box.left, box.right) - box.bottom >= TALL ? "bottom-start" : "top-start" };
      }
    }
    const x = window.innerWidth / 2;
    return { anchor: { x, y: Math.min(window.innerHeight - 64, composerTop(x - WIDTH / 2, x + WIDTH / 2)) - 8 }, placement: "top" };
  }
  const at = $derived(prompt ? place(prompt) : null);
  const title = $derived(prompt?.kind === "page" ? "Memo for this saved page" : "Memo for this saved message");

  function close(save: boolean) {
    const open = later.memoPrompt;
    later.memoPrompt = null;
    if (open && save) void later.setMemo(open.id, draft);
  }
</script>

<svelte:window onkeydowncapture={(e) => (escaped = e.key === "Escape")} onpointerdowncapture={() => (escaped = false)} />

{#if prompt}{#key prompt.id}
  <Popover open anchor={at?.anchor} placement={at?.placement} width={WIDTH} padding={12} label={title} autofocus={false} onclose={() => close(!escaped)}>
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
