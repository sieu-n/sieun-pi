<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { agents, me, roomPage, type ConversationSummary, type Item, type RoomPage } from "$lib/api";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import { Avatar, Button, EmptyState, Icon, LoadingText, PanelHeader } from "$lib/ui";
  import { toast } from "$lib/ui/toast.svelte";
  import { markAllRead, unreadRooms } from "$lib/unreads.svelte";
  import MessageRow from "$pages/channel/MessageRow.svelte";
  import { directory } from "$pages/channel/directory.svelte";
  import { mentionContext } from "$pages/channel/present";
  import { layoutRows } from "$pages/channel/rows";

  type Post = Exclude<Item, { kind: "system" }>;
  /** One room's new posts, read for the activity it had when they were read, so a new post reads them again. */
  type Section =
    | { state: "loading"; at: number }
    | { state: "failed"; at: number; error: string }
    | { state: "ready"; at: number; posts: Post[]; earlier: boolean };

  const rooms = $derived(unreadRooms());
  const sections = new SvelteMap<string, Section>();
  const context = $derived({ mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""), plain: true });

  /** A root post whose thread is his, which he started or replied in, as the room's bold counts it (server/group-rooms.ts `summary`). */
  const his = (item: Post): boolean => item.author.id === "owner" || !!item.thread?.authors.some((author) => author.id === "owner");

  /**
   * The posts after the room's read point from its newest page: top-level ones, and the root of each thread of his with a reply after it.
   * `earlier` when the page starts past the read point.
   */
  function ready(page: RoomPage, row: ConversationSummary): Extract<Section, { state: "ready" }> {
    const at = row.lastActivityAt;
    // A Mark unread moves the read point back to the post the room's row names, which a page kept before the mark does not know.
    const marked = row.unreadFrom ? page.items.find((item) => item.id === row.unreadFrom) : undefined;
    const read = marked?.kind === "message" && marked.seq !== undefined ? marked.seq - 1 : (page.header.readSeq ?? 0);
    const posts = page.items.filter(
      (item): item is Post => item.kind === "message" && !item.threadRoot && !item.deleted && ((item.seq ?? 0) > read || ((item.thread?.lastSeq ?? 0) > read && his(item))),
    );
    const first = page.items.find((item) => item.kind === "message" && item.seq !== undefined);
    const earlier = !!page.older && first?.kind === "message" && (first.seq ?? 0) > read + 1;
    return { state: "ready", at, posts, earlier };
  }

  /** Shows the room's kept page at once and its newest page when the read behind it lands. */
  async function load(row: ConversationSummary): Promise<void> {
    const at = row.lastActivityAt;
    const { kept, fresh, waited } = roomPage(row.id);
    const shown = kept ? ready(kept, row) : undefined;
    sections.set(row.id, shown ?? { state: "loading", at });
    try {
      const next = ready(await fresh, row);
      if (shown && JSON.stringify([shown.posts, shown.earlier]) !== JSON.stringify([next.posts, next.earlier])) waited();
      if (sections.get(row.id)?.at === at) sections.set(row.id, next);
    } catch (error) {
      if (!shown && sections.get(row.id)?.at === at) sections.set(row.id, { state: "failed", at, error: error instanceof Error ? error.message : "Could not load the new posts" });
    }
  }

  $effect(() => {
    for (const row of rooms) {
      const kept = sections.get(row.id);
      if (!kept || kept.at !== row.lastActivityAt) void load(row);
    }
  });

  const title = (row: ConversationSummary): string => (row.kind === "channel" ? `#${row.name}` : row.name);
  const newCount = (row: ConversationSummary): number | null => {
    const section = sections.get(row.id);
    return section?.state === "ready" && !section.earlier ? section.posts.length : null;
  };

  function copyLink(room: string, item: Item) {
    void navigator.clipboard.writeText(`${location.origin}${location.pathname}${conversationHref(room, { messageId: item.id })}`).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }
</script>

<div class="page" data-testid="unreads-page">
  <PanelHeader title="All unreads" icon="messages" level={1}>
    {#snippet actions()}
      {#if rooms.length}
        <Button variant="outline" size="sm" icon="check" onclick={() => void markAllRead(rooms)} title="Mark all as read (Shift+Esc)" data-testid="unreads-mark-all">Mark all as read</Button>
      {/if}
    {/snippet}
  </PanelHeader>
  <div class="scroll">
    {#if !rooms.length}
      <div class="empty" role="status">
        <EmptyState icon="check" title="You're all caught up" description="New posts in your channels, Solo rooms and DMs show here until you read them.">
          {#snippet action()}<Button variant="outline" size="sm" icon="edit" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))}>New message</Button>{/snippet}
        </EmptyState>
      </div>
    {:else}
      {#each rooms as row (row.id)}
        {@const section = sections.get(row.id)}
        {@const count = newCount(row)}
        <section class="room" data-unread-room={row.id} aria-label={title(row)}>
          <header class="room-head">
            <a class="room-name" href={conversationHref(row.id)}>
              {#if row.kind === "dm"}
                <Avatar name={row.name} kind="agent" seed={row.agent ?? row.id} size={20} />
              {:else}
                <Icon name={row.kind === "channel" ? "hash" : "users"} size={16} />
              {/if}
              <span class="t-label-sm">{row.name}</span>
            </a>
            {#if count}<span class="count t-caption">{count} new</span>{/if}
            {#if row.unread && row.kind === "channel"}<span class="count mention t-caption">{row.unread} mention{row.unread === 1 ? "" : "s"}</span>{/if}
            <span class="head-actions">
              <Button variant="ghost" size="sm" icon="check" onclick={() => void markAllRead([row])} data-testid="unreads-mark-room">Mark as read</Button>
            </span>
          </header>
          {#if !section || section.state === "loading"}
            <div class="note"><LoadingText text="Loading new posts…" delay={300} /></div>
          {:else if section.state === "failed"}
            <div class="note" role="alert"><span class="t-body-sm">{section.error}</span><Button variant="outline" size="sm" onclick={() => void load(row)}>Try again</Button></div>
          {:else}
            {#if section.earlier}
              <a class="note earlier t-body-sm" href={conversationHref(row.id, { messageId: section.posts[0]?.id })}>Earlier new posts are in {title(row)}. Open it to read them all.</a>
            {/if}
            {#if section.posts.length}
              <ol class="posts">
                {#each layoutRows(section.posts) as r (r.key)}
                  {#if r.kind === "post"}
                    <MessageRow
                      item={r.item}
                      first={r.first}
                      last={r.last}
                      replyTo={r.replyTo ?? null}
                      layout="slack"
                      fullTime
                      {context}
                      onthread={(key) => router.openConversation(row.id, { thread: key })}
                      oncopylink={(item) => copyLink(row.id, item)}
                      onmention={(target, kind) => (kind === "channel" ? router.openConversation(target) : kind === "agent" ? router.openConversation(agents.room(target)) : undefined)}
                    />
                  {/if}
                {/each}
              </ol>
            {:else if !section.earlier}
              <a class="note t-body-sm" href={conversationHref(row.id)}>Open {title(row)} to see what is new.</a>
            {/if}
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .page > :global(.panel-header) {
    border-bottom: 1px solid var(--border-standard);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-3) var(--space-panel-inset) var(--space-panel-inset);
    scrollbar-gutter: stable;
  }
  .empty {
    display: grid;
    place-items: center;
    min-height: 60%;
  }
  .room {
    width: min(100%, 52rem);
    margin: 0 auto var(--space-4, 16px);
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-container);
    background: var(--surface-raised, transparent);
  }
  .room-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 4px 8px 4px 14px;
    border-bottom: 1px solid var(--border-standard);
  }
  .room-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text-standard);
    text-decoration: none;
  }
  .room-name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .room-name:hover span {
    text-decoration: underline;
  }
  .room-name :global(.icon) {
    flex: none;
    color: var(--text-subtle);
  }
  .count {
    flex: none;
    color: var(--text-metadata);
  }
  .count.mention {
    color: var(--border-danger);
    font-weight: 600;
  }
  .head-actions {
    margin-left: auto;
  }
  .posts {
    margin: 0;
    padding: 4px 8px 8px;
    list-style: none;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    color: var(--text-subtle);
  }
  a.note {
    color: var(--text-message-link);
    text-decoration: none;
  }
  a.note:hover {
    text-decoration: underline;
  }
  .earlier {
    border-bottom: 1px solid var(--border-standard);
  }
</style>
