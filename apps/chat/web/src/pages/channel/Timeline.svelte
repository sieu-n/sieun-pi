<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { newestReply, type Item, type TurnPlace, type Wait } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { stampLabel } from "$lib/ui/datetime";
  import { composing } from "$lib/ui/keyboard";
  import DayDivider from "$lib/ui/DayDivider.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import SystemLine from "$lib/ui/SystemLine.svelte";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import { hrefFor } from "$lib/router.svelte";
  import MessageRow from "./MessageRow.svelte";
  import { avatarOf, waitingSend } from "./present";
  import { dayGroups, keepGroups, layoutRows, newestRows, type DayGroup } from "./rows";

  type Props = {
    items: Item[];
    loading: boolean;
    error: string | null;
    hasOlder: boolean;
    loadingOlder: boolean;
    /** Reads the page above the first row; `wait` tags a read the view asked for on its own, which no one waits on (api `Wait`). */
    loadOlder: (wait?: Wait) => Promise<void>;
    /** The item to scroll to and flash, from a search hit or a link. */
    focus?: string;
    /** False scrolls to `focus` without flashing it, as the room under a thread pane does when the link names a reply. */
    flashFocus?: boolean;
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
    /**
     * The intro drawn above the first post once no older posts are left, and as the empty state: a channel's or Solo room's in slack layout,
     * and in a DM, as in Slack, the agent's avatar and name with a link to its page.
     */
    beginning?: { name: string; purpose?: string | null; kind?: "channel" | "solo" } | { kind: "dm"; name: string; agent: string } | null;
    /** Buttons under a channel's or Solo room's intro, such as Slack's Add description and Add people. */
    introActions?: Snippet;
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
    /** The post the red New line goes over, as in Slack: the first unread one, or the one the owner marked unread. */
    newLine?: string | null;
    /** The feed reached its bottom; `byUser` when the owner scrolled or jumped there himself rather than a new row pulling the feed down. */
    onbottom?: (byUser: boolean) => void;
    /** With a New line, Slack's bar on top, "3 new messages since 8:25 PM", whose Mark as read calls this. */
    onmarkread?: () => void;
  };
  let {
    items, loading, error, hasOlder, loadingOlder, loadOlder, focus, flashFocus = true, context, liveLabel = null, queue = null, openThread = null, canReply = false, compact = false,
    layout = "bubble", beginning = null, introActions, replyCount = null, newLine = null,
    statusOf, onretry, onretrysend, ondiscardsend, onthread, oncopylink, onmention, onboardid, onartifact, onbottom, onmarkread,
  }: Props = $props();

  /** A post the owner deleted goes, as in Slack, except a channel root that keeps its replies, and the root atop a thread pane. */
  const shown = $derived(items.filter((item, index) => !(item.kind === "message" && item.deleted && !item.thread && !(replyCount !== null && index === 0))));
  const rows = $derived(layoutRows(shown, replyCount ? shown[0]?.id : undefined));
  /**
   * An open draws its newest rows first and the history above them a task later, so the bottom of the timeline paints before every older
   * row is built. When the newest rows do not fill the view, the rest draw in the same frame, so the view never shows a gap.
   */
  const FIRST_ROWS = 16;
  let full = $state(false);
  let keptDays: DayGroup<Item>[] = [];
  const days = $derived((keptDays = keepGroups(keptDays, dayGroups(rows))));
  const drawn = $derived(full ? days : newestRows(days, FIRST_ROWS));
  /**
   * The newest rows, on screen when a thread opens, always draw instead of standing at content-visibility's guessed height. On 11-24 a channel
   * whose days held one post each kept only its newest row drawn, and the rest jumped from 160 px to their real height on open (CLS 0.11).
   */
  const eager = $derived(new Set(newestRows(days, FIRST_ROWS).flatMap((day) => day.rows.map((row) => row.key))));
  const slack = $derived(layout === "slack");
  const intro = $derived(beginning && (slack || beginning.kind === "dm") && full && !hasOlder && !loadingOlder ? beginning : null);
  const introName = $derived(intro ? (intro.kind === "solo" || intro.kind === "dm" ? intro.name : `#${intro.name}`) : "");
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
    // A new reply in a thread whose pill shows counts too, so a feed at its bottom reads it (Conversation `markRead`).
    return last ? `${items.length}:${last.id}:${last.kind === "system" ? "" : last.text.length}:${last.kind === "turn" ? last.steps.length : 0}:${newestReply(items)}` : "";
  });

  /** A new row scrolls in the frame's own layout, which the rows' ResizeObserver also reads, rather than forcing a layout of every row in the render task. */
  let bottomFrame = 0;
  /**
   * His own send (the store's `r:<requestId>` row) pins the feed again wherever he had scrolled, as in Slack. On 11-24 a send after a scroll
   * up of 250 px or more, or with a New line held, stayed out of view in every room kind in Chromium and WebKit.
   */
  let ownSend: string | null = null;
  $effect(() => {
    void lastKey;
    const last = items.at(-1);
    if (last?.kind === "message" && last.pending && last.send === "sending" && last.id !== ownSend) {
      ownSend = last.id;
      stick = true;
      held = anchor = null;
      handAt = -Infinity;
    }
    if (!scroller || loading || !stick || bottomFrame) return;
    bottomFrame = requestAnimationFrame(() => {
      bottomFrame = 0;
      if (stick) toBottom();
    });
  });
  $effect(() => () => cancelAnimationFrame(bottomFrame));

  $effect(() => {
    if (full || loading || !scroller) return;
    if (rows.length <= FIRST_ROWS) {
      full = true;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) full = true;
      else timer = setTimeout(() => void drawAll());
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  });

  $effect(() => {
    if (!scroller || loading || !full || !focus || focused === focus) return;
    focused = focus;
    const id = focus;
    void tick().then(() => {
      const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!row) return;
      stick = false;
      row.scrollIntoView({ block: "center" });
      held = { row, top: row.getBoundingClientRect().top };
      if (!flashFocus) return;
      flashId = id;
      setTimeout(() => {
        if (flashId === id) flashId = null;
      }, 2000);
    });
  });

  /**
   * A row off screen skips layout and paint (content-visibility in .day-rows) and stands at a guessed height until it nears the view. When
   * one above the view then draws at its real height, it would push the rows on screen, and the feed turns the browser's scroll anchoring
   * off (WebKit has none), so the feed keeps the row in the middle of the view where it was itself.
   */
  let anchor: { row: Element; top: number } | null = null;
  /**
   * The post a link opened, which stays where the open centered it, as in Slack, until he scrolls himself. On 11-20 the rows above a
   * linked post on live drew at their real heights after the scroll (scrollHeight 1854 to 4170) and pushed it out of view, and holding it
   * only through noteAnchor still lost it in 6 of 10 opens.
   */
  let held: { row: Element; top: number } | null = null;
  /**
   * When his hand last moved the feed (a wheel, a touch, a key or a press in it), so a scroll within HAND_MS of it is his own. Only his own
   * scroll unpins the feed: on 11-24 WebKit's scroll from the composer shrinking after an image send read 122 to 244 px from the bottom in
   * 9 of 9 sends, and toBottom's own scroll read up to 751 px after rows grew in 4 of 27 Chromium and 3 of 28 WebKit opens.
   */
  let handAt = -Infinity;
  const HAND_MS = 1000;
  $effect(() => {
    const feed = scroller;
    if (!feed) return;
    const release = () => {
      held = null;
      handAt = performance.now();
    };
    // A click on the feed outside a post focuses nothing, so his scroll keys then go to the body.
    const key = (e: KeyboardEvent) => {
      if (e.target === document.body || (e.target instanceof Node && feed.contains(e.target))) release();
    };
    const events = ["wheel", "touchstart", "pointerdown"] as const;
    for (const type of events) feed.addEventListener(type, release, { passive: true });
    window.addEventListener("keydown", key, { passive: true });
    return () => {
      events.forEach((type) => feed.removeEventListener(type, release));
      window.removeEventListener("keydown", key);
    };
  });
  function noteAnchor() {
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const row = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".day-rows > li");
    anchor = row ? { row, top: row.getBoundingClientRect().top } : null;
  }

  /**
   * Mark unread draws the New line, and the marked post's byline, over a post on screen. The post stays under his pointer, as in Slack, so
   * the rows above it move instead: the feed holds it as it holds a linked post, until he scrolls himself.
   */
  /**
   * A room opens at its newest post, as before, unless the New line would sit above the view: then it opens with the line near the top,
   * as Slack does, and holds it there while the rows above draw. The open's read has gone out already from the bottom.
   */
  let landedAt: string | null = null;
  $effect(() => {
    const id = newLine ?? null;
    if (!id || id === landedAt || loading || !full || !scroller || focus) return;
    landedAt = id;
    requestAnimationFrame(() => {
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (!scroller || !row) return;
      const top = scroller.getBoundingClientRect().top;
      if (row.getBoundingClientRect().top >= top + 24) return;
      stick = false;
      // 72 px clears the sticky date over the feed's top, so the New line above the post shows whole.
      scroller.scrollTop += row.getBoundingClientRect().top - top - 72;
      held = { row, top: row.getBoundingClientRect().top };
    });
  });

  let lineShown: string | null = null;
  $effect.pre(() => {
    const id = newLine ?? null;
    if (id === lineShown) return;
    lineShown = id;
    const row = id && scroller && !loading ? scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`) : null;
    if (!row) return;
    stick = false;
    held = { row, top: row.getBoundingClientRect().top };
  });

  let rowsEl = $state<HTMLElement>();
  $effect(() => {
    if (!rowsEl) return;
    const observer = new ResizeObserver(() => {
      if (scroller && held?.row.isConnected) {
        scroller.scrollTop += held.row.getBoundingClientRect().top - held.top;
        return;
      }
      if (stick) toBottom();
      else if (scroller && anchor?.row.isConnected) {
        const moved = anchor.row.getBoundingClientRect().top - anchor.top;
        if (moved) scroller.scrollTop += moved;
        noteAnchor();
      }
    });
    observer.observe(rowsEl);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  });

  function toBottom() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    onbottom?.(false);
  }

  /** Draws the rows above the first ones and keeps the view where it was, before a scroll event can read the new height as a scroll up. */
  async function drawAll() {
    const before = scroller?.scrollHeight ?? 0;
    full = true;
    await tick();
    if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
  }

  /**
   * Loads the rows above. A load he did not scroll for, such as the fill after a short job page opens at its bottom, goes as a read ahead,
   * since the open's rows already show: on 11-23 one such read of 564 ms counted as a wait on the open in the d2 duty (p215 walk).
   */
  async function older(byHand = true) {
    if (!scroller || loadingOlder || !hasOlder) return;
    const before = scroller.scrollHeight;
    await loadOlder(byHand ? undefined : { background: "ahead", first: true });
    await tick();
    if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
  }

  function onscroll() {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const wasStuck = stick;
    const byHand = performance.now() - handAt < HAND_MS;
    stick = distance < 80 || (wasStuck && !byHand);
    showJump = !stick && distance > 400;
    // Reaching the bottom is his own read, except while the post he marked unread is still on screen: only scrolling past it reads it.
    if (stick && !wasStuck) onbottom?.(!lineOnScreen());
    if (!stick && !held) noteAnchor();
    if (scroller.scrollTop < 240 && full && hasOlder && !loadingOlder) void older(byHand);
  }

  function lineOnScreen(): boolean {
    const row = newLine && scroller ? scroller.querySelector(`[data-message-id="${CSS.escape(newLine)}"]`) : null;
    return !!row && !!scroller && row.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top;
  }

  /** The bar's count and time: the posts from the New line down, and when the first of them came. */
  const fresh = $derived.by(() => {
    if (!newLine || !onmarkread || loading) return null;
    const from = shown.findIndex((item) => item.id === newLine);
    if (from < 0) return null;
    return { count: shown.slice(from).filter((item) => item.kind !== "system").length, at: shown[from]!.at };
  });

  /** The bar's jump puts the New line under the sticky date, which covers the top 40 px of the feed. */
  function toNewLine() {
    const line = scroller?.querySelector<HTMLElement>("[data-testid=new-line]");
    if (!scroller || !line) return;
    stick = false;
    scroller.scrollTop += line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    held = { row: line, top: line.getBoundingClientRect().top };
  }

  function jump() {
    stick = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    onbottom?.(true);
  }

  const POSTS = "li[data-message-id][data-kind]";
  const POST_KEYS = new Set(["e", "r", "t", "a", "m", "u", "p", "Delete"]);
  /** The post keyboard focus was on last, which Shift+Tab from the composer goes back to. */
  let lastFocused: HTMLElement | null = null;
  let root = $state<HTMLElement>();

  function posts(): HTMLElement[] {
    return scroller ? [...scroller.querySelectorAll<HTMLElement>(POSTS)] : [];
  }

  function focusPost(row: HTMLElement | undefined) {
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
    lastFocused = row;
  }

  /** Up and Down move to the post above or below; above the first one drawn, the older rows draw or load first. */
  async function stepFocus(row: HTMLElement, by: -1 | 1) {
    if (by < 0 && posts()[0] === row && (!full || hasOlder)) await (full ? older() : drawAll());
    const list = posts();
    focusPost(list[list.indexOf(row) + by]);
  }

  /**
   * Slack's message keys. Shift+Tab from this feed's composer focuses the post focused last, else the newest; Up and Down move between
   * posts; and a single key acts on the focused post, else the one under the pointer: E edit, R react, T thread, A save for later, M remind
   * me, U mark unread, Delete delete. MessageRow takes the `postkey` event and cancels it when the key did something.
   */
  function postKeys(e: KeyboardEvent) {
    if (e.defaultPrevented || composing(e) || !scroller || document.querySelector("[role=menu], dialog[open]")) return;
    const target = e.target instanceof Element ? e.target : null;
    if (e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const box = target?.closest("[data-testid=composer-input]");
      if (!box || !root?.parentElement?.contains(box)) return;
      const list = posts();
      const row = lastFocused && list.includes(lastFocused) ? lastFocused : list.at(-1);
      if (!row) return;
      e.preventDefault();
      focusPost(row);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    const focusedRow = target?.closest<HTMLElement>(POSTS) ?? null;
    if (focusedRow && !scroller.contains(focusedRow)) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!focusedRow || focusedRow !== target) return;
      e.preventDefault();
      void stepFocus(focusedRow, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.repeat) return;
    const key = e.key === "Backspace" ? "Delete" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!POST_KEYS.has(key)) return;
    // A post focused from the keyboard wins; after a click, the post under the pointer does, as the mouse has moved on.
    const keyed = focusedRow === target && focusedRow?.matches(":focus-visible") ? focusedRow : null;
    const row = keyed ?? scroller.querySelector<HTMLElement>(`${POSTS}:hover`) ?? focusedRow;
    if (row && !row.dispatchEvent(new CustomEvent("postkey", { detail: key, cancelable: true }))) e.preventDefault();
  }
</script>

<svelte:window onkeydown={postKeys} />

<div class="timeline" class:compact bind:this={root}>
  {#if fresh && onmarkread}
    <div class="fresh" role="status" data-testid="new-messages-bar">
      <button type="button" class="fresh-jump" onclick={toNewLine} title="Jump to the first new message">
        <Icon name="arrow-up" size={14} />
        <span>{fresh.count} new {fresh.count === 1 ? "message" : "messages"} since {stampLabel(fresh.at)}</span>
      </button>
      <button type="button" class="fresh-read" onclick={onmarkread} title="Mark as read (Esc)">Mark as read</button>
    </div>
  {/if}
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
        {#if full && loadingOlder}
          <LoadingText text="Loading older…" delay={300} />
        {:else if full && hasOlder}
          <Button variant="ghost" size="sm" onclick={() => older()}>Load older messages</Button>
        {/if}
      </div>
      {#if intro?.kind === "dm"}
        <div class="intro dm" data-testid="dm-intro">
          <Avatar name={intro.name} kind="agent" seed={intro.agent} size={72} status={statusOf?.(intro.agent) ?? null} />
          <h2 class="intro-name">{intro.name}</h2>
          <p>This conversation is just between you and {intro.name}. Its page has its jobs, board and memory.</p>
          <Button variant="outline" size="sm" icon="robot" href={hrefFor("agents", [intro.agent])}>Open agent</Button>
        </div>
      {:else if intro}
        <div class="intro" data-testid="channel-intro">
          <h2 class="intro-name">{introName}</h2>
          <p>This is the very beginning of the <span class="intro-channel">{introName}</span> {intro.kind === "solo" ? "room" : "channel"}.</p>
          {#if intro.purpose}<p class="intro-purpose">{intro.purpose}</p>{/if}
          {#if introActions}<div class="intro-actions">{@render introActions()}</div>{/if}
        </div>
      {/if}
      <div class="rows" bind:this={rowsEl}>
        {#each drawn as day (day.key)}
          <div class="day-group">
            {#if !(slack && compact)}<div class="day"><DayDivider at={day.day.at} variant={slack ? "pill" : "calendar"} /></div>{/if}
            <ol class="day-rows">
              {#each day.rows as row (row.key)}
                {#if row.kind === "system"}
                  <li class:eager={eager.has(row.key)} data-message-id={row.item.id}>
                    <SystemLine
                      text={row.item.text}
                      members={row.item.kind === "system" ? row.item.avatars.map(avatarOf) : []}
                    />
                  </li>
                {:else if row.item.kind !== "system"}
                  {#if row.item.id === newLine}
                    <li class="new-line" class:eager={eager.has(row.key)} role="separator" aria-label="New messages" data-testid="new-line"><span>New</span></li>
                  {/if}
                  <MessageRow
                    item={row.item}
                    eager={eager.has(row.key)}
                    first={row.first || row.item.id === newLine}
                    last={row.last}
                    replyTo={row.replyTo ?? null}
                    {layout}
                    fullTime={slack && compact}
                    {context}
                    liveLabel={row.item.id === liveId ? liveLabel : null}
                    queue={row.item.id === waitingId ? queue : null}
                    flash={flashId === row.item.id}
                    {openThread}
                    canReply={canReply && row.item.kind === "message" && (!row.item.threadRoot || !!row.item.alsoInChannel)}
                    alsoIn={row.item.kind === "message" && row.item.alsoInChannel ? (replyCount !== null ? "thread" : "channel") : null}
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
                  <li class="replies" class:eager={eager.has(row.key)} data-testid="thread-replies-divider">
                    <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
                  </li>
                {/if}
              {/each}
            </ol>
          </div>
        {/each}
      </div>
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
    display: flex;
    flex-direction: column;
    padding: 0 var(--space-panel-inset) 16px;
    scrollbar-gutter: stable;
  }
  .feed > * {
    flex: none;
  }
  .compact .feed {
    padding: 0 16px 12px;
  }
  .compact .edge {
    margin-top: 0;
  }
  .rows,
  .edge,
  .state {
    width: min(100%, var(--timeline-measure, 52rem));
    margin-inline: auto;
  }
  .day-rows {
    margin-block: 0;
    padding: 0;
    list-style: none;
  }
  /*
   * A long thread holds over 12,000 nodes, and on 11-20 each older page that came in blocked the main thread for 230 to 330 ms. A row off
   * screen skips its layout and paint and keeps the height it last drew at; the newest rows (.eager), on screen when a thread opens, always draw.
   */
  .day-rows > :global(li) {
    content-visibility: auto;
    contain-intrinsic-size: auto none auto 160px;
  }
  /* Containment clips what a row draws outside itself, so a row that shows its hover toolbar above its top edge drops it. */
  .day-rows > :global(li.eager),
  .day-rows > :global(li:is(:hover, :focus-within, .picking)) {
    content-visibility: visible;
  }
  .edge {
    display: flex;
    flex: none;
    justify-content: center;
    margin-top: auto;
    min-height: 16px;
    padding-top: 12px;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  /* Slack's sticky date: a day's divider rides the top of the feed while that day's rows scroll under it, and DayDivider drops its rule once stuck. */
  .day {
    position: sticky;
    top: 8px;
    z-index: 2;
    container-type: scroll-state;
    pointer-events: none;
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
  .intro.dm {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding-top: 32px;
  }
  .intro.dm .intro-name {
    margin: 4px 0 0;
  }
  .intro.dm p {
    margin-bottom: 4px;
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
  .intro-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
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
  /* Slack's New line: a red rule over the first unread post with "New" at its right end. */
  .new-line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    color: var(--border-danger);
    font: var(--text-caption);
    font-weight: 700;
    letter-spacing: var(--tracking-caption);
    list-style: none;
  }
  .new-line::before {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-danger);
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
  /* Slack's New messages bar: the count since the first new post, which jumps to the New line, and Mark as read. */
  .fresh {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    width: min(calc(100% - 2 * var(--space-panel-inset)), var(--timeline-measure, 52rem));
    margin: 8px auto 0;
    border-radius: var(--radius-container);
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
    box-shadow: var(--shadow-sm);
    font: var(--text-caption);
    font-weight: 600;
    letter-spacing: var(--tracking-caption);
    overflow: hidden;
  }
  .fresh button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .fresh-jump {
    min-width: 0;
  }
  .fresh-jump span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fresh-read {
    flex: none;
    border-left: 1px solid color-mix(in srgb, currentColor 30%, transparent) !important;
  }
  .fresh button:hover {
    background: color-mix(in srgb, currentColor 14%, transparent);
  }
  .fresh button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: -3px;
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
