<script lang="ts">
  import { api, markUnread } from "$lib/api";
  import { later } from "$lib/later.svelte";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { remindMenu } from "$lib/remind";
  import { conversationHref, router } from "$lib/router.svelte";
  import ActionBar from "$lib/ui/ActionBar.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import Popover from "$lib/ui/Popover.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import EmojiPicker from "$pages/channel/EmojiPicker.svelte";
  import { frequentEmoji } from "$pages/channel/frequent-emoji.svelte";
  import type { ContextLine, HitContext } from "./context";
  import Highlight from "./Highlight.svelte";
  import HitAvatar from "./HitAvatar.svelte";
  import HitMeta from "./HitMeta.svelte";
  import { author, location, longStamp, type Hit } from "./hit-view";
  import { snippetPieces } from "./match";

  type Props = {
    hit: Hit;
    now: Date;
    /** The keyboard's current result: it shows its context without a click. */
    focused: boolean;
    expanded: boolean;
    context: HitContext | "loading" | "error" | undefined;
    ontoggle: () => void;
    onfocus: () => void;
  };
  let { hit, now, focused, expanded, context, ontoggle, onfocus }: Props = $props();

  const pieces = $derived(snippetPieces(expanded && hit.text ? hit.text : hit.snippet));
  const href = $derived(hit.link);
  const showContext = $derived(expanded || focused);
  const lines = $derived(typeof context === "object" ? context : undefined);
  const where = $derived(location(hit.conversation));

  /**
   * Slack's actions on a search result. A post in a DM, channel or Solo room takes a reaction, Save for later, Mark unread and a reminder,
   * as it does in its room; a thread reply or a channel post also opens its thread to reply; every hit copies its link.
   */
  const room = $derived(/^(dm|ch|so)_/.test(hit.conversation.id) && /^p\d+$/.test(hit.messageId) ? hit.conversation.id : null);
  const threadKey = $derived(room ? (hit.thread?.root ?? (hit.conversation.kind === "channel" || hit.conversation.kind === "dm" ? hit.messageId : null)) : null);
  const mark = $derived(room ? later.mark(room, hit.messageId) : undefined);
  const post = $derived({ id: hit.messageId, later: mark });
  const saved = $derived(room ? later.saved(room, post) : false);

  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLElement | { x: number; y: number } | null>(null);
  let moreButton = $state<HTMLButtonElement>();
  let reactButton = $state<HTMLButtonElement>();
  let picking = $state(false);
  let customRemind = $state(false);
  /** The right-click menu holds every action; More actions holds the ones the bar has no button for. */
  let full = $state(false);

  function copyLink() {
    void navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${hit.link}`).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  function reply() {
    if (room && threadKey) router.navigate(conversationHref(room, { thread: threadKey, messageId: hit.messageId }));
  }

  function react(emoji: string) {
    if (!room) return;
    frequentEmoji.use(emoji);
    api.react(room, hit.messageId, emoji, true).then(
      () => toast.show(`Reacted with ${emoji}`, { action: { label: "Undo", run: () => void api.react(room!, hit.messageId, emoji, false) } }),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not react"),
    );
  }

  function unread() {
    if (!room) return;
    markUnread(room, hit.messageId, hit.thread?.root).then(
      () => toast.show("Marked as unread. It stays in Saved until you reply, react or check it off."),
      () => toast.error("Could not mark the message unread"),
    );
  }

  const moreItems = $derived<MenuEntry[]>([
    { id: "link", label: "Copy link", icon: "link", onselect: copyLink },
    ...(room
      ? [
          { id: "unread", label: "Mark unread", icon: "dot", onselect: unread } satisfies MenuEntry,
          remindMenu({ remindAt: mark?.remindAt, set: (at) => void later.remindPost(room!, hit.messageId, at), custom: () => (customRemind = true), clear: () => void later.remindPost(room!, hit.messageId, null) }),
        ]
      : []),
  ]);
  const menuItems = $derived<MenuEntry[]>(
    full
      ? [
          ...(threadKey ? [{ id: "reply", label: "Reply in thread", icon: "reply", onselect: reply } satisfies MenuEntry] : []),
          ...(room
            ? [{ id: "later", label: saved ? "Remove from Saved" : "Save", icon: saved ? "bookmark-filled" : "bookmark", onselect: () => void later.toggle(room!, post) } satisfies MenuEntry]
            : []),
          ...moreItems,
        ]
      : moreItems,
  );

  function openMore() {
    full = false;
    menuAnchor = moreButton ?? null;
    menuOpen = !menuOpen;
  }

  /** A right-click on the card opens every action at the pointer, as Slack's message menu does; a right-click on a link inside keeps the browser's. */
  function oncontextmenu(e: MouseEvent) {
    if ((e.target as Element).closest("[data-action-bar], .context")) return;
    e.preventDefault();
    onfocus();
    full = true;
    menuAnchor = { x: e.clientX, y: e.clientY };
    menuOpen = true;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article class="card" class:focused class:expanded data-result-card data-action-host data-hit-id={hit.id} data-role={hit.role ?? ""} data-kind={hit.kind} aria-current={focused || undefined} {oncontextmenu}>
  {#if hit.thread}
    <p class="thread" data-thread-label>
      <Icon name="thread" size={14} />
      <span>Thread in</span>
      <Icon name={where.icon} size={12} />
      <span class="thread-name">{where.name}</span>
      <span aria-hidden="true">·</span>
      <span>{author(hit).name} replied</span>
    </p>
  {/if}
  {#if showContext && lines?.before}{@render line(lines.before, "before")}{/if}
  <div class="main">
    <span class="avatar"><HitAvatar {hit} size={32} /></span>
    <div class="body">
      <div class="head">
        <HitMeta {hit} showThread={false} />
        <time class="stamp" datetime={new Date(hit.at).toISOString()}>{longStamp(hit.at, now)}</time>
      </div>
      <!-- The link covers the card, so a click anywhere opens the conversation at the message, and it opens in a new tab too. -->
      <a class="open" {href} onfocus={onfocus} onclick={onfocus} data-result-open>
        <p class="snippet" class:clamped={!expanded} class:tool={hit.role === "tool"} data-result-snippet><Highlight {pieces} /></p>
      </a>
      <div class="actions">
        <button type="button" class="more" onclick={ontoggle} aria-expanded={expanded} data-result-more>
          {expanded ? "Show less" : hit.text ? "Show more" : "Show context"}
        </button>
      </div>
    </div>
  </div>
  {#if showContext && lines?.after}{@render line(lines.after, "after")}{/if}
  {#if showContext && context === "loading"}<p class="context-note">Loading the messages around it…</p>{/if}
  <ActionBar label="Message actions" open={menuOpen || picking}>
    {#if room}
      <IconButton icon="emoji-add" label="Add reaction" size="sm" bind:element={reactButton} onclick={() => (picking = true)} data-add-reaction />
    {/if}
    {#if threadKey}<IconButton icon="reply" label="Reply in thread" size="sm" onclick={reply} data-result-reply />{/if}
    {#if room}
      <IconButton icon={saved ? "bookmark-filled" : "bookmark"} label={saved ? "Remove from Saved" : "Save"} size="sm" pressed={saved} onclick={() => room && void later.toggle(room, post)} data-save-later />
    {/if}
    <IconButton icon="link" label="Copy link" size="sm" onclick={copyLink} data-result-copy-link />
    {#if room}
      <IconButton icon="more" label="More actions" size="sm" aria-haspopup="menu" aria-expanded={menuOpen && !full} bind:element={moreButton} onclick={openMore} data-message-menu />
    {/if}
  </ActionBar>
</article>
{#if menuOpen}<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement={full ? "bottom-start" : "bottom-end"} label="Message actions" />{/if}
{#if picking}
  <Popover bind:open={picking} anchor={reactButton} placement="top-start" label="Add reaction" padding={0} radius="row">
    <EmojiPicker
      onpick={(emoji, keepOpen) => {
        if (!keepOpen) picking = false;
        react(emoji);
      }}
    />
  </Popover>
{/if}
{#if customRemind && room}<RemindDialog at={mark?.remindAt} onpick={(at) => later.remindPost(room!, hit.messageId, at)} onclose={() => (customRemind = false)} />{/if}

{#snippet line(entry: ContextLine, side: "before" | "after")}
  <div class="context {side}" data-context={side}>
    <span class="context-author">{entry.author}</span>
    <span class="context-text">{entry.text}</span>
  </div>
{/snippet}

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .card:hover {
    background: var(--bg-app);
  }
  .card.focused {
    border-color: var(--border-prominent);
  }
  .main {
    display: flex;
    gap: 12px;
    min-width: 0;
  }
  .avatar {
    flex: none;
    padding-top: 2px;
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    font: var(--text-body-sm);
  }
  .stamp {
    flex: none;
    color: var(--text-metadata);
    font: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }
  .open {
    color: inherit;
    text-decoration: none;
  }
  .open::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }
  .open:focus-visible {
    outline: none;
  }
  .card:has(.open:focus-visible) {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .snippet {
    margin: 0;
    color: var(--text-standard);
    font: var(--text-body);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .snippet.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
  }
  .snippet.tool {
    font: var(--text-mono);
    color: var(--text-subtle);
  }
  .snippet :global(mark) {
    font-weight: 500;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .more {
    position: relative;
    z-index: 1;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    font: var(--text-caption);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-standard);
    text-decoration: underline;
  }
  .thread {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .thread-name {
    color: var(--text-standard);
  }
  .context {
    display: flex;
    gap: 6px;
    margin-left: 44px;
    padding: 4px 0 4px 10px;
    border-left: 2px solid var(--border-standard);
    color: var(--text-subtle);
    font: var(--text-body-sm);
    opacity: 0.8;
  }
  .context-author {
    flex: none;
    font-weight: 500;
  }
  .context-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .context-note {
    margin: 0 0 0 44px;
    color: var(--text-metadata);
    font: var(--text-caption);
  }
</style>
