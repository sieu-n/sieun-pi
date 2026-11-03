<script lang="ts">
  import { api, type Item } from "$lib/api";
  import { QUICK_REACTIONS, WIP_EMOJI } from "$lib/api/shared/reactions";
  import Popover from "$lib/ui/Popover.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import { tooltip } from "$lib/ui/tooltip";

  type Props = {
    item: Extract<Item, { kind: "message" }>;
    /** The room the post is in. */
    room: string;
  };
  let { item, room }: Props = $props();

  let pickerOpen = $state(false);
  let anchor = $state<HTMLElement | null>(null);
  let addButton = $state<HTMLButtonElement>();

  const rows = $derived(item.reactions ?? []);
  const mine = (emoji: string) => rows.some((r) => r.emoji === emoji && r.by.some((b) => b.id === "owner"));
  const names = (by: { id: string; name: string }[]) => by.map((b) => (b.id === "owner" ? "You" : b.name)).join(", ");

  function toggle(emoji: string, on = !mine(emoji)) {
    pickerOpen = false;
    void api.react(room, item.id, emoji, on).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not react"));
  }

  /** Opens the emoji picker next to `at`, such as the hover toolbar's Add reaction button. */
  export function pick(at: HTMLElement) {
    anchor = at;
    pickerOpen = true;
  }
</script>

{#if rows.length}
  <div class="reactions" data-reactions>
    {#each rows as reaction (reaction.emoji)}
      {#if reaction.emoji === WIP_EMOJI}
        <span class="chip wip" data-reaction={reaction.emoji} data-wip use:tooltip={`${names(reaction.by)} ${reaction.by.length > 1 ? "are" : "is"} working on this`} aria-label="{names(reaction.by)} working on this">
          <span class="emoji">{reaction.emoji}</span>{#if reaction.by.length > 1}<span class="count">{reaction.by.length}</span>{/if}
        </span>
      {:else}
        <button type="button" class="chip" class:mine={mine(reaction.emoji)} aria-pressed={mine(reaction.emoji)} data-reaction={reaction.emoji}
          use:tooltip={`${names(reaction.by)} reacted with ${reaction.emoji}`} onclick={() => toggle(reaction.emoji)}>
          <span class="emoji">{reaction.emoji}</span><span class="count">{reaction.by.length}</span>
        </button>
      {/if}
    {/each}
    <button type="button" class="chip add" aria-label="Add reaction" use:tooltip={"Add reaction"} bind:this={addButton} onclick={() => addButton && pick(addButton)}>+</button>
  </div>
{/if}

<Popover bind:open={pickerOpen} {anchor} placement="top-start" label="Add reaction" role="menu">
  <div class="picker" data-reaction-picker>
    {#each QUICK_REACTIONS as emoji (emoji)}
      <button type="button" class="pick" class:mine={mine(emoji)} aria-label="React with {emoji}" onclick={() => toggle(emoji)}>{emoji}</button>
    {/each}
  </div>
</Popover>

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-pill);
    background: var(--surface-inset);
    color: var(--text-subtle);
    font: var(--text-caption);
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--border-prominent);
    color: var(--text-standard);
  }
  .chip.mine {
    border-color: var(--border-focus);
    background: var(--surface-message-own);
    color: var(--text-standard);
  }
  .chip.wip {
    cursor: default;
  }
  .chip.wip .emoji {
    animation: wip 2.4s ease-in-out infinite;
  }
  .chip.add {
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }
  :global(.row:hover) .chip.add,
  .chip.add:focus-visible {
    opacity: 1;
  }
  .emoji {
    font-size: 14px;
    line-height: 1;
  }
  .picker {
    display: flex;
    gap: 2px;
  }
  .pick {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    font-size: 18px;
    cursor: pointer;
  }
  .pick:hover,
  .pick.mine {
    background: var(--surface-inset);
  }
  @keyframes wip {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .chip.wip .emoji { animation: none; }
  }
</style>
