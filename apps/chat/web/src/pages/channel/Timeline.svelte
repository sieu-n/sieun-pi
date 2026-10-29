<script lang="ts">
  import { tick } from "svelte";
  import type { Item, TurnPlace } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import DayDivider from "$lib/ui/DayDivider.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import SystemLine from "$lib/ui/SystemLine.svelte";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import MessageRow from "./MessageRow.svelte";
  import { avatarKind, waitingSend } from "./present";
  import { layoutRows } from "./rows";

  type Props = {
    items: Item[];
    loading: boolean;
    error: string | null;
    hasOlder: boolean;
    loadingOlder: boolean;
    loadOlder: () => Promise<void>;
    /** The item to scroll to and flash, from a search hit or a link. */
    focus?: string;
    context: MarkdownContext;
    liveLabel?: string | null;
    /** The run's place in the turn queue, shown under the send that waits for it. */
    queue?: TurnPlace | null;
    openThread?: string | null;
    canReply?: boolean;
    /** The side pane draws a tighter column. */
    compact?: boolean;
    /** bubble is the chat look; slack draws channel rows as Slack does. */
    layout?: "bubble" | "slack";
    /** In slack layout, the intro drawn above the first post once no older posts are left, and as the empty state; a Solo room says room. */
    beginning?: { name: string; purpose?: string | null; kind?: "channel" | "solo" } | null;
    /** In a thread pane, the replies under the root; Timeline draws an "N replies" divider after the first row. */
    replyCount?: number | null;
    statusOf?: (id: string) => Status | null;
    onretry: () => void;
    /** Retry and Discard on a send that was not delivered. */
    onretrysend?: (item: Item) => void;
    ondiscardsend?: (item: Item) => void;
    onthread: (key: string) => void;
    oncopylink: (item: Item) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
    onbottom?: () => void;
  };
  let {
    items, loading, error, hasOlder, loadingOlder, loadOlder, focus, context, liveLabel = null, queue = null, openThread = null, canReply = false, compact = false,
    layout = "bubble", beginning = null, replyCount = null,
    statusOf, onretry, onretrysend, ondiscardsend, onthread, oncopylink, onmention, onboardid, onartifact, onbottom,
  }: Props = $props();

  const rows = $derived(layoutRows(items));
  const slack = $derived(layout === "slack");
  const intro = $derived(slack && beginning && !hasOlder && !loadingOlder ? beginning : null);
  const introName = $derived(intro ? (intro.kind === "solo" ? intro.name : `#${intro.name}`) : "");
  const firstPost = $derived(rows.find((row) => row.kind === "post")?.key ?? null);
  const waitingId = $derived(queue ? waitingSend(items) : null);
  const liveId = $derived(items.findLast((item) => item.kind === "turn" && item.live)?.id ?? null);
  let scroller = $state<HTMLElement>();
  let stick = true;
  let showJump = $state(false);
  let flashId = $state<string | null>(null);
  let focused: string | undefined;

  const lastKey = $derived.by(() => {
    const last = items.at(-1);
    return last ? `${items.length}:${last.id}:${last.kind === "system" ? "" : last.text.length}:${last.kind === "turn" ? last.steps.length : 0}` : "";
  });

  $effect(() => {
    void lastKey;
    if (!scroller || loading || !stick) return;
    void tick().then(() => toBottom());
  });

  $effect(() => {
    if (!scroller || loading || !focus || focused === focus) return;
    focused = focus;
    const id = focus;
    void tick().then(() => {
      const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!row) return;
      stick = false;
      row.scrollIntoView({ block: "center" });
      flashId = id;
      setTimeout(() => {
        if (flashId === id) flashId = null;
      }, 2000);
    });
  });

  let rowsEl = $state<HTMLElement>();
  $effect(() => {
    if (!rowsEl) return;
    const observer = new ResizeObserver(() => {
      if (stick) toBottom();
    });
    observer.observe(rowsEl);
    return () => observer.disconnect();
  });

  function toBottom() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    onbottom?.();
  }

  async function older() {
    if (!scroller || loadingOlder || !hasOlder) return;
    const before = scroller.scrollHeight;
    await loadOlder();
    await tick();
    if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
  }

  function onscroll() {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const wasStuck = stick;
    stick = distance < 80;
    showJump = distance > 400;
    if (stick && !wasStuck) onbottom?.();
    if (scroller.scrollTop < 240 && hasOlder && !loadingOlder) void older();
  }

  function jump() {
    stick = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    onbottom?.();
  }
</script>

<div class="timeline" class:compact>
  <div class="feed" bind:this={scroller} {onscroll} data-testid="timeline">
    {#if loading}
      <div class="state"><LoadingText text="Loading messages…" /></div>
    {:else if error && !items.length}
      <div class="state">
        <p>Could not load messages. {error}</p>
        <Button variant="outline" size="sm" icon="refresh" onclick={onretry}>Retry messages</Button>
      </div>
    {:else if !items.length && !intro}
      <div class="state empty">
        <p class="title">No messages yet.</p>
        <p>Start the conversation below.</p>
      </div>
    {:else}
      <div class="edge">
        {#if loadingOlder}
          <LoadingText text="Loading older…" delay={300} />
        {:else if hasOlder}
          <Button variant="ghost" size="sm" onclick={older}>Load older messages</Button>
        {/if}
      </div>
      {#if intro}
        <div class="intro" data-testid="channel-intro">
          <h2 class="intro-name">{introName}</h2>
          <p>This is the very beginning of the <span class="intro-channel">{introName}</span> {intro.kind === "solo" ? "room" : "channel"}.</p>
          {#if intro.purpose}<p class="intro-purpose">{intro.purpose}</p>{/if}
        </div>
      {/if}
      <ol class="rows" bind:this={rowsEl}>
        {#each rows as row (row.key)}
          {#if row.kind === "day"}
            {#if !(slack && compact)}<li class="day"><DayDivider at={row.at} variant={slack ? "pill" : "calendar"} /></li>{/if}
          {:else if row.kind === "system"}
            <li data-message-id={row.item.id}>
              <SystemLine
                text={row.item.text}
                members={row.item.kind === "system" ? row.item.avatars.map((a) => ({ id: a.id, name: a.name, kind: avatarKind(a) })) : []}
              />
            </li>
          {:else if row.item.kind !== "system"}
            <MessageRow
              item={row.item}
              first={row.first}
              last={row.last}
              {layout}
              fullTime={slack && compact}
              {context}
              liveLabel={row.item.id === liveId ? liveLabel : null}
              queue={row.item.id === waitingId ? queue : null}
              flash={flashId === row.item.id}
              {openThread}
              canReply={canReply && row.item.kind === "message" && !row.item.threadRoot}
              {statusOf}
              {onretrysend}
              {ondiscardsend}
              {onthread}
              {oncopylink}
              {onmention}
              {onboardid}
              {onartifact}
            />
          {/if}
          {#if replyCount && row.key === firstPost}
            <li class="replies" data-testid="thread-replies-divider">
              <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </div>
  <div class="jump" class:visible={showJump}>
    <Button variant="outline" size="sm" icon="arrow-down" onclick={jump} tabindex={showJump ? 0 : -1}>Jump to latest</Button>
  </div>
</div>

<style>
  .timeline {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-anchor: none;
    padding: 0 var(--space-panel-inset) 16px;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
  }
  .compact .feed {
    padding: 0 16px 12px;
  }
  .rows,
  .edge,
  .state {
    width: min(100%, var(--timeline-measure, 52rem));
    margin-inline: auto;
  }
  .rows {
    margin-block: 0;
    padding: 0;
    list-style: none;
  }
  .edge {
    display: flex;
    justify-content: center;
    min-height: 16px;
    padding-top: 12px;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .day {
    list-style: none;
  }
  .intro {
    width: min(100%, var(--timeline-measure, 52rem));
    margin: 0 auto 8px;
    padding: 24px 0 8px;
    color: var(--text-subtle);
    font: var(--text-body);
    letter-spacing: var(--tracking-body);
  }
  .intro p {
    margin: 0;
  }
  .intro-name {
    margin: 0 0 8px;
    color: var(--text-standard);
    font: var(--text-heading);
    font-weight: 700;
    letter-spacing: var(--tracking-heading);
    overflow-wrap: anywhere;
  }
  .intro-channel {
    color: var(--text-message-link);
  }
  .intro-purpose {
    margin-top: 4px;
  }
  .replies {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    list-style: none;
  }
  .replies::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-standard);
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 64px 16px;
    color: var(--text-subtle);
    font: var(--text-body-sm);
    text-align: center;
  }
  .state p {
    margin: 0;
  }
  .state .title {
    color: var(--text-standard);
    font-weight: 500;
  }
  .jump {
    position: absolute;
    bottom: 12px;
    left: 50%;
    z-index: 3;
    border-radius: var(--radius-capsule);
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
    box-shadow: var(--shadow-sm);
    opacity: 0;
    visibility: hidden;
    transform: translate(-50%, 2px) scale(0.97);
    transition:
      opacity var(--duration-fast) var(--ease-standard),
      transform var(--duration-fast) var(--ease-enter),
      visibility 0s var(--duration-fast);
  }
  .jump.visible {
    opacity: 1;
    visibility: visible;
    transform: translate(-50%, 0) scale(1);
    transition-delay: 0s;
  }
</style>
