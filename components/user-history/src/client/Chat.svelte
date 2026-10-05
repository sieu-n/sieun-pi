<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime, duration } from "./format.ts";
  import { nextRun, pulseOf, statusOf, STATUS_LABEL } from "./organize.ts";
  import { childDetail, childName, createdSessions, isActiveChild, type ChildDetail, type CreatedSession } from "./children.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { readPulse } from "../shared/pulse.ts";
  import { chatFeed, settledPending, textRuns, type ChatItem } from "../shared/chat-feed.ts";
  import type { ChildAgent, ChildUsage, ImageInput, ModelCatalog, ModelInfo, SessionRow, ThinkingLevel } from "../shared/types.ts";
  import ChatComposer from "./ChatComposer.svelte";
  import ThreadTitle from "./ThreadTitle.svelte";
  import AccountChip from "./AccountChip.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import StatusMark from "./StatusMark.svelte";
  import Icon from "./Icon.svelte";
  import Lightbox from "./ui/Lightbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { labels } from "./labels.ts";

  /** The chat view of one thread whose row has `chat`: a DM-style feed, the jobs it runs on the left, and a box that always sends at once. */
  let { id, narrow }: { id: string; narrow: boolean } = $props();

  const entry = $derived(store.thread(id));
  const thread = $derived(entry?.state ?? null);
  const row = $derived(store.session(id));
  const EMPTY_SENDS: never[] = [];
  const pendingSends = $derived(store.pendingSends[id] ?? EMPTY_SENDS);
  const feed = $derived(thread ? chatFeed(thread, pendingSends) : []);
  const busy = $derived(thread ? isThreadBusy(thread) : false);
  /** Three dots while the chat works and no reply text has started. */
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

  /**
   * Involved: this chat's subagents (from the daemon) and the sessions it started with `rlm.create_session` (from its own tool results),
   * running first, then the rest in the order they were reported or started.
   */
  type Involved = { kind: "child"; key: string; child: ChildAgent } | { kind: "session"; key: string; created: CreatedSession; row: SessionRow | undefined };
  const EMPTY_CHILDREN: ChildAgent[] = [];
  const children = $derived(thread?.children ?? EMPTY_CHILDREN);
  const started = $derived(createdSessions(thread?.messages ?? []));
  const items = $derived<Involved[]>([
    ...children.map(child => ({ kind: "child", key: "child:" + child.id, child }) as const),
    ...started.map(created => ({ kind: "session", key: "session:" + created.sessionId, created, row: store.session(created.sessionId) }) as const),
  ]);
  const isActive = (item: Involved): boolean => item.kind === "child" ? isActiveChild(item.child) : item.row?.working === true;
  const involved = $derived([...items.filter(isActive), ...items.filter(item => !isActive(item))]);
  const runningCount = $derived(items.filter(isActive).length);
  const pulseById = $derived(new Map((row?.pulse?.subagents ?? []).map(pulse => [pulse.rlmChildId, pulse])));
  const readingOf = (child: ChildAgent) => { const pulse = child.status === "running" ? pulseById.get(child.id) : undefined; return pulse ? readPulse(pulse, tick5) : null; };
  /** Line two of a started session: the catalog's status, then what it is doing or how it failed; "Not listed" when the catalog has no row for it. */
  function sessionDetail(item: Extract<Involved, { kind: "session" }>): ChildDetail {
    const { row } = item;
    if (!row) return { lead: "Not listed", text: "", tone: "quiet" };
    const status = statusOf(row, tick5);
    const pulse = pulseOf(row, tick5);
    if (pulse?.level === "failed") return { lead: "Failed", text: pulse.text, tone: "failed" };
    if (!row.working && row.failure) return { lead: STATUS_LABEL[status], text: row.failure, tone: "failed" };
    const text = pulse && pulse.level !== "live" ? pulse.text : row.status === "running" && row.statusLabel ? row.statusLabel
      : row.working && row.subagentsRunning > 0 ? `${row.subagentsRunning} ${row.subagentsRunning === 1 ? "subagent" : "subagents"} running` : "";
    return { lead: STATUS_LABEL[status], text, tone: status === "stalled" ? "stalled" : "" };
  }
  const sessionName = (item: Extract<Involved, { kind: "session" }>): string => item.row?.name || item.created.name || item.created.sessionId.slice(0, 8);
  /** A child whose session the daemon lists opens as its own thread. */
  let usage = $state<ChildUsage[]>([]);
  $effect(() => {
    void children.length;
    let cancelled = false;
    api.childUsage(id).then(entries => { if (!cancelled) usage = entries; }, () => {});
    return () => { cancelled = true; };
  });
  const sessionOf = (child: ChildAgent): string | null =>
    usage.find(entry => entry.rlmChildId === child.id || (child.sessionName !== undefined && entry.sessionName === child.sessionName))?.sessionId ?? null;
  const checkIn = $derived.by(() => {
    const schedule = row?.schedule;
    if (!schedule) return { text: "Check-in off", on: false };
    if (schedule.status === "paused") return { text: "Check-in paused, nothing running", on: false };
    return { text: "Check-in " + (nextRun(schedule.nextRunAt, minute) || schedule.expression), on: true };
  });
  let involvedOpen = $state(false);

  let open = $state<string | null>(null);
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

{#snippet involvedList()}
  <ul class="jobs" aria-label="Involved">
    {#each involved as item (item.key)}
      {#if item.kind === "child"}
      {@const child = item.child}
      {@const session = sessionOf(child)}
      {@const detail = childDetail(child, readingOf(child))}
      <li>
        <button type="button" class="job {child.status}" disabled={!session} title={[childName(child), detail.lead, detail.text].filter(Boolean).join("\n")}
          aria-label="{childName(child)}, {detail.lead || child.status}{session ? ', open its thread' : ''}" onclick={() => { if (session) store.select(session); }}>
          <span class="job-line">
            <span class="state">
              {#if child.status === "running"}<StatusMark status="working" level={readingOf(child)?.level ?? "live"} />{:else}<span class="mark {child.status}" aria-hidden="true"></span>{/if}
            </span>
            <span class="job-name">{childName(child)}</span>
            {#if child.durationMs !== undefined}<span class="job-time">{duration(child.durationMs)}</span>{/if}
          </span>
          <span class="job-line detail {detail.tone}">
            {#if detail.lead}<span class="lead">{detail.lead}</span>{/if}
            {#if detail.text}<span class="detail-text">{detail.text}</span>{/if}
          </span>
        </button>
      </li>
      {:else}
      {@const name = sessionName(item)}
      {@const detail = sessionDetail(item)}
      <li>
        <button type="button" class="job session" class:running={item.row?.working} disabled={!item.row} title={[name, detail.lead, detail.text].filter(Boolean).join("\n")}
          aria-label="{name}, session, {detail.lead}{item.row ? ', open its thread' : ''}" onclick={() => { if (item.row) store.select(item.row.id); }}>
          <span class="job-line">
            <span class="state">{#if item.row}<StatusMark status={statusOf(item.row, tick5)} level={pulseOf(item.row, tick5)?.level ?? "live"} />{:else}<span class="mark cancelled" aria-hidden="true"></span>{/if}</span>
            <span class="job-name">{name}</span>
            <span class="job-kind">session</span>
          </span>
          <span class="job-line detail {detail.tone}">
            {#if detail.lead}<span class="lead">{detail.lead}</span>{/if}
            {#if detail.text}<span class="detail-text">{detail.text}</span>{/if}
          </span>
        </button>
      </li>
      {/if}
    {/each}
    {#if !involved.length}<li class="none">No jobs yet</li>{/if}
    <li class="check-in" class:on={checkIn.on}><Icon name="bolt" size={12} /><span>{checkIn.text}</span></li>
  </ul>
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
      {#if !narrow}
        <aside class="involved">
          <div class="involved-title">Involved{#if runningCount}<span class="count">{runningCount} running</span>{/if}</div>
          {@render involvedList()}
        </aside>
      {/if}
      <div class="main">
        <div class="scroller" bind:this={scroller} onscroll={onScroll}>
          <div class="column" bind:this={column}>
            {#each feed as item, index (item.id)}
              {#if stampBefore(item, index)}<div class="stamp">{stamp(item.at)}</div>{/if}
              {#if item.kind === "user"}
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
                  <button type="button" class="report-line" aria-expanded={open === item.id} onclick={() => { open = open === item.id ? null : item.id; }}>
                    <span class="report-mark" class:down={open === item.id}><Icon name="chevronRight" size={12} /></span>
                    <span class="report-text"><span class="report-from">from {item.from}:</span> {item.title}</span>
                  </button>
                  {#if open === item.id}
                    <div class="report-body">{#each textRuns(item.body) as run, position (position)}{#if run.kind === "link"}<a href={run.href} target="_blank" rel="noopener noreferrer">{run.href}</a>{:else}{run.text}{/if}{/each}</div>
                  {/if}
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
            {#if narrow}
              <div class="strip" class:open={involvedOpen}>
                <button type="button" class="strip-toggle" aria-expanded={involvedOpen} onclick={() => { involvedOpen = !involvedOpen; }}>
                  <span class="chev" class:open={involvedOpen}><Icon name="chevronDown" size={11} /></span>
                  Involved{#if runningCount}<span class="count">{runningCount} running</span>{/if}
                  {#if !involvedOpen}<span class="strip-check" class:on={checkIn.on}>{checkIn.text}</span>{/if}
                </button>
                {#if involvedOpen}{@render involvedList()}{/if}
              </div>
            {/if}
            <ChatComposer draftKey={id} {send} {acceptsImages} focusOnMount={!narrow} />
            {#if narrow}<div class="setup-row">{@render setup()}</div>{/if}
          </div>
        </div>
      </div>
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
  .setup-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; padding: 0 2px; }
  .thin-bar { padding: 3px 12px; font-size: 12px; text-align: center; color: var(--accent); background: var(--accent-soft); }
  .error-bar { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 12px; font-size: 13px; color: var(--danger); background: var(--danger-soft); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; max-width: 420px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .body { display: flex; flex: 1; min-height: 0; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .involved { flex: none; width: 260px; min-height: 0; overflow-y: auto; padding: 10px 8px; border-right: 1px solid var(--border); background: var(--bg-sunken); }
  .involved-title { display: flex; align-items: baseline; gap: 8px; padding: 2px 8px 6px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .count { font-size: 11px; font-weight: 500; color: var(--accent-bold); font-variant-numeric: tabular-nums; }
  .jobs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .job { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 5px 8px; border-radius: var(--radius-small); text-align: left; font-size: 12.5px; }
  .job:disabled { opacity: 1; cursor: default; }
  .job:hover:not(:disabled) { background: var(--bg-hover); }
  .job-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .state { display: inline-flex; width: 12px; justify-content: center; flex: none; }
  .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .mark.queued { background: transparent; border: 1.5px solid var(--accent); }
  .mark.error { background: var(--danger); }
  .mark.cancelled { background: var(--text-faint); }
  .job-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .job-time { flex: none; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .job-kind { flex: none; font-size: 10.5px; color: var(--text-faint); padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; line-height: 14px; }
  .detail.quiet .lead { color: var(--text-faint); font-weight: 400; }
  .detail { padding-left: 18px; font-size: 11.5px; line-height: 16px; color: var(--text-faint); }
  .lead { flex: none; color: var(--text-muted); font-weight: 500; }
  .running .lead, .queued .lead { color: var(--accent-bold); }
  .error .lead, .error .detail-text, .detail.failed .lead, .detail.failed .detail-text { color: var(--danger); }
  .detail.stalled .lead { color: var(--warning); }
  .detail-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { padding: 4px 8px; font-size: 12.5px; color: var(--text-faint); }
  .check-in { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 5px 8px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-faint); }
  .check-in.on { color: var(--text-muted); }
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
  .report-mark { display: inline-flex; flex: none; margin-top: 3px; transition: transform 0.12s; }
  .report-mark.down { transform: rotate(90deg); }
  .report-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report-line[aria-expanded="true"] .report-text { white-space: normal; }
  .report-from { font-weight: 600; }
  .report-body { margin: 2px 0 6px 24px; padding: 8px 12px; border-left: 2px solid var(--border-strong); font-size: 13.5px; line-height: 1.5; color: var(--text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  .notice { align-self: center; max-width: 90%; padding: 2px 10px; text-align: center; font-size: 12.5px; color: var(--text-faint); overflow-wrap: anywhere; }
  .jump { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%); z-index: 5; display: inline-flex; align-items: center; border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 13px; }
  .jump-go { display: inline-flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; border-radius: 999px 0 0 999px; }
  .jump-close { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 3px; border-radius: 50%; color: var(--text-faint); }
  .jump-go:hover, .jump-close:hover { color: var(--text); }
  .jump-close:hover { background: var(--bg-hover); }
  .foot { position: relative; flex: none; background: var(--bg); }
  .foot .column { padding: 4px 12px 10px; gap: 6px; }
  .strip { border: 1px solid var(--border); border-radius: var(--radius-small); background: var(--bg-sunken); }
  .strip.open { max-height: 40vh; overflow-y: auto; }
  .strip-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); }
  .strip-check { margin-left: auto; font-weight: 400; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .strip-check.on { color: var(--text-muted); }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .strip .jobs { padding: 0 4px 4px; }
  @container app (max-width: 899px) {
    .column { padding: 10px 10px 12px; }
    .foot .column { padding: 4px 8px 8px; }
    .bubble { max-width: 86%; }
  }
</style>
