<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime } from "./format.ts";
  import { nextRun } from "./organize.ts";
  import { createdSessions } from "./children.ts";
  import { briefFor, briefFromCode, findJob, isActiveJob, jobName, jobViews, reportsFor, spawnCalls } from "./jobs.ts";
  import { boardActionText, isBoardAction, openAgentTodos } from "./board.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { chatFeed, settledPending, textRuns, type ChatItem } from "../shared/chat-feed.ts";
  import type { BoardOp, ChatBoard, ChildAgent, ChildPulse, ChildUsage, ImageInput, ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import ChatComposer from "./ChatComposer.svelte";
  import BoardPanel from "./BoardPanel.svelte";
  import JobList from "./JobList.svelte";
  import JobDrawer from "./JobDrawer.svelte";
  import ThreadTitle from "./ThreadTitle.svelte";
  import AccountChip from "./AccountChip.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import Icon from "./Icon.svelte";
  import Lightbox from "./ui/Lightbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { labels } from "./labels.ts";

  /**
   * The chat view of one thread whose row has `chat`: a DM-style feed and a box that always sends at once, with the board and the jobs
   * in a side panel on a wide window and behind a Chat / Board / Jobs switch on a phone. A job opens in a drawer over the panel.
   */
  let { id, narrow }: { id: string; narrow: boolean } = $props();

  const entry = $derived(store.thread(id));
  const thread = $derived(entry?.state ?? null);
  const row = $derived(store.session(id));
  const EMPTY_SENDS: never[] = [];
  const pendingSends = $derived(store.pendingSends[id] ?? EMPTY_SENDS);
  const feed = $derived(thread ? chatFeed(thread, pendingSends) : []);
  /** Three dots while the chat itself takes a turn and no reply text has started. Running jobs alone do not count: they show in the Jobs panel. */
  const busy = $derived(thread ? isThreadBusy({ ...thread, children: [] }) : false);
  const typing = $derived(busy && !feed.some(item => item.kind === "agent" && item.streaming));
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
  const checkIn = $derived.by(() => {
    const schedule = row?.schedule;
    if (!schedule) return { text: "Check-in off", on: false };
    if (schedule.status === "paused") return { text: "Check-in paused, nothing running", on: false };
    return { text: "Check-in " + (nextRun(schedule.nextRunAt, minute) || schedule.expression), on: true };
  });

  /** The side panel (wide) and the phone switch share the Board and Jobs views; the phone adds Chat. */
  type View = "chat" | "board" | "jobs";
  let view = $state<View>("chat");
  let side = $state<Exclude<View, "chat">>("board");
  const board = $derived(thread?.board ?? null);
  const asks = $derived(openAgentTodos(board));
  const cwd = $derived(thread?.info.cwd ?? row?.cwd ?? "");
  const applyBoard = (next: ChatBoard, ops: BoardOp[]) => store.boardOps(id, next, ops);

  /** The job drawer follows `store.jobDrawer` for this chat, so the sidebar, the feed, the plan and the Jobs list all open the same drawer. */
  const drawerName = $derived(store.jobDrawer?.chat === id ? store.jobDrawer.job : null);
  const drawerJob = $derived(drawerName === null ? null : findJob(jobs, drawerName) ?? null);
  const drawerTitle = $derived(drawerJob?.name ?? (drawerName === null ? "" : jobName(drawerName)));
  const drawerReports = $derived(drawerName === null ? [] : reportsFor(feed, drawerTitle));
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
  const closeJob = () => { if (store.jobDrawer?.chat === id) store.jobDrawer = null; };

  let lightbox = $state<{ images: { src: string; alt: string }[]; index: number } | null>(null);
  function viewImage(item: Extract<ChatItem, { kind: "user" }>, index: number): void {
    lightbox = { images: item.images.map((image, position) => ({ src: image.url, alt: `Image ${position + 1}` })), index };
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
      const step = () => { scrollToBottom(); if (++frames < 8) requestAnimationFrame(step); };
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

  const send = (text: string, images: ImageInput[]) => { pinned = true; return store.sendChat(id, text, images); };
</script>

{#snippet setup()}
  {#if thread}
    <AccountChip threadId={id} model={thread.info.model ? thread.info.model.id + " " + thread.info.model.name : row?.model} />
    <ModelPicker label={modelLabel} {catalog} error={catalogError} current={thread.info.model} onopen={loadCatalog} onchoose={model => void chooseModel(model)}
      effort={thread.info.thinkingLevel} levels={thread.info.availableThinkingLevels} oneffort={chooseEffort} />
  {/if}
{/snippet}

{#snippet boardTab(on: boolean, pick: () => void)}
  <button type="button" role="tab" aria-selected={on} class:on onclick={pick}>Board{#if asks}<span class="dot" role="img" aria-label="{asks} waiting on you"></span>{/if}</button>
{/snippet}
{#snippet jobsTab(on: boolean, pick: () => void)}
  <button type="button" role="tab" aria-selected={on} class:on onclick={pick}>Jobs{#if runningCount}<span class="count">{runningCount}</span>{/if}</button>
{/snippet}

{#snippet feedView()}
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="column" bind:this={column}>
      {#each feed as item, index (item.id)}
        {#if stampBefore(item, index)}<div class="stamp">{stamp(item.at)}</div>{/if}
        {#if item.kind === "user" && !item.images.length && isBoardAction(item.text)}
          <div class="owner-action" class:pending={item.pending}><Icon name="check" size={12} /><span>{boardActionText(item.text)}</span></div>
        {:else if item.kind === "user"}
          <div class="line user">
            <div class="bubble mine" class:pending={item.pending}>
              {#if item.images.length}
                <div class="images">
                  {#each item.images as image, position (image.url + position)}
                    <button type="button" class="view" aria-label="View image {position + 1}" onclick={() => viewImage(item, position)}><img src={image.url} alt="Attached" loading="lazy" /></button>
                  {/each}
                </div>
              {/if}
              {#if item.text}<div class="text">{item.text}</div>{/if}
            </div>
          </div>
        {:else if item.kind === "agent"}
          <div class="line agent">
            <div class="bubble theirs">
              <div class="text">{#each textRuns(item.text) as run, position (position)}{#if run.kind === "link"}<a href={run.href} target="_blank" rel="noopener noreferrer">{run.href}</a>{:else}{run.text}{/if}{/each}{#if item.streaming}<span class="caret"></span>{/if}</div>
            </div>
          </div>
        {:else if item.kind === "job"}
          <div class="line report">
            <button type="button" class="report-line" title="Open job {jobName(item.from)}" onclick={() => openJob(item.from)}>
              <span class="report-mark"><Icon name="chevronRight" size={12} /></span>
              <span class="report-text"><span class="report-from">from {jobName(item.from)}:</span> {item.title}</span>
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
  <BoardPanel {board} {cwd} onjob={openJob} apply={applyBoard} />
{/snippet}
{#snippet jobsView()}
  <JobList {jobs} {pulses} now={tick5} {checkIn} onopen={job => openJob(job.key)} />
{/snippet}

<div class="chat">
  <header class="head">
    {#if !store.sidebarOpen || narrow}
      <button type="button" class="icon-button" aria-label="Show sidebar" use:tooltip={"Show sidebar ⌘B"} onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
    <ThreadTitle {id} />
    <div class="controls">
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
            {@render boardTab(view === "board", () => { view = "board"; })}
            {@render jobsTab(view === "jobs", () => { view = "jobs"; })}
          </div>
          {#if view === "chat"}{@render feedView()}
          {:else if view === "board"}<div class="pane">{@render boardView()}</div>
          {:else}<div class="pane">{@render jobsView()}</div>{/if}
        {:else}
          {@render feedView()}
        {/if}
      </div>
      {#if !narrow && ui.boardOpen}
        <aside class="side" aria-label="Board and jobs">
          <div class="switch side-tabs" role="tablist" aria-label="Side panel">
            {@render boardTab(side === "board", () => { side = "board"; })}
            {@render jobsTab(side === "jobs", () => { side = "jobs"; })}
          </div>
          <div class="pane">{#if side === "board"}{@render boardView()}{:else}{@render jobsView()}{/if}</div>
        </aside>
      {/if}
      {#if drawerName !== null}
        <JobDrawer name={drawerTitle} job={drawerJob} reports={drawerReports} brief={drawerBrief} {pulses} now={tick5} {cwd} onclose={closeJob} />
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
  .side { flex: none; display: flex; flex-direction: column; width: 320px; min-height: 0; border-left: 1px solid var(--border); background: var(--bg-sunken); }
  .pane { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .switch { display: flex; flex: none; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .side-tabs { background: var(--bg-sunken); }
  .switch > button { position: relative; display: inline-flex; align-items: center; gap: 5px; flex: 1; height: 28px; padding: 0 10px; border-radius: var(--radius-small); justify-content: center; font-size: 12.5px; font-weight: 500; color: var(--text-muted); transition: background-color 0.12s, color 0.12s; }
  .side-tabs > button { flex: 0 1 auto; }
  .switch > button:hover:not(.on) { background: var(--bg-hover); color: var(--text); }
  .switch > button.on { background: var(--accent-soft); color: var(--accent-bold); font-weight: 600; }
  .count { font-size: 11px; font-weight: 500; color: var(--accent-bold); font-variant-numeric: tabular-nums; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .dot.corner { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; }
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .column { width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 6px; }
  .empty { padding: 48px 0; text-align: center; }
  .stamp { align-self: center; margin: 10px 0 4px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .line { display: flex; }
  .line.user { justify-content: flex-end; }
  .line.agent { justify-content: flex-start; }
  .bubble { max-width: min(82%, 560px); padding: 8px 14px; border-radius: 18px; font-size: 15.5px; line-height: 1.45; }
  .bubble.mine { background: var(--accent-fill); color: var(--accent-text); border-bottom-right-radius: 5px; transition: opacity 0.2s; }
  .bubble.mine.pending { opacity: 0.55; }
  .bubble.theirs { background: var(--user-bubble); border-bottom-left-radius: 5px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
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
  .line.report { flex-direction: column; align-items: stretch; margin: 2px 0; }
  .report-line { display: flex; align-items: flex-start; gap: 6px; width: 100%; padding: 4px 6px; border-radius: var(--radius-small); text-align: left; font-size: 13px; line-height: 1.45; color: var(--text-muted); }
  .report-line:hover { background: var(--bg-hover); color: var(--text); }
  .report-mark { display: inline-flex; flex: none; margin-top: 3px; }
  .report-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report-from { font-weight: 600; }
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
    .bubble { max-width: 86%; }
  }
</style>
