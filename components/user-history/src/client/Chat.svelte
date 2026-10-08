<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui, BOARD_DEFAULT, boardMax, BOARD_MIN } from "./ui.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime } from "./format.ts";
  import { createdSessions } from "../shared/created-sessions.ts";
  import { briefFor, briefFromCode, findJob, isActiveJob, jobName, jobNames, jobViews, reportsFor, spawnCalls, updatesJob } from "./jobs.ts";
  import { boardActionText, isBoardAction, mentionIndex, openAgentTodos } from "./board.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { chatFeed, chatLines, foldReply, settledPending, turnStarter, updatesLabel, type ChatItem } from "../shared/chat-feed.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";
  import { bubbleBlocks, renderInline, renderMarkdown } from "./markdown.ts";
  import { diagrams } from "./diagrams.ts";
  import { brokenImage, proseClick } from "./prose.ts";
  import type { BoardOp, ChatAgent, ChatBoard, ChildAgent, ChildPulse, ChildUsage, ImageInput, ModelCatalog, ModelInfo, PlanItem, ThinkingLevel } from "../shared/types.ts";
  import ChatComposer from "./ChatComposer.svelte";
  import BoardPanel from "./BoardPanel.svelte";
  import PlanView from "./PlanView.svelte";
  import JobDrawer from "./JobDrawer.svelte";
  import ThreadTitle from "./ThreadTitle.svelte";
  import AccountChip from "./AccountChip.svelte";
  import CheckInControl, { checkInStatus } from "./CheckInControl.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import Icon from "./Icon.svelte";
  import Lightbox from "./ui/Lightbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { longpress } from "./ui/longpress.ts";
  import { labels } from "./labels.ts";
  import { copyPermalink, revealMessage } from "./permalink.ts";

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
  /** A sender named by a raw session id in an agent-message header reads as its catalog name. */
  const nameOf = (sessionId: string): string | undefined => store.session(sessionId)?.name;
  const feed = $derived(thread ? chatFeed(thread, pendingSends, nameOf) : []);
  /** Long owner-turn replies the owner opened with "More" (`foldReply`), as `<chat id>:<item id>`. */
  const unfolded = new SvelteSet<string>();
  /** Three dots while the chat answers the owner and no reply text has started. A turn a job or a check-in started shows nothing until a tell_owner lands. */
  const busy = $derived(thread ? isThreadBusy({ ...thread, children: [] }) : false);
  const typing = $derived(busy && thread !== null && turnStarter(thread.messages) === "owner" && !feed.some(item => item.kind === "agent" && item.streaming));
  const acceptsImages = $derived(thread?.info.model?.input.includes("image") ?? true);
  const minute = $derived(Math.floor(clock.now / 60_000) * 60_000);
  const tick5 = $derived(Math.floor(clock.now / 5000) * 5000);
  const EXPANDED_MINUTES = 15;
  const stampBefore = (item: ChatItem, index: number): boolean => index === 0 || item.at - (feed[index - 1]?.at ?? item.at) > EXPANDED_MINUTES * 60_000;
  function stamp(at: number): string {
    const date = new Date(at);
    const today = new Date(minute);
    return date.toDateString() === today.toDateString() ? clockTime(at) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  $effect(() => {
    if (!thread) return;
    const settled = settledPending(thread.messages, pendingSends);
    if (settled.size) untrack(() => store.settleSends(id, settled));
  });

  /** Jobs: this chat's subagents (from the daemon) and the sessions it started with `rlm.create_session` (from its own tool results). */
  const EMPTY_CHILDREN: ChildAgent[] = [];
  const children = $derived(thread?.children ?? EMPTY_CHILDREN);
  const started = $derived(createdSessions(thread?.messages ?? []));
  let usage = $state<ChildUsage[]>([]);
  $effect(() => {
    void children.length;
    let cancelled = false;
    api.childUsage(id).then(entries => { if (!cancelled) usage = entries; }, () => {});
    return () => { cancelled = true; };
  });
  const jobs = $derived(jobViews(children, started, usage, sessionId => store.session(sessionId)));
  const runningCount = $derived(jobs.filter(isActiveJob).length);
  const pulses = $derived(new Map<string, ChildPulse>((row?.pulse?.subagents ?? []).map(pulse => [pulse.rlmChildId, pulse])));
  const hasOpenStep = (items: readonly PlanItem[]): boolean => items.some(item => item.status === "todo" || item.status === "doing" || item.status === "blocked" || hasOpenStep(item.children));
  /** The server's check-in tick runs every 15 minutes by default while a job runs or a plan step is open (todo, doing, blocked), and steers the chat only on a change. */
  const checkIn = $derived.by(() => {
    if (runningCount || hasOpenStep(board?.plan ?? [])) return checkInStatus(row?.checkIn, clock.now);
    return { text: "Check-in paused, nothing open", on: false };
  });

  /** The phone switch: the feed or the board. A wide window shows the board in the side panel. */
  let view = $state<"chat" | "board">("chat");
  const board = $derived(thread?.board ?? null);
  const asks = $derived(openAgentTodos(board));
  const cwd = $derived(thread?.info.cwd ?? row?.cwd ?? "");
  /** The board's ids and titles and the jobs' names, for the mention chips in every bubble; a new board rev or job re-renders the feed once. */
  const mentions = $derived(mentionIndex(id, board, jobNames(row, thread, sessionId => store.session(sessionId))));
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
  /** The owner's name for the plan view: the job's name, the session's name, or the first 8 characters of a bare id. */
  const ownerName = (owner: string): string => findJob(jobs, owner)?.name ?? store.session(owner)?.name ?? (/^[0-9a-f]{8}-/.test(owner) ? owner.slice(0, 8) : jobName(owner));
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
    else if (click?.kind === "mention") store.openPlan(id, click.id);
    else if (click?.kind === "job") store.openArtifact({ kind: "job", name: click.name }, id);
  }
  /** A folded run of updates opens in the reader as a list: who wrote, when, and the whole text. */
  const readUpdates = (item: Extract<ChatItem, { kind: "updates" }>) => { store.reader = { kind: "updates", thread: id, at: item.at }; };

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
  function archive(): void { void labels.archive([id]); }

  let scroller: HTMLElement | undefined = $state();
  let column: HTMLElement | undefined = $state();
  let pinned = $state(true);
  let jumpDismissed = $state(false);
  $effect(() => { if (pinned) jumpDismissed = false; });
  function scrollToBottom(): void { if (scroller) scroller.scrollTop = scroller.scrollHeight; }
  function onScroll(): void {
    if (!scroller) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }
  const hasState = $derived(thread !== null);
  $effect(() => {
    if (!hasState) return;
    untrack(() => {
      let frames = 0;
      const step = () => { if (pinned) scrollToBottom(); if (++frames < 8) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  });
  $effect(() => {
    const node = column;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (pinned) scrollToBottom(); });
    observer.observe(node);
    return () => observer.disconnect();
  });
  $effect(() => {
    void feed;
    void typing;
    if (untrack(() => pinned)) void tick().then(scrollToBottom);
  });

  /** Leaving the chat (another thread, or the tab going hidden) marks it read, so its row's dot clears. */
  $effect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") store.markRead(id); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { document.removeEventListener("visibilitychange", onHidden); store.markRead(id); };
  });

  /** A link to a message in this chat (`#<id>@<ms>`): scroll to it and flash it once the feed shows; a link to nothing says so. */
  $effect(() => {
    const target = store.jump;
    const node = scroller;
    if (!target || target.id !== id || !feed.length || !node) return;
    untrack(() => {
      pinned = false;
      void tick().then(() => {
        if (store.jump !== target) return;
        if (!revealMessage(node, target.at)) store.toast("That link points at a message this chat does not have.", "info");
        store.jump = null;
      });
    });
  });
  async function copyLink(at: number): Promise<void> {
    store.toast(await copyPermalink(id, at) ? "Link copied" : "Could not copy the link", "info");
  }

  const send = (text: string, images: ImageInput[]) => { pinned = true; return store.sendChat(id, text, images); };
</script>

{#snippet linkButton(at: number)}
  <button type="button" class="icon-button small link-button" aria-label="Copy link to this message" use:tooltip={"Copy link"} onclick={() => void copyLink(at)}><Icon name="link" size={13} /></button>
{/snippet}

{#snippet setup()}
  {#if thread}
    <AccountChip threadId={id} model={thread.info.model ? thread.info.model.id + " " + thread.info.model.name : row?.model} />
    <ModelPicker label={modelLabel} {catalog} error={catalogError} current={thread.info.model} onopen={loadCatalog} onchoose={model => void chooseModel(model)}
      effort={thread.info.thinkingLevel} levels={thread.info.availableThinkingLevels} oneffort={chooseEffort} />
  {/if}
{/snippet}

{#snippet feedView()}
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="column" bind:this={column}>
      {#each feed as item, index (item.id)}
        {#if stampBefore(item, index)}<div class="stamp">{stamp(item.at)}</div>{/if}
        {#if item.kind === "user" && !item.images.length && isBoardAction(item.text)}
          <div class="owner-action" class:pending={item.pending}><Icon name="check" size={12} /><span>{boardActionText(item.text)}</span></div>
        {:else if item.kind === "user"}
          <div class="line user" data-at={item.at}>
            {#if !item.pending}{@render linkButton(item.at)}{/if}
            <div class="bubble mine" class:pending={item.pending} use:longpress={() => void copyLink(item.at)}>
              {#if item.images.length}
                <div class="images">
                  {#each item.images as image, position (image.url + position)}
                    <button type="button" class="view" aria-label="View image {position + 1}" onclick={() => viewImage(item, position)}><img src={image.url} alt="Attached" loading="lazy" /></button>
                  {/each}
                </div>
              {/if}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              {#if item.text}<div class="text said" onclick={onProseClick}>{@html renderInline(item.text, mentions)}</div>{/if}
            </div>
          </div>
        {:else if item.kind === "agent"}
          {@const fold = item.streaming || item.told || unfolded.has(`${id}:${item.id}`) ? null : foldReply(item.text)}
          {@const blocks = bubbleBlocks(fold?.folded ? fold.shown : item.text)}
          <div class="line agent" data-at={item.at}>
            <div class="blocks">
              {#each blocks as block, position (position)}
                {@const html = renderMarkdown(block.text, cwd, mentions)}
                {@const streaming = item.streaming ?? false}
                {#if block.kind === "prose"}
                  <div class="bubble theirs" use:longpress={() => void copyLink(item.at)}>
                    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                    <div class="prose bubble-prose" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html, live: streaming }}>{@html html}{#if streaming && position === blocks.length - 1}<span class="caret"></span>{/if}</div>
                    {#if fold?.folded && position === blocks.length - 1}<button type="button" class="more" aria-label="Show the whole reply" onclick={() => unfolded.add(`${id}:${item.id}`)}>More</button>{/if}
                  </div>
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                  <div class="card prose {block.kind}" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html, live: streaming && block.kind === "diagram" && !block.closed }} use:longpress={() => void copyLink(item.at)}>{@html html}</div>
                {/if}
              {/each}
              {#if !blocks.length && item.streaming}<div class="bubble theirs"><span class="caret"></span></div>{/if}
            </div>
            {#if !item.streaming}{@render linkButton(item.at)}{/if}
          </div>
        {:else if item.kind === "updates"}
          {@const label = updatesLabel(item)}
          <div class="line updates" data-at={item.at}>
            <button type="button" class="updates-line" title="Read these updates" data-preview-chat={id} data-preview-job={updatesJob(item)} onclick={() => readUpdates(item)}>
              <span class="updates-count">{label.count}</span>{#if label.names}<span class="dot-sep"></span><span class="updates-names">{label.names}</span>{/if}
              <span class="updates-mark"><Icon name="chevronRight" size={12} /></span>
            </button>
          </div>
        {:else}
          <div class="notice">{item.text}</div>
        {/if}
      {/each}
      {#if typing}
        <div class="line agent"><div class="bubble theirs typing" role="status" aria-label="Typing"><span></span><span></span><span></span></div></div>
      {/if}
      {#if !feed.length && !typing}<div class="empty muted">Say what this chat is about. Jobs run in the background while you keep typing.</div>{/if}
    </div>
  </div>
  <div class="foot">
    {#if !pinned && !jumpDismissed}
      <div class="jump fade-in">
        <button type="button" class="jump-go" onclick={() => { pinned = true; scrollToBottom(); }}><Icon name="arrowDown" size={14} /> Jump to latest</button>
        <button type="button" class="jump-close" aria-label="Hide Jump to latest" onclick={() => { jumpDismissed = true; }}><Icon name="x" size={12} /></button>
      </div>
    {/if}
    <div class="column">
      <ChatComposer draftKey={id} {send} {acceptsImages} focusOnMount={!narrow} />
      {#if narrow}<div class="setup-row">{@render setup()}</div>{/if}
    </div>
  </div>
{/snippet}

{#snippet boardView()}
  <BoardPanel {id} {board} agents={row?.agents ?? EMPTY_AGENTS} now={minute} {checkIn} onjob={openStep} onagent={openAgent} {previewJob} apply={applyBoard} />
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
      {#if row && !row.archived}
        <button type="button" class="icon-button" aria-label="Archive chat" use:tooltip={busy ? "Stop and archive" : "Archive"} onclick={archive}><Icon name="archive" size={16} /></button>
      {/if}
      {#if !narrow}
        <button type="button" class="icon-button panel-toggle" class:on={ui.boardOpen} aria-pressed={ui.boardOpen} aria-label="{ui.boardOpen ? 'Hide' : 'Show'} the board panel" use:tooltip={ui.boardOpen ? "Hide board" : "Show board"} onclick={() => ui.setBoardOpen(!ui.boardOpen)}>
          <Icon name="note" size={16} />{#if asks && !ui.boardOpen}<span class="dot corner" role="img" aria-label="{asks} waiting on you"></span>{/if}
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

  {#if !thread && entry?.error}
    <div class="center">
      <div class="card error-card">
        <div class="error-title"><Icon name="alert" size={16} /> Could not open this chat</div>
        <div class="muted">{entry.error}</div>
        <button class="button" onclick={() => store.open(id)}>Retry</button>
      </div>
    </div>
  {:else if !thread}
    <div class="center muted"><span class="spinner"></span> Opening</div>
  {:else}
    <div class="body">
      <div class="main">
        {#if narrow}
          <div class="switch" role="tablist" aria-label="Chat view">
            <button type="button" role="tab" aria-selected={view === "chat"} class:on={view === "chat"} onclick={() => { view = "chat"; }}>Chat</button>
            <button type="button" role="tab" aria-selected={view === "board"} class:on={view === "board"} onclick={() => { view = "board"; }}>Board{#if asks}<span class="dot" role="img" aria-label="{asks} waiting on you"></span>{/if}</button>
          </div>
          {#if view === "chat"}{@render feedView()}
          {:else}<div class="pane">{@render boardView()}</div>{/if}
        {:else}
          {@render feedView()}
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
        <JobDrawer chatId={id} name={drawerTitle} job={drawerJob} reports={drawerReports} brief={drawerBrief} {pulses} now={tick5} onclose={closeJob} />
      {/if}
      {#if planView}
        <PlanView chat={id} {board} focus={planView.focus} {narrow} onjob={openStep} {ownerName} {previewJob} onclose={closePlan} />
      {/if}
    </div>
  {/if}
  {#if lightbox}
    <Lightbox images={lightbox.images} index={lightbox.index} onclose={() => { lightbox = null; }} />
  {/if}
</div>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; --column: 720px; }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 40px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .head .icon-button { width: 28px; height: 28px; }
  .controls { display: flex; align-items: center; gap: 6px; flex: none; }
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
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .column { width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 6px; }
  .empty { padding: 48px 0; text-align: center; }
  .stamp { align-self: center; margin: 10px 0 4px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .line { display: flex; align-items: flex-end; gap: 4px; border-radius: 20px; }
  .line.user { justify-content: flex-end; }
  .line.agent { justify-content: flex-start; }
  .link-button { flex: none; margin-bottom: 4px; color: var(--text-faint); opacity: 0; transition: opacity 0.15s; }
  .line:hover .link-button, .link-button:focus-visible { opacity: 1; }
  .line:global(.linked) { animation: linked 2s ease-out; }
  @keyframes linked { from { background: var(--accent-soft); box-shadow: 0 0 0 6px var(--accent-soft); } to { background: transparent; box-shadow: none; } }
  .bubble { max-width: min(82%, 560px); min-width: 0; padding: 8px 14px; border-radius: 18px; font-size: 15.5px; line-height: 1.45; }
  .bubble.mine { background: var(--accent-fill); color: var(--accent-text); border-bottom-right-radius: 5px; transition: opacity 0.2s; }
  .bubble.mine.pending { opacity: 0.55; }
  .bubble.theirs { background: var(--user-bubble); border-bottom-left-radius: 5px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .said :global(a) { color: inherit; text-decoration: underline; text-underline-offset: 0.15em; }
  .said :global(code) { font-family: var(--mono); font-size: 0.88em; padding: 0.05em 0.3em; border-radius: 4px; background: color-mix(in srgb, currentColor 16%, transparent); }
  .said :global(.artifact-link) { font: inherit; color: inherit; text-decoration: underline; padding: 0; }
  /* In the owner's accent bubble the pill takes the bubble text color; the dot keeps the item's color with a thin ring so it reads on the fill. */
  .said :global(.mention-chip) { border-color: color-mix(in srgb, currentColor 55%, transparent); background: color-mix(in srgb, currentColor 16%, transparent); }
  .said :global(.mention-chip .dot) { box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 70%, transparent); }
  .blocks { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; flex: 1; min-width: 0; }
  .blocks > .bubble { max-width: min(82%, 560px); }
  /* Bubble typography: paragraphs and lists sit tight, headings read as bold lines, blocks scroll sideways inside the bubble. */
  .bubble-prose { line-height: 1.45; }
  .more { margin-top: 4px; padding: 0; border: 0; background: none; color: var(--accent-bold); font: inherit; font-size: 12.5px; cursor: pointer; }
  .more:hover { text-decoration: underline; }
  .bubble-prose :global(p), .bubble-prose :global(ul), .bubble-prose :global(ol), .bubble-prose :global(blockquote), .bubble-prose :global(.table-wrap), .bubble-prose :global(.code-block) { margin: 0 0 0.55em; }
  .bubble-prose :global(h1), .bubble-prose :global(h2), .bubble-prose :global(h3), .bubble-prose :global(h4) { font-size: 1em; margin: 0.7em 0 0.25em; }
  .bubble-prose :global(li + li) { margin-top: 0.15em; }
  .bubble-prose :global(li > ul), .bubble-prose :global(li > ol) { margin-top: 0.15em; }
  .bubble-prose :global(.code-block), .bubble-prose :global(.table-wrap) { max-width: 100%; background: var(--bg-elevated); }
  .bubble-prose :global(pre) { padding: 0.7em 0.9em; }
  .bubble-prose :global(.reply-image) { display: inline-block; vertical-align: middle; max-height: 180px; margin: 0.2em 0; }
  .bubble-prose :global(.artifact-link) { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); text-underline-offset: 0.18em; font: inherit; padding: 0; }
  .bubble-prose :global(.artifact-link:hover), .bubble-prose :global(a:hover) { text-decoration-color: currentColor; }
  /* A standalone image or diagram: a wide card under the bubble, up to the feed width. */
  .card { align-self: stretch; max-width: 100%; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); overflow: hidden; }
  .card :global(p) { margin: 0; }
  .card.image :global(.reply-image) { display: block; max-width: 100%; max-height: 560px; margin: 0; border: 0; border-radius: 0; }
  .card.image :global(.inert-image) { display: block; padding: 10px 14px; }
  .card.diagram :global(.code-block) { margin: 0; border: 0; border-radius: 0; background: var(--bg-elevated); }
  .owner-action { display: flex; align-items: center; justify-content: flex-end; gap: 5px; padding: 1px 6px; font-size: 12.5px; color: var(--text-faint); overflow-wrap: anywhere; }
  .owner-action.pending { opacity: 0.55; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
  .view { display: block; cursor: zoom-in; border-radius: 10px; }
  .images img { max-width: 220px; max-height: 220px; border-radius: 10px; display: block; }
  .typing { display: inline-flex; align-items: center; gap: 4px; padding: 12px 14px; }
  .typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); animation: typing 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing { 0%, 60%, 100% { opacity: 0.35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  /* A folded run of updates: one muted line, centered like a notice, that opens the reader. */
  .line.updates { justify-content: center; margin: 2px 0; border-radius: 999px; }
  .updates-line { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; padding: 3px 8px 3px 10px; border-radius: 999px; font-size: 12.5px; line-height: 1.4; color: var(--text-faint); transition: background-color 0.12s, color 0.12s; }
  .updates-line:hover { background: var(--bg-hover); color: var(--text-muted); }
  .updates-count { flex: none; font-weight: 500; }
  .updates-names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .updates-mark { display: inline-flex; flex: none; opacity: 0.7; }
  .dot-sep { flex: none; width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.6; }
  .notice { align-self: center; max-width: 90%; padding: 2px 10px; text-align: center; font-size: 12.5px; color: var(--text-faint); overflow-wrap: anywhere; }
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
    .bubble, .blocks > .bubble { max-width: 86%; }
  }
</style>
