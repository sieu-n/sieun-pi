<script lang="ts">
  import type { ConversationId, Item } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import { stampLabel } from "$lib/ui/datetime";
  import { setPin } from "./pins";
  import { avatarKind, avatarOf } from "./present";

  type Pinned = Extract<Item, { kind: "message" }>;
  type Props = {
    room: ConversationId;
    /** The header's pinned posts, newest pin first (server/pins.ts). */
    pins: Item[];
    /** The room's loaded posts: when one of them is pinned or un-pinned, here or in another tab, the header's list is read again. */
    items: Item[];
    refresh: () => void;
  };
  let { room, pins, items, refresh }: Props = $props();

  const list = $derived(pins.filter((p): p is Pinned => p.kind === "message"));
  let open = $state(false);
  let anchor = $state<HTMLButtonElement>();

  const loadedPins = $derived(items.flatMap((i) => (i.kind === "message" && i.pinned ? [`${i.id}@${i.pinned.at}`] : [])).join(" "));
  let seen: string | null = null;
  $effect(() => {
    const now = loadedPins;
    if (seen !== null && seen !== now) refresh();
    seen = now;
  });

  /** Slack's Pinned list jumps to the post in the room, or to a reply inside its open thread. */
  function jump(post: Pinned) {
    open = false;
    router.openConversation(room, post.threadRoot ? { thread: post.threadRoot, messageId: post.id } : { messageId: post.id });
  }
</script>

<IconButton
  icon="pin"
  label={list.length ? `Pinned messages (${list.length})` : "Pinned messages"}
  size="sm"
  pressed={open}
  aria-haspopup="dialog"
  aria-expanded={open}
  bind:element={anchor}
  onclick={() => (open = !open)}
  data-testid="pins-button"
/>
{#if list.length}<span class="count" aria-hidden="true" data-testid="pins-count">{list.length}</span>{/if}

<Popover bind:open {anchor} placement="bottom-end" surface="solid" width={360} maxHeight={480} padding={0} label="Pinned messages">
  <div class="pins" data-testid="pins-list">
    <h2 class="head t-label-sm">Pinned messages</h2>
    {#if list.length}
      <ul>
        {#each list as post (post.id)}
          <li class="pin" data-pin={post.id}>
            <button type="button" class="open" onclick={() => jump(post)}>
              <span class="byline">
                <Avatar name={avatarOf(post.author).name} kind={avatarKind(post.author)} seed={post.author.id} size={20} />
                <span class="author t-label-sm">{post.author.name}</span>
                <time class="t-caption" datetime={new Date(post.at).toISOString()}>{stampLabel(post.at)}</time>
              </span>
              <span class="text t-body-sm">{post.text || "Image"}</span>
              {#if post.pinned}<span class="by t-caption">Pinned by {post.pinned.by.kind === "owner" ? "you" : post.pinned.by.name}</span>{/if}
            </button>
            <span class="unpin"><IconButton icon="close" label="Un-pin" size="xs" onclick={() => setPin(room, post.id, false, refresh)} data-unpin /></span>
          </li>
        {/each}
      </ul>
    {:else}
      <EmptyState size="sm" icon="pin" title="Nothing pinned yet" description="Open a message's More actions and pick Pin to keep it here for everyone in the room." />
    {/if}
  </div>
</Popover>

<style>
  .count {
    margin-left: -6px;
    font: var(--text-caption);
    color: var(--text-metadata);
    font-variant-numeric: tabular-nums;
  }
  .pins {
    display: flex;
    flex-direction: column;
  }
  .head {
    margin: 0;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--border-standard);
  }
  ul {
    margin: 0;
    padding: 6px;
    list-style: none;
  }
  .pin {
    position: relative;
    border-radius: var(--radius-row);
  }
  .pin:is(:hover, :focus-within) {
    background: var(--affordance-ghost-hover);
  }
  .open {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 8px 36px 8px 8px;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .byline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .byline time,
  .by {
    color: var(--text-metadata);
  }
  .text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .unpin {
    position: absolute;
    top: 6px;
    right: 6px;
    opacity: 0;
  }
  .pin:is(:hover, :focus-within) .unpin {
    opacity: 1;
  }
</style>
