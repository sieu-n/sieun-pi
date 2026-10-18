<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { buildTurns, liveTurn } from "../shared/turns.ts";
  import type { ModelCatalog, ModelInfo, ThinkingLevel, ThreadMessage } from "../shared/types.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import ContextMeter from "./ContextMeter.svelte";
  import Turn from "./Turn.svelte";
  import Composer from "./Composer.svelte";
  import QueueChips from "./QueueChips.svelte";
  import AccountChip from "./AccountChip.svelte";
  import Popover from "./Popover.svelte";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import SubagentList from "./SubagentList.svelte";
  import ThreadTitle from "./ThreadTitle.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { labels } from "./labels.ts";
  import { clock } from "./clock.svelte.ts";
  import { readPulse } from "../shared/pulse.ts";
  import { parentChatOf } from "./jobs.ts";
  import { revealMessage } from "./permalink.ts";

  let { id, narrow }: { id: string; narrow: boolean } = $props();
  /** A job of a chat (its session is listed under a chat row, or an open chat started it) gets a way back to the chat with its drawer open. */
  const parentChat = $derived(parentChatOf(id, store.sessions, chat => store.thread(chat)?.state?.messages));

  const entry = $derived(store.thread(id));
  const thread = $derived(entry?.state ?? null);
  const hasState = $derived(thread !== null);
  const row = $derived(store.session(id));
  const busy = $derived(thread ? isThreadBusy(thread) : false);
  const saved = $derived(thread?.kind === "saved");
  const EMPTY: ThreadMessage[] = [];
  const messages = $derived(thread?.messages ?? EMPTY);
  const turns = $derived(buildTurns(messages));
  const live = $derived(thread ? liveTurn(turns.at(-1), thread.streaming, thread.tools, messages.length, thread.info.isStreaming) : null);
  const shown = $derived.by(() => {
    if (!live) return turns;
    const last = turns.at(-1);
    return last && last.key === live.key ? [...turns.slice(0, -1), live] : [...turns, live];
  });
  const context = $derived(thread?.info.context ?? null);
  const runningChildren = $derived(thread?.children.filter(child => child.status === "running" || child.status === "queued").length ?? 0);
  const childAlert = $derived.by(() => {
    const levels = (row?.pulse?.subagents ?? []).map(pulse => readPulse(pulse, Math.floor(clock.now / 5000) * 5000).level);
    return levels.includes("failed") ? "failed" : levels.includes("stalled") ? "stalled" : null;
  });
  const agentsLabel = $derived((runningChildren ? `Subagents, ${runningChildren} of ${thread?.children.length ?? 0} running` : "Subagents") +
    (childAlert === "failed" ? ", one is failing" : childAlert === "stalled" ? ", one has no activity" : ""));

  const statusText = $derived.by(() => {
    if (!thread || !busy) return "";
    const parts: string[] = [];
    if (thread.info.sessionAction) parts.push(thread.info.sessionAction.label);
    else if (thread.info.isCompacting) parts.push("Compacting context");
    else if (thread.retry) parts.push(`Retry ${thread.retry.attempt} of ${thread.retry.maxAttempts}${thread.retry.error ? ": " + thread.retry.error : ""}`);
    else if (thread.info.isBashRunning) parts.push("Running a shell command");
    if (thread.info.queuedActions) parts.push(`${thread.info.queuedActions} queued`);
    return parts.join(" · ");
  });

  let agentsOpen = $state(false);
  const MODAL_CHILDREN = 40;
  function archive(): void { void labels.archive([id]); }
  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  function loadCatalog(): void {
    if (catalog) return;
    catalogError = null;
    api.models(id).then(result => { catalog = result; }, error => { catalogError = error instanceof Error ? error.message : String(error); });
  }
  const modelLabel = $derived((thread?.info.model?.name ?? row?.model ?? "Model") + ((thread?.info.thinkingLevel ?? row?.thinkingLevel) ? " · " + (thread?.info.thinkingLevel ?? row?.thinkingLevel) : ""));
  async function chooseModel(model: ModelInfo): Promise<void> {
    await store.run(api.setModel(id, model.provider, model.id));
  }
  async function chooseEffort(level: ThinkingLevel | null): Promise<void> {
    if (level) await store.run(api.setThinking(id, level));
  }

  let scroller: HTMLElement | undefined = $state();
  let column: HTMLElement | undefined = $state();
  let pinned = $state(true);
  /** Closed by the user until the view is pinned to the bottom again. */
  let jumpDismissed = $state(false);
  $effect(() => { if (pinned) jumpDismissed = false; });
  function scrollToBottom(): void { if (scroller) scroller.scrollTop = scroller.scrollHeight; }
  function onScroll(): void {
    if (!scroller) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }
  $effect(() => {
    if (!hasState) return;
    untrack(() => {
      requestAnimationFrame(() => { if (performance.getEntriesByName("thread-open:" + id, "mark").length) performance.measure("thread-paint:" + id, "thread-open:" + id); });
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
    void shown;
    if (untrack(() => pinned)) void tick().then(scrollToBottom);
  });

  /** A link to a message in this thread (`#<id>@<ms>`): scroll to it and flash it; a link to nothing says so. */
  $effect(() => {
    const target = store.jump;
    const node = scroller;
    if (!target || target.id !== id || !messages.length || !node) return;
    untrack(() => {
      pinned = false;
      void tick().then(() => {
        if (store.jump !== target) return;
        if (!revealMessage(node, target.at)) store.toast("That link points at a message this thread does not have.", "info");
        store.jump = null;
      });
    });
  });

  /** An open thread keeps its Needs response place while you read it; leaving it (another thread, or the tab going hidden) marks it read. */
  $effect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") store.markRead(id); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { document.removeEventListener("visibilitychange", onHidden); store.markRead(id); };
  });

  const send = (text: string, images: Parameters<typeof store.send>[2], mode: Parameters<typeof store.send>[3]) => store.send(id, text, images, mode);
  const stop = () => { void store.run(api.abort(id)); };
  let loadingOlder = $state(false);
  async function showOlder(): Promise<void> {
    loadingOlder = true;
    try { await store.run(api.older(id)); } finally { loadingOlder = false; }
  }
</script>

<div class="thread">
  <header class="head">
    {#if !store.sidebarOpen || narrow}
      <button type="button" class="icon-button" aria-label="Show sidebar" use:tooltip={"Show sidebar ⌘B"} onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
    {#if parentChat}
      <button type="button" class="crumb" title="Back to {parentChat.chat.name}" onclick={() => store.openJob(parentChat.chat.id, parentChat.open)}><Icon name="chevronLeft" size={14} /><span class="crumb-name">{parentChat.chat.name}</span></button>
    {/if}
    <ThreadTitle {id} />
    <div class="controls">
      {#if thread?.children.length}
        {#if thread.children.length > MODAL_CHILDREN}
          <button type="button" class="bar-button" class:active-agents={runningChildren > 0} aria-label={agentsLabel} use:tooltip={agentsLabel} onclick={() => { agentsOpen = true; }}>
            {#if runningChildren}<span class="spinner tiny" aria-hidden="true"></span>{:else}<Icon name="users" size={14} />{/if}<span class="tabular">{runningChildren ? `${runningChildren} of ${thread.children.length}` : thread.children.length}</span>{#if childAlert}<span class="child-alert {childAlert}" aria-hidden="true"></span>{/if}
          </button>
          {#if agentsOpen}
            <Modal title="Subagents" width="640px" onclose={() => { agentsOpen = false; }}>
              <div class="modal-list"><SubagentList threadId={id} children={thread.children} pulses={row?.pulse?.subagents ?? []} height={Math.round(window.innerHeight * 0.6)} /></div>
            </Modal>
          {/if}
        {:else}
          <Popover open={agentsOpen} onclose={() => { agentsOpen = false; }} align="end" width={460} maxHeight={560} label="Subagents">
            {#snippet trigger()}
              <button type="button" class="bar-button" class:active-agents={runningChildren > 0} aria-label={agentsLabel} use:tooltip={agentsLabel} aria-haspopup="dialog" aria-expanded={agentsOpen} onclick={() => { agentsOpen = !agentsOpen; }}>
                {#if runningChildren}<span class="spinner tiny" aria-hidden="true"></span>{:else}<Icon name="users" size={14} />{/if}<span class="tabular">{runningChildren ? `${runningChildren} of ${thread.children.length}` : thread.children.length}</span>{#if childAlert}<span class="child-alert {childAlert}" aria-hidden="true"></span>{/if}
              </button>
            {/snippet}
            <SubagentList threadId={id} children={thread.children} pulses={row?.pulse?.subagents ?? []} />
          </Popover>
        {/if}
      {/if}
      <button type="button" class="icon-button" aria-label="Prompt" aria-haspopup="dialog" use:tooltip={"The prompt the model gets"} onclick={() => { store.prompt = id; }}><Icon name="layers" size={16} /></button>
      {#if row && !row.archived}
        <button type="button" class="icon-button" aria-label="Archive thread" use:tooltip={busy ? "Stop and archive" : "Archive"} onclick={archive}><Icon name="archive" size={16} /></button>
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
        <div class="error-title"><Icon name="alert" size={16} /> Could not open this thread</div>
        <div class="muted">{entry.error}</div>
        <button class="button" onclick={() => store.open(id)}>Retry</button>
      </div>
    </div>
  {:else if !thread}
    <div class="center muted"><span class="spinner"></span> Opening thread</div>
  {:else}
    <div class="scroller" bind:this={scroller} onscroll={onScroll}>
      <div class="column" bind:this={column}>
        {#if thread?.older}<button type="button" class="older" disabled={loadingOlder} onclick={() => void showOlder()}>{loadingOlder ? "Loading earlier messages…" : "Show earlier messages"}</button>{/if}
        {#each shown as turn, index (turn.key)}
          <Turn {turn} threadId={id} latest={index === shown.length - 1} />
        {/each}
        {#if !shown.length}<div class="empty muted">No messages yet.</div>{/if}
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
        <QueueChips threadId={id} queue={thread.queue} />
        <Composer draftKey={id} threadId={id} {busy} placeholder={saved ? "Reply to resume this thread" : "Ask for follow-up changes"}
          acceptsImages={thread.info.model?.input.includes("image") ?? true} focusOnMount={!narrow} {send} {stop}>
          {#snippet left()}
            <AccountChip threadId={id} model={thread.info.model ? thread.info.model.id + " " + thread.info.model.name : row?.model} />
            {#if context && thread}
              <ContextMeter threadId={id} {context} usage={thread.info.usage} {messages} live={!saved} />
            {/if}
          {/snippet}
          {#snippet right()}
            <ModelPicker label={modelLabel} disabled={!thread}
              {catalog} error={catalogError} current={thread?.info.model ?? null} onopen={loadCatalog} onchoose={model => void chooseModel(model)}
              effort={thread?.info.thinkingLevel ?? null} levels={thread?.info.availableThinkingLevels ?? []} oneffort={level => void chooseEffort(level)} />
          {/snippet}
        </Composer>
        <div class="status-line">
          {#if statusText}<span class="status-text">{statusText}</span>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .thread { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 40px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .head .icon-button { width: 28px; height: 28px; }
  .crumb { display: inline-flex; align-items: center; gap: 2px; flex: none; max-width: 200px; height: 28px; padding: 0 8px 0 4px; border-radius: var(--radius-small); font-size: 12.5px; color: var(--text-muted); }
  .crumb:hover { background: var(--bg-hover); color: var(--text); }
  .crumb-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .active-agents { color: var(--accent-bold); }
  .head .icon-button.on { color: var(--accent-bold); background: var(--accent-soft); }
  .child-alert { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .child-alert.stalled { background: var(--warning); }
  .child-alert.failed { background: var(--danger); }
  .modal-list { padding: 12px 14px; }
  .column :global(.turn.flash) { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent-soft); } to { background: transparent; } }
  .column :global(.linked) { animation: linked 2s ease-out; border-radius: var(--radius); }
  @keyframes linked { from { background: var(--accent-soft); box-shadow: 0 0 0 8px var(--accent-soft); } to { background: transparent; box-shadow: none; } }
  .controls { display: flex; align-items: center; gap: 6px; flex: none; }
  .thin-bar { padding: 3px 12px; font-size: 12px; text-align: center; color: var(--accent); background: var(--accent-soft); }
  .error-bar { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 12px; font-size: 13px; color: var(--danger); background: var(--danger-soft); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; max-width: 420px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .column { width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 20px 24px; }
  .empty { padding: 48px 0; text-align: center; }
  .older { display: block; margin: 8px auto; padding: 4px 12px; border-radius: 999px; font-size: 12.5px; color: var(--text-muted); }
  .jump { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%); z-index: 5; display: inline-flex; align-items: center; border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 13px; }
  .jump-go { display: inline-flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; border-radius: 999px 0 0 999px; }
  .jump-close { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 3px; border-radius: 50%; color: var(--text-faint); }
  .jump-go:hover, .jump-close:hover { color: var(--text); }
  .jump-close:hover { background: var(--bg-hover); }
  .foot { position: relative; flex: none; background: var(--bg); }
  .foot .column { padding: 4px 20px 8px; }
  .status-line { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 4px 6px 0; font-size: 12px; color: var(--text-faint); }
  .status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @container app (max-width: 899px) {
    .column { padding: 8px 12px 16px; }
    .foot .column { padding: 4px 10px 8px; }
  }
</style>
