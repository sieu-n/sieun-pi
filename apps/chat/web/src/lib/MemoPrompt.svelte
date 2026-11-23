<script lang="ts">
  import { later } from "$lib/later.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import MemoField from "./MemoField.svelte";

  /**
   * The save toast's Add memo (lib/later.svelte.ts `memoPrompt`): the memo field opens where the toast sat, at the bottom of the window.
   * Enter or a click outside saves, and Esc drops it, so he can save first and write the memo only if he wants one.
   */
  const prompt = $derived(later.memoPrompt);
  let draft = $state("");
  let escaped = false;
  $effect(() => {
    if (!prompt) return;
    draft = prompt.memo;
    escaped = false;
  });
  const anchor = $derived(prompt ? { x: window.innerWidth / 2, y: window.innerHeight - 24 } : null);

  function close(save: boolean) {
    const open = later.memoPrompt;
    later.memoPrompt = null;
    if (open && save) void later.setMemo(open.id, draft);
  }
</script>

<svelte:window onkeydowncapture={(e) => (escaped = e.key === "Escape")} onpointerdowncapture={() => (escaped = false)} />

{#if prompt}{#key prompt.id}
  <Popover open anchor={anchor} placement="top" width={360} padding={8} label="Memo" autofocus={false} onclose={() => close(!escaped)}>
    <MemoField bind:value={draft} onsave={() => close(true)} oncancel={() => close(false)} />
  </Popover>
{/key}{/if}
