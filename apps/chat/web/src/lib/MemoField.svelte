<script lang="ts">
  import { tick } from "svelte";
  import TextArea from "$lib/ui/TextArea.svelte";

  /**
   * The memo field of a saved item, on its Saved row and in the save toast's Add memo: Enter or leaving the field saves, Shift+Enter starts
   * a new line, Esc drops the edit, and saving a blank field takes the memo away (lib/later.svelte.ts `setMemo`).
   */
  type Props = { value?: string; label?: string; onsave: (text: string) => void; oncancel: () => void };
  let { value = $bindable(""), label = "Memo", onsave, oncancel }: Props = $props();

  let element = $state<HTMLTextAreaElement>();
  let ended = false;
  function end(save: boolean) {
    if (ended) return;
    ended = true;
    if (save) onsave(value);
    else oncancel();
  }
  /** Focus waits a tick, because a Popover moves its box to the body after this mounts, and that move blurs a field focused before it. */
  $effect(() => {
    void tick().then(() => {
      if (!element || ended) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    });
  });
  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      end(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      end(false);
    }
  }
</script>

<TextArea bind:element bind:value rows={1} maxRows={6} class="memo-field" placeholder="Add a memo" aria-label={label} {onkeydown} onblur={() => end(true)} data-memo-field />

<style>
  :global(.memo-field.textarea) {
    padding: 6px 10px;
    font: var(--text-body-sm);
  }
</style>
