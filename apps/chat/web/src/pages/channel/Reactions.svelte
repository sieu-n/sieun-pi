<script lang="ts">
  import { tick } from "svelte";
  import { api, type Item, type Reaction } from "$lib/api";
  import { emojiName } from "$lib/api/shared/emoji";
  import Icon from "$lib/ui/Icon.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import { place, portal } from "$lib/ui/floating";
  import { toast } from "$lib/ui/toast.svelte";
  import EmojiPicker from "./EmojiPicker.svelte";
  import { frequentEmoji } from "./frequent-emoji.svelte";

  type Props = {
    item: Extract<Item, { kind: "message" }>;
    /** The room the post is in. */
    room: string;
    /** True while the picker is open, so the row keeps its hover bar. */
    picking?: boolean;
  };
  let { item, room, picking = $bindable(false) }: Props = $props();

  let anchor = $state<HTMLElement | null>(null);
  let addButton = $state<HTMLButtonElement>();
  let hovered = $state<{ emoji: string; chip: HTMLElement } | null>(null);
  let card = $state<HTMLDivElement>();
  let cardAt = $state<{ x: number; y: number } | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const rows = $derived(item.reactions ?? []);
  const mine = (emoji: string) => rows.some((r) => r.emoji === emoji && r.by.some((b) => b.id === "owner"));
  const code = (emoji: string) => `:${emojiName(emoji) ?? emoji}:`;
  /** Who reacted, the owner first as You, as Slack names them. */
  const people = (reaction: Reaction) =>
    [...reaction.by].sort((a, b) => Number(b.id === "owner") - Number(a.id === "owner")).map((b) => (b.id === "owner" ? "You" : b.name));
  const joiner = (i: number, count: number) => (i === 0 ? "" : i === count - 1 ? " and " : ", ");
  /** "You, vent and agent factory". */
  const names = (reaction: Reaction) => people(reaction).map((name, i, all) => joiner(i, all.length) + name).join("");
  const shown = $derived(hovered ? rows.find((r) => r.emoji === hovered!.emoji) : undefined);

  /** Puts the owner's emoji on the post, or takes it off when it is his already. */
  export function toggle(emoji: string, on = !mine(emoji)) {
    if (on) frequentEmoji.use(emoji);
    void api.react(room, item.id, emoji, on).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not react"));
  }

  /** Opens the emoji picker next to `at`, such as the hover bar's Add reaction button. */
  export function pick(at: HTMLElement) {
    hide();
    anchor = at;
    picking = true;
  }

  function show(emoji: string, chip: HTMLElement) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => (hovered = { emoji, chip }), hovered ? 0 : 350);
  }
  function hide() {
    clearTimeout(hoverTimer);
    hovered = null;
    cardAt = null;
  }

  $effect(() => {
    if (!hovered || !shown) return;
    const chip = hovered.chip;
    void shown.by.length;
    void tick().then(() => {
      if (!card || !chip.isConnected) return;
      const at = place(chip.getBoundingClientRect(), card, "top", 8);
      cardAt = { x: at.x, y: at.y };
    });
  });
  $effect(() => () => clearTimeout(hoverTimer));
</script>

{#if rows.length}
  <div class="reactions" class:picking data-reactions>
    {#each rows as reaction (reaction.emoji)}
      <button
        type="button"
        class="chip"
        class:mine={mine(reaction.emoji)}
        aria-pressed={mine(reaction.emoji)}
        aria-label="{names(reaction)} reacted with {code(reaction.emoji)}"
        data-reaction={reaction.emoji}
        onpointerenter={(e) => show(reaction.emoji, e.currentTarget)}
        onpointerleave={hide}
        onclick={() => toggle(reaction.emoji)}
      >
        <span class="emoji">{reaction.emoji}</span><span class="count">{reaction.by.length}</span>
      </button>
    {/each}
    <button type="button" class="chip add" aria-label="Add reaction" bind:this={addButton} onclick={() => addButton && pick(addButton)} data-add-reaction-chip>
      <Icon name="emoji-add" size={16} />
    </button>
  </div>
{/if}

{#if hovered && shown}
  <div use:portal bind:this={card} class="card" class:placed={!!cardAt} role="tooltip" data-reaction-card style:transform={cardAt ? `translate(${Math.round(cardAt.x)}px, ${Math.round(cardAt.y)}px)` : undefined}>
    <span class="big">{shown.emoji}</span>
    <p>
      {#each people(shown) as name, i (i)}{joiner(i, shown.by.length)}<b>{name}</b>{/each}
      reacted with <span class="code">{code(shown.emoji)}</span>
    </p>
  </div>
{/if}

<Popover bind:open={picking} {anchor} placement="top-start" label="Add reaction" surface="solid" padding={0} radius="row">
  <EmojiPicker
    selected={mine}
    onpick={(emoji, keepOpen) => {
      if (!keepOpen) picking = false;
      toggle(emoji);
    }}
  />
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
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: 12px;
    background: color-mix(in srgb, var(--text-standard) 6%, transparent);
    box-shadow: inset 0 0 0 1px transparent;
    color: var(--text-subtle);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
  }
  .chip:hover {
    background: var(--surface-panel);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-standard) 30%, transparent);
  }
  .chip.mine {
    background: color-mix(in srgb, var(--accent-9) 22%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-link) 75%, transparent);
    color: var(--accent-link);
  }
  .chip.mine:hover {
    background: color-mix(in srgb, var(--accent-9) 32%, transparent);
  }
  .emoji {
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 16px;
    line-height: 1;
  }
  .count {
    min-width: 7px;
    font: 500 12px/16px var(--font-sans);
    font-variant-numeric: tabular-nums;
  }
  .chip.add {
    padding: 0 6px;
    color: var(--text-metadata);
    opacity: 0;
  }
  .chip.add:hover {
    color: var(--text-standard);
  }
  :global(.row:hover) .chip.add,
  .picking .chip.add,
  .chip.add:focus-visible {
    opacity: 1;
  }
  .card {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 100000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 10px 12px 8px;
    border-radius: 12px;
    background: var(--neutral-11, #1d1c1d);
    color: var(--neutral-1, #ffffff);
    text-align: center;
    pointer-events: none;
    visibility: hidden;
  }
  .card.placed {
    visibility: visible;
  }
  :global(:root[data-color-mode="dark"]) .card {
    background: #f1f1f2;
    color: #0f0f0f;
  }
  .card .big {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 10px;
    background: #ffffff;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 34px;
    line-height: 1;
  }
  .card p {
    margin: 0;
    font: 400 13px/18px var(--font-sans);
  }
  .card b {
    font-weight: 500;
  }
  .card .code {
    opacity: 0.7;
  }
</style>
