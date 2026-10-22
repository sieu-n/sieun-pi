<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui, BOARD_DEFAULT, boardMax, BOARD_MIN } from "./ui.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { createdSessions } from "../shared/created-sessions.ts";
  import { briefFor, briefFromCode, findJob, isActiveJob, jobName, jobNames, jobViews, reportsFor, spawnCalls } from "./jobs.ts";
  import { mentionIndex, openAgentTodos } from "./board.ts";
  import { dutiesFeed } from "./duties.svelte.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { catalogNames, chatFeed, chatLines, settledPending, turnStarter, type ChatItem, type Fold } from "../shared/chat-feed.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";
  import { replyExcerpt } from "./reply.ts";
  import { proseClick } from "./prose.ts";
  import type { BoardOp, ChatAgent, ChatBoard, ChildAgent, ChildPulse, ChildUsage, ImageInput, ModelCatalog, ModelInfo, PlanItem, ThinkingLevel } from "../shared/types.ts";
  import ChatComposer from "./ChatComposer.svelte";
  import ChatLines from "./ChatLines.svelte";
  import BoardPanel from "./BoardPanel.svelte";
  import ThreadTitle from "./ThreadTitle.svelte";
  import AccountChip from "./AccountChip.svelte";
  import CheckInControl, { checkInStatus } from "./CheckInControl.svelte";
  import SlackSync from "./SlackSync.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { archivePrompt } from "./archive-confirm.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import Icon from "./Icon.svelte";
  import { lazy } from "./lazy.ts";
  import Lightbox from "./ui/Lightbox.svelte";
  import Floating from "./ui/Floating.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { labels } from "./labels.ts";
  import { rowModelId } from "./accounts.ts";
  import { copyPermalink, revealLine, revealMessage } from "./permalink.ts";
  import { earlierTop, FIRST_ITEMS, holdPlace, laterBottom, nearTop, settledFrom, windowEnd, windowStart, type FeedPlace, type WindowItem } from "./feed-window.ts";
  import { childUsage } from "./thread-side.svelte.ts";

  /**
   * The chat view of one thread whose row has `chat`: a DM-style feed and a box that always sends at once, with the board in a side
   * panel on a wide window and behind a Chat / Board switch on a phone. The chat's jobs are rows under it in the sidebar; a job opens in
   * a drawer over the panel, from the sidebar, the feed, or a plan step that links it. Board ids in the text (`p7`, `s3`) render as chips
   * that open the plan view (`store.planView`), the whole board as a tree in a modal, on that item.
   */
  let { id, narrow }: { id: string; narrow: boolean } = $props();

  const entry = $derived(store.thread(id));
  const thread = $derived(entry?.state ?? null);
  const row = $derived(store.session(id));
  const EMPTY_SENDS: never[] = [];
  const pendingSends = $derived(store.pendingSends[id] ?? EMPTY_SENDS);
  /** A sender named by a session id or a live agent id in an agent-message header reads as its catalog name. */
  const nameOf = $derived(catalogNames(store.sessions));
  const feed = $derived(thread ? chatFeed(thread, pendingSends, nameOf) : []);
  /**
   * The feed draws a window of its items: the newest FIRST_ITEMS first, MORE_ITEMS earlier ones each time the owner scrolls near the top,
   * and MORE_ITEMS later ones near the bottom of a window that stopped above the newest (feed-window.ts). A window keeps at most MAX_ITEMS:
   * drawing on one end takes items off the other, out of view. On 10-22 the AI harness feed with 484 rows drawn after a 12 s scroll up
   * dropped 23 to 36% of the frames that scrolled down, against 0 to 20% with 107 to 215 rows.
   */
  const MORE_ITEMS = 30;
  const MAX_ITEMS = 90;
  let top = $state<WindowItem | null>(null);
  let bottom = $state<WindowItem | null>(null);
  const items = $derived(feed.map(item => ({ key: item.id, at: item.at })));
  const floor = $derived(settledFrom(feed.map(item => item.kind), thread?.older !== undefined));
  const start = $derived(Math.max(floor, windowStart(items, top, FIRST_ITEMS)));
  const end = $derived(Math.max(start, windowEnd(items, bottom)));
  const hasEarlier = $derived(start > 0 || thread?.older !== undefined);
  let growing = false;
  /**
   * Draws the earlier items, after loading the older page when every loaded item already shows; true when anything was added. It loads on
   * while a page only adds to the top fold, because at the top edge no scroll event comes to ask again. holdPlace keeps the view in place.
   */
  async function earlier(): Promise<boolean> {
    if (growing || jumping !== null || !scroller || !hasEarlier) return false;
    growing = true;
    let grew = false;
    try {
      top = items[start] ?? null;
      while (start === floor && thread?.older !== undefined && await store.loadOlder(id)) await tick();
      const next = earlierTop(items, start, MORE_ITEMS, floor);
      if (next !== null) {
        top = next;
        grew = true;
        if (end - start > MAX_ITEMS) bottom = items[start + MAX_ITEMS - 1] ?? null;
      }
      await tick();
      place?.hold();
    } finally { growing = false; }
    if (grew && scroller && !pinned && nearTop(scroller)) void earlier();
    return grew;
  }
  /** Draws the later items of a window that stopped above the newest. */
  async function later(): Promise<void> {
    if (growing || jumping !== null || bottom === null) return;
    growing = true;
    try {
      bottom = laterBottom(items, end, MORE_ITEMS);
      if (end - start > MAX_ITEMS) top = items[end - MAX_ITEMS] ?? null;
      await tick();
      place?.hold();
    } finally { growing = false; }
  }
  /** Shows the loaded items from `index` on (with a few above it for context), for a link or a quote that points outside the drawn ones. */
  function showFrom(index: number): void {
    if (index < 0 || (index >= start && index < end)) return;
    const from = Math.max(0, index - 3);
    top = items[from] ?? null;
    bottom = laterBottom(items, from, MAX_ITEMS);
  }
  /** Three dots while the chat answers the owner and no reply text has started. A turn a job or a check-in started shows nothing until a tell_owner lands. */
  const busy = $derived(thread ? isThreadBusy({ ...thread, children: [] }) : false);
  const typing = $derived(busy && thread !== null && turnStarter(thread.messages) === "owner" && !feed.some(item => item.kind === "agent" && item.streaming));
  const acceptsImages = $derived(thread?.info.model?.input.includes("image") ?? true);
  const minute = $derived(Math.floor(clock.now / 60_000) * 60_000);
  const tick5 = $derived(Math.floor(clock.now / 5000) * 5000);

  $effect(() => {
    if (!thread) return;
    const settled = settledPending(thread.messages, pendingSends);
    if (settled.size) untrack(() => store.settleSends(settled));
  });

  /** Jobs: this chat's subagents (from the daemon) and the sessions it started with `rlm.create_session` (from its own tool results). */
  const EMPTY_CHILDREN: ChildAgent[] = [];
  const children = $derived(thread?.children ?? EMPTY_CHILDREN);
  const started = $derived(createdSessions(thread?.messages ?? []));
  const NO_USAGE: ChildUsage[] = [];
  const usage = $derived(childUsage.value(id) ?? NO_USAGE);
  /** Pushed on the thread feed (store.side), and asked again when a job starts or ends while the chat shows; the cache keeps one request in flight. */
  const childCount = $derived(thread ? children.length : null);
  let countSeen: number | null = null;
  $effect(() => {
    const count = childCount;
    if (count === null) return;
    // The children come as their own event after the snapshot, so the first count that is not 0 is where the chat stands, not a change.
    untrack(() => void (countSeen === null ? childUsage.ensure(id) : count !== countSeen ? childUsage.load(id, true) : undefined));
    if (count || countSeen !== null) countSeen = count;
  });
  const jobs = $derived(jobViews(children, started, usage, sessionId => store.session(sessionId)));
  const runningCount = $derived(jobs.filter(isActiveJob).length);
  const pulses = $derived(new Map<string, ChildPulse>((row?.pulse?.subagents ?? []).map(pulse => [pulse.rlmChildId, pulse])));
  const hasOpenStep = (items: readonly PlanItem[]): boolean => items.some(item => item.status === "todo" || item.status === "doing" || item.status === "blocked" || hasOpenStep(item.children));
  /** The server's check-in tick runs every 15 minutes by default while a job runs or a plan step is open (todo, doing, blocked), and steers the chat only on a change. */
  const checkIn = $derived.by(() => {
    // Before the snapshot nothing says the chat is idle, so the row's check-in shows; the board panel reloads duties when this text changes.
    if (!thread || runningCount || hasOpenStep(board?.plan ?? [])) return checkInStatus(row?.checkIn, clock.now);
    return { text: "Check-in paused, nothing open", on: false };
  });

  /** The phone switch: the feed or the board. A wide window shows the board in the side panel. */
  let view = $state<"chat" | "board">("chat");
  /** A todo or duty chip clicked in a message shows the board, where BoardPanel scrolls to its row. */
  $effect(() => { if (store.boardFocus?.chat === id) untrack(() => { view = "board"; }); });
  const board = $derived(thread?.board ?? null);
  const asks = $derived(openAgentTodos(board));
  const cwd = $derived(thread?.info.cwd ?? row?.cwd ?? "");
  /** The board's ids and titles, the duties and the jobs' names, for the mention chips in every bubble; a new board rev, duty or job re-renders the feed once. */
  const mentions = $derived(mentionIndex(id, board, jobNames(row, thread, sessionId => store.session(sessionId)), dutiesFeed.mentions(id)));
  const planView = $derived(store.planView?.chat === id ? store.planView : null);
  const closePlan = () => { if (store.planView?.chat === id) store.planView = null; };
  const applyBoard = (next: ChatBoard, ops: BoardOp[]) => store.boardOps(id, next, ops);

  /** The job drawer follows `store.jobDrawer` for this chat, so the sidebar, the feed, the plan and the Jobs list all open the same drawer. */
  const drawerName = $derived(store.jobDrawer?.chat === id ? store.jobDrawer.job : null);
  const drawerJob = $derived(drawerName === null ? null : findJob(jobs, drawerName) ?? null);
  const drawerTitle = $derived(drawerJob?.name ?? (drawerName === null ? "" : jobName(drawerName)));
  const drawerReports = $derived(drawerName === null || !thread ? [] : reportsFor(chatLines(thread.messages, nameOf), drawerTitle));
  /** The job's brief: from the ipython calls in the snapshot, else from the whole cell of a truncated call (newest first), fetched once per call. */
  let drawerBrief = $state<string | null>(null);
  const fullCode = new Map<string, Promise<string>>();
  const codeOf = (toolCallId: string): Promise<string> => {
    let pending = fullCode.get(toolCallId);
    if (!pending) {
      pending = api.toolOutput(id, toolCallId).then(result => { const code = (result.arguments as { code?: unknown } | null)?.code; return typeof code === "string" ? code : ""; });
      fullCode.set(toolCallId, pending);
    }
    return pending;
  };
  $effect(() => {
    const name = drawerTitle;
    const messages = thread?.messages;
    if (!name || !messages) { drawerBrief = null; return; }
    const found = briefFor(messages, name);
    drawerBrief = found;
    if (found !== null) return;
    let cancelled = false;
    void (async () => {
      for (const call of spawnCalls(messages).filter(call => call.truncated).reverse()) {
        const brief = briefFromCode(await codeOf(call.toolCallId).catch(() => ""), name);
        if (cancelled) return;
        if (brief !== null) { drawerBrief = brief; return; }
      }
    })();
    return () => { cancelled = true; };
  });
  const openJob = (name: string) => store.openJob(id, name);
  const EMPTY_AGENTS: ChatAgent[] = [];
  /** An Agents card row: a subagent opens in the job drawer, any other thread opens as itself. */
  const openAgent = (agent: ChatAgent) => { if (agent.link === "subagent") openJob(agent.job); else if (agent.sessionId) store.select(agent.sessionId); };
  const closeJob = () => { if (store.jobDrawer?.chat === id) store.jobDrawer = null; };
  /** A plan step's owner: a subagent of this chat opens in the drawer; a session (one this chat started, or any thread by id or name) opens as its thread. */
  function openStep(owner: string): void {
    const job = findJob(jobs, owner);
    if (job?.kind === "session") { store.select(job.sessionId); return; }
    const session = job ? null : store.session(owner) ?? store.sessions.find(row => row.name === owner);
    if (session) store.select(session.id);
    else openJob(owner);
  }
  /** The job a step's owner previews, by the name its reports carry; a step owned by a thread (this chat, another chat) has no report card. */
  const previewJob = (owner: string): string | undefined => findJob(jobs, owner)?.name;

  let lightbox = $state<{ images: { src: string; alt: string }[]; index: number } | null>(null);
  function viewImage(item: Extract<ChatItem, { kind: "user" }>, index: number): void {
    lightbox = { images: item.images.map((image, position) => ({ src: image.url, alt: `Image ${position + 1}` })), index };
  }
  /** Inside a reply: a reply image opens large, an artifact link opens the reader (a web link is a plain anchor and opens its tab). */
  function onProseClick(event: MouseEvent): void {
    const click = proseClick(event);
    if (click?.kind === "image") lightbox = { images: [{ src: click.src, alt: click.alt }], index: 0 };
    else if (click?.kind === "artifact") { const target = parseArtifactTarget(click.target); if (target) store.openArtifact(target, id); }
    else if (click?.kind === "mention") store.openMention(id, click.id);
    else if (click?.kind === "job") store.openArtifact({ kind: "job", name: click.name }, id);
  }
  /** A fold opens in the reader as a list: who wrote, when, and the whole text. */
  const readFold = (fold: Fold) => { store.reader = { kind: "fold", thread: id, at: fold.at }; };

  /** The side panel's left edge: a drag sets its width, a double click puts it back, Left and Right nudge it. The choice holds across chats. */
  let sideNode: HTMLElement | undefined = $state();
  let resizing = $state(false);
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || !sideNode) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const right = sideNode.getBoundingClientRect().right;
    handle.setPointerCapture(event.pointerId);
    resizing = true;
    const move = (next: PointerEvent) => ui.setBoardWidth(right - next.clientX, false);
    const end = () => {
      resizing = false;
      ui.setBoardWidth(ui.boardWidth, true);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resizeKey(event: KeyboardEvent): void {
    const next = event.key === "ArrowLeft" ? ui.boardWidth + 16 : event.key === "ArrowRight" ? ui.boardWidth - 16
      : event.key === "Home" ? boardMax() : event.key === "End" ? BOARD_MIN : null;
    if (next === null) return;
    event.preventDefault();
    ui.setBoardWidth(next, true);
  }

  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  function loadCatalog(): void {
    if (catalog) return;
    catalogError = null;
    api.models(id).then(result => { catalog = result; }, error => { catalogError = error instanceof Error ? error.message : String(error); });
  }
  const modelLabel = $derived((thread?.info.model?.name ?? row?.model ?? "Model") + ((thread?.info.thinkingLevel ?? row?.thinkingLevel) ? " · " + (thread?.info.thinkingLevel ?? row?.thinkingLevel) : ""));
  const chooseModel = (model: ModelInfo) => store.run(api.setModel(id, model.provider, model.id));
  const chooseEffort = (level: ThinkingLevel | null) => { if (level) void store.run(api.setThinking(id, level)); };
  /** The archive button asks first; the confirm names the chat and what happens to its turn and its Slack channel. */
  let archiveAsk = $state(false);
  const archiveWords = $derived(archivePrompt({ name: row?.name ?? "", busy, slackChannel: store.slack?.chats[id]?.name ?? null }));
  function archive(): void { archiveAsk = false; void labels.archive([id]); }

  let scroller: HTMLElement | undefined = $state();
  let column: HTMLElement | undefined = $state();
  let pinned = $state(true);
  let jumpDismissed = $state(false);
  $effect(() => { if (pinned) jumpDismissed = false; });
  /** Where the feed stands; it keeps the view at the bottom or on the rows the owner reads (feed-window.ts). */
  let place: FeedPlace | null = null;
  $effect(() => {
    if (!scroller || !column) return;
    const held = holdPlace(scroller, column, () => bottom === null, next => { pinned = next; });
    place = held;
    return () => { held.stop(); place = null; };
  });
  function onScroll(): void {
    if (!scroller) return;
    place?.scrolled();
    if (!pinned && nearTop(scroller)) void earlier();
    else if (bottom !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < scroller.clientHeight) void later();
  }
  /** Back to the newest items at the bottom, for Jump to latest and a send. */
  function toLatest(): void {
    top = null;
    bottom = null;
    place?.pin();
  }
  const hasState = $derived(thread !== null);
  $effect(() => {
    if (!hasState) return;
    untrack(() => requestAnimationFrame(() => { if (performance.getEntriesByName("thread-switch:" + id, "mark").length) performance.measure("thread-paint:" + id, "thread-switch:" + id); }));
  });
  $effect(() => {
    void feed;
    // A feed shorter than the view has no scroll to load earlier items with, so it draws them until it fills the view.
    void tick().then(() => { if (scroller && scroller.scrollHeight <= scroller.clientHeight) void earlier(); });
  });

  /** Leaving the chat (another thread, or the tab going hidden) marks it read, so its row's dot clears. */
  $effect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") store.markRead(id); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { document.removeEventListener("visibilitychange", onHidden); store.markRead(id); };
  });

  /**
   * A link to a message in this chat (`#<id>@<ms>`): scroll to it and flash it once the feed shows; a link to nothing says so. The window
   * does not grow on its own meanwhile, so it cannot move off the message, a page already on its way is waited for, and the pages that load
   * do not start the walk again.
   */
  let jumping: typeof store.jump = null;
  $effect(() => {
    const target = store.jump;
    const node = scroller;
    if (!target || target.id !== id || !feed.length || !node || jumping === target) return;
    untrack(() => {
      place?.unpin();
      jumping = target;
      void (async () => {
        try {
          // A link older than the drawable items loads older pages until the first item a window may draw is at or before it.
          while (store.jump === target && (feed[floor]?.at ?? 0) > target.at && thread?.older !== undefined) {
            if (!await store.loadOlder(id)) {
              if (!entry?.olderLoading) break;
              await new Promise(requestAnimationFrame);
            }
          }
          showFrom(feed.findLastIndex(item => item.at <= target.at));
          await tick();
          if (store.jump !== target) return;
          if (!revealMessage(node, target.at)) store.toast("That link points at a message this chat does not have.", "info");
          store.jump = null;
        } finally { if (jumping === target) jumping = null; }
      })();
    });
  });
  async function copyLink(at: number): Promise<void> {
    store.toast(await copyPermalink(id, at) ? "Link copied" : "Could not copy the link", "info");
  }
  /** Reply on a bubble: the composer gets a quote of that message (owner, 10-09: a `> ...` paste above his answer, as a button). */
  function reply(text: string): void { store.replyQuote = { chat: id, text: replyExcerpt(text) }; }
  /**
   * A chat reply that answers an older owner message (`reply_to`) quotes it; the quote scrolls to that message. The owner's message gets
   * "See reply", which scrolls to the first answer and on each further click to the next one.
   */
  const shownReply = new Map<string, number>();
  async function goToLine(line: string): Promise<void> {
    if (!scroller) return;
    place?.unpin();
    showFrom(items.findIndex(item => item.key === line));
    await tick();
    if (scroller && !revealLine(scroller, line)) store.toast("That message is not in this chat any more.", "info");
  }
  function seeReply(item: Extract<ChatItem, { kind: "user" }>): void {
    const replies = item.replies ?? [];
    if (!replies.length) return;
    const next = (shownReply.get(item.id) ?? -1) + 1;
    shownReply.set(item.id, next % replies.length);
    void goToLine(replies[next % replies.length]!);
  }
  /** The bubble menu a long press opens on touch, where the hover buttons never show: Reply and Copy link. */
  let pressed = $state<{ anchor: HTMLElement; at: number; text: string } | null>(null);
  const press = (at: number, text: string) => (anchor: HTMLElement) => { pressed = { anchor, at, text }; };
  const closeMenu = () => { pressed = null; };

  const send = (text: string, images: ImageInput[]) => { toLatest(); return store.sendChat(id, text, images); };
</script>

{#snippet setup()}
  <AccountChip threadId={id} model={thread?.info.model ? thread.info.model.id + " " + thread.info.model.name : rowModelId(row?.model)} />
  {#if thread}
    <ModelPicker label={modelLabel} {catalog} error={catalogError} current={thread.info.model} onopen={loadCatalog} onchoose={model => void chooseModel(model)}
      effort={thread.info.thinkingLevel} levels={thread.info.availableThinkingLevels} oneffort={chooseEffort} />
  {/if}
{/snippet}

{#snippet feedView()}
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="column" class:fill={hasEarlier} bind:this={column}>
      {#if hasEarlier}<div class="older muted" aria-live="polite">{entry?.olderLoading ? "Loading earlier messages" : ""}</div>{/if}
      <ChatLines {id} {feed} {start} {end} {minute} {cwd} {mentions} typing={typing && end === feed.length} {reply} {copyLink} {goToLine} {viewImage} {seeReply} {press} {onProseClick} {readFold} />
      {#if !feed.length && !typing}<div class="empty muted">Say what this chat is about. Jobs run in the background while you keep typing.</div>{/if}
    </div>
  </div>
  <div class="foot">
    {#if !pinned && !jumpDismissed}
      <div class="jump fade-in">
        <button type="button" class="jump-go" onclick={toLatest}><Icon name="arrowDown" size={14} /> Jump to latest</button>
        <button type="button" class="jump-close" aria-label="Hide Jump to latest" onclick={() => { jumpDismissed = true; }}><Icon name="x" size={12} /></button>
      </div>
    {/if}
    <div class="column">
      <ChatComposer draftKey={id} {send} {acceptsImages} focusOnMount={!narrow} />
      {#if narrow}<div class="setup-row">{@render setup()}</div>{/if}
    </div>
  </div>
{/snippet}

{#snippet chatPane()}
  {#if !thread && entry?.error}
    <div class="center">
      <div class="card error-card">
        <div class="error-title"><Icon name="alert" size={16} /> Could not open this chat</div>
        <div class="muted">{entry.error}</div>
        <button class="button" onclick={() => store.open(id)}>Retry</button>
      </div>
    </div>
  {:else if !thread}
    <div class="center muted"><Spinner size="normal" /> Opening</div>
  {:else}
    {@render feedView()}
  {/if}
{/snippet}

{#snippet boardView()}
  <BoardPanel {id} {board} agents={row?.agents ?? EMPTY_AGENTS} now={minute} {checkIn} settled={thread !== null && thread.board !== undefined} onjob={openStep} onagent={openAgent} {previewJob} apply={applyBoard} />
{/snippet}

<div class="chat">
  <header class="head">
    {#if !store.sidebarOpen || narrow}
      <button type="button" class="icon-button" aria-label="Show sidebar" use:tooltip={"Show sidebar ⌘B"} onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
    <ThreadTitle {id} />
    <div class="controls">
      <CheckInControl {id} />
      {#if !narrow}{@render setup()}{/if}
      {#if row && !row.archived}<SlackSync {id} {narrow} />{/if}
      <button type="button" class="icon-button" aria-label="Prompt" aria-haspopup="dialog" use:tooltip={"The prompt the model gets"} onclick={() => { store.prompt = id; }}><Icon name="layers" size={16} /></button>
      {#if row && !row.archived}
        <button type="button" class="icon-button" aria-label="Archive chat" aria-haspopup="dialog" use:tooltip={busy ? "Stop and archive" : "Archive"} onclick={() => { archiveAsk = true; }}><Icon name="archive" size={16} /></button>
      {/if}
      {#if !narrow}
        <button type="button" class="icon-button panel-toggle" class:on={ui.boardOpen} aria-pressed={ui.boardOpen} aria-label="{ui.boardOpen ? 'Hide' : 'Show'} the board panel" use:tooltip={ui.boardOpen ? "Hide board" : "Show board"} onclick={() => ui.setBoardOpen(!ui.boardOpen)}>
          <Icon name="plan" size={16} />{#if asks && !ui.boardOpen}<span class="dot corner" role="img" aria-label="{asks} waiting on you"></span>{/if}
        </button>
      {/if}
    </div>
  </header>

  {#if thread?.connection === "reconnecting" || (entry?.loading && thread)}
    <div class="thin-bar">{entry?.loading ? "Refreshing" : "Reconnecting"}</div>
  {/if}
  {#if thread && entry?.error}
    <div class="error-bar"><span>{entry.error}</span><button class="button small" onclick={() => store.open(id)}>Retry</button></div>
  {/if}

  <div class="body">
    <div class="main">
      {#if narrow}
        <div class="switch" role="tablist" aria-label="Chat view">
          <button type="button" role="tab" aria-selected={view === "chat"} class:on={view === "chat"} onclick={() => { view = "chat"; }}>Chat</button>
          <button type="button" role="tab" aria-selected={view === "board"} class:on={view === "board"} onclick={() => { view = "board"; }}>Board{#if asks}<span class="dot" role="img" aria-label="{asks} waiting on you"></span>{/if}</button>
        </div>
        {#if view === "chat"}{@render chatPane()}
        {:else}<div class="pane">{@render boardView()}</div>{/if}
      {:else}
        {@render chatPane()}
      {/if}
    </div>
    {#if !narrow && ui.boardOpen}
      <aside class="side" class:resizing aria-label="Board" bind:this={sideNode} style:width="{ui.boardWidth}px">
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="resize" class:resizing role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the board panel"
          aria-valuemin={BOARD_MIN} aria-valuemax={boardMax()} aria-valuenow={ui.boardWidth} use:tooltip={"Drag to resize, double-click to reset"}
          onpointerdown={startResize} ondblclick={() => ui.setBoardWidth(BOARD_DEFAULT, true)} onkeydown={resizeKey}><span class="grip"><Icon name="grip" size={14} /></span></div>
        <div class="pane">{@render boardView()}</div>
      </aside>
    {/if}
    {#if drawerName !== null}
      {#await lazy.JobDrawer() then { default: JobDrawer }}<JobDrawer chatId={id} name={drawerTitle} job={drawerJob} reports={drawerReports} brief={drawerBrief} {pulses} now={tick5} onclose={closeJob} />{/await}
    {/if}
    {#if planView}
      {#await lazy.PlanView() then { default: PlanView }}<PlanView chat={id} {board} agents={row?.agents ?? EMPTY_AGENTS} focus={planView.focus} {narrow} onjob={openStep} onagent={openAgent} {previewJob} onclose={closePlan} />{/await}
    {/if}
  </div>
  {#if lightbox}
    <Lightbox images={lightbox.images} index={lightbox.index} onclose={() => { lightbox = null; }} />
  {/if}
  {#if archiveAsk}
    <ConfirmDialog title={archiveWords.title} body={archiveWords.body} label={archiveWords.label} danger onconfirm={archive} onclose={() => { archiveAsk = false; }} />
  {/if}
  {#if pressed}
    {@const { anchor, at, text } = pressed}
    <Floating {anchor} width={180} role="menu" label="Message" onclose={closeMenu}>
      <button type="button" class="menu-item" role="menuitem" data-autofocus onclick={() => { closeMenu(); reply(text); }}><Icon name="reply" size={14} />Reply</button>
      <button type="button" class="menu-item" role="menuitem" onclick={() => { closeMenu(); void copyLink(at); }}><Icon name="link" size={14} />Copy link</button>
    </Floating>
  {/if}
</div>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; --column: 720px; }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 40px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .head .icon-button { width: 28px; height: 28px; }
  /* The controls shrink too (the account's email ellipsizes), so the title keeps its room on a crowded header. */
  .controls { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
  .controls > :global(:not(.account)) { flex: none; }
  .controls > :global(.account) { overflow: hidden; }
  .controls :global(.bar-button), .controls :global(.account), .setup-row :global(.bar-button), .setup-row :global(.account) { height: 28px; font-size: 12.5px; }
  .panel-toggle { position: relative; }
  .panel-toggle.on { color: var(--accent-bold); background: var(--accent-soft); }
  .setup-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; padding: 0 2px; }
  .thin-bar { padding: 3px 12px; font-size: 12px; text-align: center; color: var(--accent); background: var(--accent-soft); }
  .error-bar { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 12px; font-size: 13px; color: var(--danger); background: var(--danger-soft); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; max-width: 420px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .body { position: relative; display: flex; flex: 1; min-height: 0; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  /* No fill, no overlay: the panel sits on the page background next to the chat, and the chat always keeps at least 360 px. */
  .side { position: relative; flex: none; display: flex; flex-direction: column; min-height: 0; max-width: calc(100% - 360px); border-left: 1px solid var(--border); background: var(--bg); }
  .resize { position: absolute; top: 0; bottom: 0; left: -5px; z-index: 20; width: 10px; cursor: col-resize; touch-action: none; }
  .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 4px; border-radius: 2px; background: transparent; transition: background-color 0.12s; }
  .grip { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: inline-flex; padding: 6px 0; border-radius: 999px; color: var(--text-faint); background: var(--bg-elevated); border: 1px solid var(--border); opacity: 0.7; transition: opacity 0.12s, color 0.12s; }
  .resize:hover::after, .resize:focus-visible::after, .resize.resizing::after { background: color-mix(in srgb, var(--accent) 55%, transparent); }
  .resize:hover .grip, .resize:focus-visible .grip, .resize.resizing .grip { opacity: 1; color: var(--accent-bold); border-color: var(--accent); }
  .resize:focus-visible { outline: none; }
  :global(body:has(.side .resize.resizing)) { cursor: col-resize; user-select: none; }
  .pane { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .switch { display: flex; flex: none; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .switch > button { position: relative; display: inline-flex; align-items: center; gap: 5px; flex: 1; height: 28px; padding: 0 10px; border-radius: var(--radius-small); justify-content: center; font-size: 12.5px; font-weight: 500; color: var(--text-muted); transition: background-color 0.12s, color 0.12s; }
  .switch > button:hover:not(.on) { background: var(--bg-hover); color: var(--text); }
  .switch > button.on { background: var(--accent-soft); color: var(--accent-bold); font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .dot.corner { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; }
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none; }
  /* The column is its rows' offset parent, so holdPlace (feed-window.ts) reads a row's place in the feed from its offsetTop. */
  .column { position: relative; width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 6px; }
  /* A window of a longer feed sits at the bottom of the view, next to the box, so the earlier items that load above it never move the newest ones. */
  .column.fill { min-height: 100%; justify-content: flex-end; }
  .empty { padding: 48px 0; text-align: center; }
  /* A fixed height, so "Loading earlier messages" coming and going moves no row. */
  .older { align-self: center; height: 24px; padding: 4px 12px; font-size: 12.5px; line-height: 16px; }
  .jump { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%); z-index: 5; display: inline-flex; align-items: center; border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 13px; }
  .jump-go { display: inline-flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; border-radius: 999px 0 0 999px; }
  .jump-close { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 3px; border-radius: 50%; color: var(--text-faint); }
  .jump-go:hover, .jump-close:hover { color: var(--text); }
  .jump-close:hover { background: var(--bg-hover); }
  .foot { position: relative; flex: none; background: var(--bg); }
  .foot .column { padding: 4px 12px 10px; gap: 6px; }
  @container app (max-width: 899px) {
    .column { padding: 10px 10px 12px; }
    .foot .column { padding: 4px 8px 8px; }
  }
</style>
