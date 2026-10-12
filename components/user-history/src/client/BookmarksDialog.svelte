<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { bookmarks } from "./bookmarks.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime } from "./format.ts";
  import type { Bookmark } from "../shared/bookmarks.ts";
  import Modal from "./Modal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /** Every saved message, newest saved first, one line each: a click opens its chat on that message, x removes it, Clear all asks first. */
  let { onclose }: { onclose: () => void } = $props();

  $effect(() => { void bookmarks.load(); });
  let clearAsk = $state(false);

  const chatName = (chat: string): string => store.session(chat)?.name ?? "Chat " + chat.slice(0, 8);
  function when(at: number): string {
    const date = new Date(at);
    return date.toDateString() === new Date(clock.now).toDateString() ? clockTime(at) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function open(bookmark: Bookmark): void {
    onclose();
    store.select(bookmark.chat, bookmark.at);
  }
</script>

<Modal title="Bookmarks" icon="bookmark" width="680px" {onclose}>
  {#snippet header()}
    {#if bookmarks.list.length}
      <span class="count">{bookmarks.list.length}</span>
      <button type="button" class="clear" onclick={() => { clearAsk = true; }}>Clear all</button>
    {/if}
  {/snippet}
  {#if bookmarks.list.length}
    <ul class="list">
      {#each bookmarks.list as bookmark (bookmark.chat + "@" + bookmark.at)}
        <li class="row">
          <button type="button" class="open" title="Open this message in its chat" onclick={() => open(bookmark)}>
            <span class="chat">{chatName(bookmark.chat)}</span>
            <span class="text">{bookmark.text || "Image"}</span>
            <span class="time">{when(bookmark.at)}</span>
          </button>
          <button type="button" class="icon-button small remove" aria-label="Remove bookmark" use:tooltip={"Remove"} onclick={() => void bookmarks.remove(bookmark.chat, bookmark.at)}><Icon name="x" size={13} /></button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No bookmarks yet. In a chat, hover a message and click <Icon name="bookmark" size={13} /> next to Reply.</p>
  {/if}
</Modal>
{#if clearAsk}
  <ConfirmDialog title="Clear all bookmarks?" body="This removes all {bookmarks.list.length} bookmarks. The messages stay in their chats." label="Clear all" danger
    onconfirm={() => { clearAsk = false; void bookmarks.clear(); }} onclose={() => { clearAsk = false; }} />
{/if}

<style>
  .count { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .clear { margin-left: auto; height: 26px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12.5px; color: var(--text-muted); }
  .clear:hover { background: var(--danger-soft); color: var(--danger); }
  .list { margin: 0; padding: 4px 6px 6px; list-style: none; }
  .row { display: flex; align-items: center; gap: 2px; border-radius: var(--radius-small); }
  .row:hover { background: var(--row-hover); }
  .open { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; height: 32px; padding: 0 4px 0 10px; text-align: left; font-size: 13px; line-height: 32px; }
  .chat { flex: none; width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--text); }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
  .time { flex: none; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .remove { flex: none; margin-right: 2px; color: var(--text-faint); opacity: 0.45; transition: opacity 0.12s; }
  .row:hover .remove, .remove:focus-visible { opacity: 1; }
  .remove:hover { color: var(--text); }
  .empty { display: flex; align-items: center; justify-content: center; gap: 4px; margin: 0; padding: 36px 16px; font-size: 13px; color: var(--text-faint); }
</style>
