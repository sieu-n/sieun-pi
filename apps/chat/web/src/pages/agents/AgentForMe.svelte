<script lang="ts">
  /**
   * The For <agent> tab: every message the agent is involved in, as Slack's Activity list shows a person's. The server derives the items
   * from the room posts (server/for-me.ts); the agent marks them with its mark_message tool, and the owner can mark one here too.
   */
  import { api, live, type ForMeItem, type ForMeList, type Reaction } from "$lib/api";
  import { Avatar, Button, Chip, Icon, IconButton, LoadingText, Tabs, ageLabel, stampLabel, toast } from "$lib/ui";
  import { conversationHref } from "$lib/router.svelte";
  import { avatarOf } from "$pages/channel/present";
  import { FOR_FILTERS, FOR_FILTER_LABEL, REASON_LABEL, forCount, reasonChips, forEmpty, forTarget, previewText, type ForFilter } from "./agents-model";

  type Props = { agentId: string; name: string };
  let { agentId, name }: Props = $props();

  let filter = $state<ForFilter>("pending");
  let list = $state<ForMeList | null>(null);
  let error = $state("");
  let marking = $state<string | null>(null);
  let now = $state(Date.now());
  let latest = 0;

  /** Only the newest call writes, so a slow answer never replaces a newer one. */
  async function load() {
    const mine = ++latest;
    const id = agentId;
    const status = filter;
    try {
      const next = await api.forMe(id, status);
      if (mine !== latest) return;
      list = next;
      error = "";
      now = Date.now();
    } catch (reason) {
      if (mine === latest) error = reason instanceof Error ? reason.message : String(reason);
    }
  }

  $effect(() => {
    void agentId;
    void filter;
    void load();
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

  async function mark(item: ForMeItem, completed: boolean) {
    if (marking) return;
    marking = item.id;
    try {
      const { item: next, pending } = await api.markForMe(agentId, item.id, completed);
      if (list) {
        const moved = list.pending - pending;
        const items = filter === "all" ? list.items.map((row) => (row.id === next.id ? next : row)) : list.items.filter((row) => row.id !== next.id);
        list = { ...list, items, pending, completed: list.completed + moved };
      }
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not mark the message");
    } finally {
      marking = null;
    }
  }

  const hrefOf = (item: ForMeItem) => {
    const target = forTarget(item);
    return conversationHref(target.id, { messageId: target.messageId, thread: target.thread });
  };
  /** A channel's room name starts with `#` already. */
  const roomIcon = (item: ForMeItem) => (item.roomKind === "solo" ? "chat" : item.roomKind === "dm" ? "user" : null);
  const people = (reaction: Reaction) => reaction.by.map((b) => (b.id === "owner" ? "You" : b.name)).join(", ");
</script>

<section class="for" aria-label="For {name}" data-testid="agent-for-me" data-agent-id={agentId}>
  <div class="head">
    <Tabs items={tabs} value={filter} size="sm" label="Which messages" onchange={(next) => (filter = next)} />
    <span class="t-caption meta">Messages that name {name}, reach it in a room or DM, or react to its posts.</span>
  </div>

  {#if error && !list}
    <div class="note">
      <p class="t-body-sm warn" role="alert">The list could not load: {error}</p>
      <Button size="sm" icon="refresh" onclick={() => void load()}>Retry</Button>
    </div>
  {:else if !list}
    <div class="note"><LoadingText text="Reading its messages…" /></div>
  {:else if !list.items.length}
    <p class="t-body-sm empty" data-testid="for-me-empty">{forEmpty(name, filter)}</p>
  {:else}
    <ul class="rows">
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
  .empty {
    margin: 0;
    padding: var(--space-4) 0;
    color: var(--text-subtle);
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
