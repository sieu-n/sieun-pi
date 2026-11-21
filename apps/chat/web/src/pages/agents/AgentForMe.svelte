<script lang="ts">
  /**
   * The For <agent> tab: every message the agent is involved in, as Slack's Activity list shows a person's. The server derives the items
   * from the room posts (server/for-me.ts); the agent marks them with its mark_message tool, and the owner can mark one here too.
   */
  import { api, live, reads, view, type ForMeItem, type ForMeList, type Reaction } from "$lib/api";
  import { tick } from "svelte";
  import { Avatar, Button, Chip, EmptyState, Icon, IconButton, LoadingText, Tabs, ageLabel, listKey, moveListFocus, stampLabel, toast } from "$lib/ui";
  import { conversationHref } from "$lib/router.svelte";
  import { avatarOf } from "$pages/channel/present";
  import { FOR_FILTERS, FOR_FILTER_LABEL, REASON_LABEL, forCount, reasonChips, forEmpty, forTarget, previewText, type ForFilter } from "./agents-model";

  type Props = { agentId: string; name: string };
  let { agentId, name }: Props = $props();

  let filter = $state<ForFilter>("pending");
  /** The list of the agent and filter, from the page's kept answer when it holds one and read again behind it. */
  const answer = view(() => reads.forMe(agentId, filter));
  /** The last list this agent's tab showed, which stays while another filter's first answer is on its way. */
  let last = $state.raw<{ agent: string; list: ForMeList } | null>(null);
  const list = $derived(answer.value ?? (last?.agent === agentId ? last.list : null));
  const error = $derived(answer.error ?? "");
  let marking = $state<string | null>(null);
  let now = $state(Date.now());
  const load = () => answer.refresh();

  $effect(() => {
    if (!answer.value) return;
    last = { agent: agentId, list: answer.value };
    now = Date.now();
  });
  $effect(() => {
    const id = agentId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unwatch = live.watch(`for:${id}`);
    const off = live.on((event) => {
      if ((event.type === "for_me" && event.agent === id) || event.type === "hello") {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 100);
      }
    });
    return () => {
      clearTimeout(timer);
      off();
      unwatch();
    };
  });
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(tick);
  });

  const tabs = $derived(FOR_FILTERS.map((id) => ({ id, label: FOR_FILTER_LABEL[id], badge: forCount(list, id) })));

  let rows = $state<HTMLUListElement>();
  let markingAll = $state(false);
  const pendingIds = $derived(list?.items.filter((item) => item.status === "pending").map((item) => item.id) ?? []);
  const failed = (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "Could not mark the message");

  /** Marks one row; a row that leaves the shown filter gives its focus to the row that takes its place, and completing one offers Undo. */
  async function mark(item: ForMeItem, completed: boolean, undo = true) {
    if (marking || markingAll) return;
    marking = item.id;
    const focused = !!rows && rows.contains(document.activeElement);
    const at = list?.items.findIndex((row) => row.id === item.id) ?? -1;
    try {
      const { item: next, pending } = await api.markForMe(agentId, item.id, completed);
      if (list) {
        const moved = list.pending - pending;
        const items = filter === "all" ? list.items.map((row) => (row.id === next.id ? next : row)) : list.items.filter((row) => row.id !== next.id);
        answer.set({ ...list, items, pending, completed: list.completed + moved });
      }
      if (undo && completed) toast.success("Marked completed", { action: { label: "Undo", run: () => void mark(next, false, false) } });
    } catch (reason) {
      failed(reason);
    } finally {
      marking = null;
    }
    if (focused && at >= 0) {
      await tick();
      const links = rows?.querySelectorAll<HTMLElement>("[data-for-me-open]");
      links?.[Math.min(at, links.length - 1)]?.focus();
    }
  }

  /** Marks every pending row completed, as Slack's Mark all as read, with an Undo that makes those rows pending again. */
  async function markAll() {
    const ids = pendingIds;
    if (!ids.length || markingAll || marking) return;
    markingAll = true;
    try {
      const { changed } = await api.markForMeMany(agentId, ids, true);
      await load();
      if (changed.length) {
        toast.success(`Marked ${changed.length === 1 ? "1 message" : `${changed.length} messages`} completed`, {
          action: { label: "Undo", run: () => void api.markForMeMany(agentId, changed, false).then(load, failed) },
          duration: 8000,
        });
      }
    } catch (reason) {
      failed(reason);
    } finally {
      markingAll = false;
    }
  }

  /** The list's keys work from anywhere on the tab, as Slack's Activity keys do, but never inside an open dialog or menu. */
  function onkeydown(e: KeyboardEvent) {
    const key = listKey(e);
    if (!key || key === "close" || key === "all" || !rows) return;
    if (e.target instanceof Element && e.target.closest("dialog, [role=menu], [role=listbox]")) return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    if (key === "next" || key === "prev") return void moveListFocus(rows, "[data-for-me-open]", key);
    const id = (document.activeElement?.closest("[data-item-id]") as HTMLElement | null)?.dataset.itemId;
    const item = list?.items.find((row) => row.id === id);
    if (item) void mark(item, item.status !== "completed");
  }

  const hrefOf = (item: ForMeItem) => {
    const target = forTarget(item);
    return conversationHref(target.id, { messageId: target.messageId, thread: target.thread });
  };
  /** A channel's room name starts with `#` already. */
  const roomIcon = (item: ForMeItem) => (item.roomKind === "solo" ? "chat" : item.roomKind === "dm" ? "user" : null);
  const people = (reaction: Reaction) => reaction.by.map((b) => (b.id === "owner" ? "You" : b.name)).join(", ");
</script>

<svelte:window {onkeydown} />

<section class="for" aria-label="For {name}" data-testid="agent-for-me" data-agent-id={agentId} aria-keyshortcuts="j k e">
  <div class="head">
    <Tabs items={tabs} value={filter} size="sm" label="Which messages" onchange={(next) => (filter = next)} />
    {#if filter !== "completed" && pendingIds.length > 1}
      <span class="all">
        <Button size="sm" variant="ghost" icon="check" loading={markingAll} disabled={markingAll || !!marking}
          onclick={() => void markAll()}>Mark all completed</Button>
      </span>
    {/if}
    <span class="t-caption meta">Messages that name {name}, reach it in a room or DM, or react to its posts. Press j and k to move, e to mark one.</span>
  </div>

  {#if error && !list}
    <div class="note">
      <p class="t-body-sm warn" role="alert">The list could not load: {error}</p>
      <Button size="sm" icon="refresh" onclick={() => void load()}>Retry</Button>
    </div>
  {:else if !list}
    <div class="note"><LoadingText text="Reading its messages…" /></div>
  {:else if !list.items.length}
    <div data-testid="for-me-empty">
      <EmptyState icon={filter === "pending" ? "check" : "inbox"} title={filter === "pending" ? "All caught up" : forEmpty(name, filter)} description={filter === "pending" ? forEmpty(name, filter) : undefined} size="sm">
        {#snippet action()}
          {#if filter === "pending" && list.completed}<Button size="sm" onclick={() => (filter = "completed")}>See completed</Button>
          {:else if filter === "completed" && list.pending}<Button size="sm" onclick={() => (filter = "pending")}>See pending</Button>{/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <ul class="rows" bind:this={rows}>
      {#each list.items as item (item.id)}
        {@const face = avatarOf(item.author)}
        <li class="row" data-item-id={item.id} data-status={item.status}>
          <a class="open" href={hrefOf(item)} data-for-me-open>
            <span class="gutter"><Avatar name={face.name} kind={face.kind} seed={face.id} size={36} /></span>
            <span class="body">
              <span class="where t-caption">
                {#if roomIcon(item)}<Icon name={roomIcon(item)!} size={12} />{/if}
                <span class="room">{item.roomName}</span>
                {#if item.threadRoot}<span aria-hidden="true">·</span><span>thread</span>{/if}
                {#each reasonChips(item) as reason (reason)}<span class="reason" data-reason={reason}>{REASON_LABEL[reason]}</span>{/each}
              </span>
              <span class="line">
                <span class="author">{item.author.name}</span>
                <time datetime={new Date(item.activityAt).toISOString()} title={stampLabel(item.activityAt, now)}>{ageLabel(item.activityAt, now)}</time>
              </span>
              <span class="text t-body-sm" data-for-me-text>{previewText(item.text) || "(no text)"}</span>
              {#if item.reactions?.length}
                <span class="reactions" data-reactions>
                  {#each item.reactions as reaction (reaction.emoji)}
                    <span class="reaction" title="{people(reaction)} reacted with {reaction.emoji}" data-reaction={reaction.emoji}>
                      <span class="emoji">{reaction.emoji}</span><span class="count">{reaction.by.length}</span>
                    </span>
                  {/each}
                </span>
              {/if}
            </span>
          </a>
          <span class="mark">
            {#if item.status === "completed"}
              <Chip size="sm" icon="check" label="Completed" selected />
              <IconButton icon="refresh" label="Mark pending again" size="sm" loading={marking === item.id} disabled={!!marking} onclick={() => mark(item, false)} />
            {:else}
              <IconButton icon="check" label="Mark completed" size="sm" variant="outline" loading={marking === item.id} disabled={!!marking} onclick={() => mark(item, true)} />
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .for {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .meta {
    color: var(--text-metadata);
  }
  .warn {
    margin: 0;
    color: var(--text-danger);
  }
  .note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
    color: var(--text-metadata);
  }
  .all {
    margin-left: auto;
  }
  .rows {
    display: flex;
    flex-direction: column;
    margin: 0 -12px;
    padding: 0;
    list-style: none;
  }
  .row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 8px 12px;
    border-radius: 8px;
  }
  .row + .row {
    border-top: 1px solid var(--border-standard);
  }
  .row:hover {
    background: color-mix(in srgb, var(--affordance-ghost-hover) 60%, transparent);
  }
  .open {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    column-gap: 8px;
    flex: 1;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  }
  .where {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
  }
  .room {
    color: var(--text-subtle);
    font-weight: 500;
  }
  .reason {
    padding: 0 6px;
    border-radius: var(--radius-capsule);
    background: var(--surface-inset);
    color: var(--text-subtle);
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .author {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-standard);
    font: var(--text-label-sm);
    font-weight: 700;
  }
  .line time {
    flex: none;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .row[data-status="completed"] .text {
    color: var(--text-subtle);
  }
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }
  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px 0 6px;
    border-radius: 11px;
    background: color-mix(in srgb, var(--text-standard) 6%, transparent);
    color: var(--text-subtle);
  }
  .emoji {
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 14px;
    line-height: 1;
  }
  .count {
    font: 500 12px/16px var(--font-sans);
    font-variant-numeric: tabular-nums;
  }
  .mark {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    padding-top: 2px;
  }
</style>
