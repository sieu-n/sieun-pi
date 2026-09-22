<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { buildTurns, liveTurn } from "../shared/turns.ts";
  import type { ModelCatalog, ModelInfo, ThreadMessage } from "../shared/types.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import { duration, shortPath } from "./format.ts";
  import Turn from "./Turn.svelte";
  import Composer from "./Composer.svelte";
  import QueueChips from "./QueueChips.svelte";
  import AccountChip from "./AccountChip.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";

  let { id, narrow }: { id: string; narrow: boolean } = $props();

  const entry = $derived(store.thread(id));
  const thread = $derived(entry?.state ?? null);
  const hasState = $derived(thread !== null);
  const row = $derived(store.session(id));
  const title = $derived(thread?.info.name ?? row?.name ?? "Untitled");
  const cwd = $derived(thread?.info.cwd ?? row?.cwd ?? "");
  const busy = $derived(thread ? isThreadBusy(thread) : false);
  const saved = $derived(thread?.kind === "saved");
  const EMPTY: ThreadMessage[] = [];
  const messages = $derived(thread?.messages ?? EMPTY);
  const turns = $derived(buildTurns(messages));
  const live = $derived(thread ? liveTurn(turns.at(-1), thread.streaming, thread.tools, messages.length) : null);
  const shown = $derived.by(() => {
    if (!live) return turns;
    const last = turns.at(-1);
    return last && last.key === live.key ? [...turns.slice(0, -1), live] : [...turns, live];
  });
  const context = $derived(thread?.info.context ?? null);
  const contextPercent = $derived(context ? Math.max(0, Math.min(100, Math.round(context.percent))) : 0);
  const RING = 2 * Math.PI * 8;
  const runningChildren = $derived(thread?.children.filter(child => child.status === "running" || child.status === "queued").length ?? 0);

  let now = $state(Date.now());
  $effect(() => {
    if (!busy) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  const statusText = $derived.by(() => {
    if (!thread || !busy) return "";
    const parts: string[] = [];
    if (thread.info.sessionAction) parts.push(thread.info.sessionAction.label);
    else if (thread.info.isCompacting) parts.push("Compacting context");
    else if (thread.retry) parts.push(`Retry ${thread.retry.attempt} of ${thread.retry.maxAttempts}${thread.retry.error ? ": " + thread.retry.error : ""}`);
    else if (thread.info.isBashRunning) parts.push("Running a shell command");
    else if (runningChildren) parts.push(runningChildren === 1 ? "1 agent working" : `${runningChildren} agents working`);
    else parts.push("Working");
    if (thread.info.queuedActions) parts.push(`${thread.info.queuedActions} queued`);
    if (thread.runStartedAt) parts.push(duration(now - thread.runStartedAt));
    return parts.join(" · ");
  });

  type PopoverName = "model" | "effort" | "agents" | "more";
  let popover = $state<PopoverName | null>(null);
  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  function openPopover(name: PopoverName): void {
    popover = popover === name ? null : name;
    if (popover === "model" && !catalog) {
      catalogError = null;
      api.models(id).then(result => { catalog = result; }, error => { catalogError = error instanceof Error ? error.message : String(error); });
    }
  }
  const closePopover = () => { popover = null; };
  async function chooseModel(model: ModelInfo): Promise<void> {
    closePopover();
    await store.run(api.setModel(id, model.provider, model.id));
  }
  async function chooseEffort(level: string): Promise<void> {
    closePopover();
    await store.run(api.setThinking(id, level));
  }

  let editingTitle = $state<string | null>(null);
  let seenRenameTick = ui.renameTick;
  $effect(() => {
    const current = ui.renameTick;
    if (current !== seenRenameTick) { seenRenameTick = current; untrack(startRename); }
  });
  function startRename(): void { if (editingTitle === null) editingTitle = row?.named || thread?.info.name ? title : ""; }
  async function commitRename(): Promise<void> {
    const draft = editingTitle;
    editingTitle = null;
    if (draft === null) return;
    const name = draft.trim();
    if (!name || name === title) return;
    await store.run(api.rename(id, name));
  }
  function onTitleKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
    else if (event.key === "Escape") { event.stopPropagation(); editingTitle = null; }
  }
  function focusAndSelect(node: HTMLInputElement): void { node.focus(); node.select(); }

  let scroller: HTMLElement | undefined = $state();
  let column: HTMLElement | undefined = $state();
  let pinned = $state(true);
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
    void shown;
    if (untrack(() => pinned)) void tick().then(scrollToBottom);
  });

  $effect(() => {
    if (thread && !busy) store.markRead(id);
  });
  $effect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") store.markRead(id); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  const send = (text: string, images: Parameters<typeof store.send>[2], mode: Parameters<typeof store.send>[3]) => store.send(id, text, images, mode);
  const stop = () => { void store.run(api.abort(id)); };
  async function compact(): Promise<void> {
    closePopover();
    const ok = await store.run(api.compact(id));
    if (ok) store.toast("Compaction started.", "info");
  }
  function copyId(): void {
    closePopover();
    void navigator.clipboard.writeText(id).then(() => store.toast("Session id copied.", "info"));
  }
</script>

<div class="thread">
  <header class="head">
    {#if !store.sidebarOpen || narrow}
      <button class="icon-button" aria-label="Show sidebar" title="Show sidebar (Cmd+B)" onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
    <div class="title-wrap">
      {#if editingTitle !== null}
        <input class="field title-input" bind:value={editingTitle} placeholder="Thread name" aria-label="Thread name" use:focusAndSelect onkeydown={onTitleKey} onblur={() => void commitRename()} />
      {:else}
        <button class="title" title="Rename (F2)" onclick={startRename}>{title}</button>
      {/if}
    </div>
    <div class="controls">
      <Popover open={popover === "model"} onclose={closePopover} align="end" width="260px">
        {#snippet trigger()}
          <button class="chip" disabled={busy || saved || !thread} title={saved ? "Reply first to resume this thread, then change the model" : "Model"} onclick={() => openPopover("model")}>
            <span class="chip-text">{thread?.info.model?.name ?? row?.model ?? "Model"}</span><Icon name="chevronDown" size={12} />
          </button>
        {/snippet}
        <ModelMenu {catalog} error={catalogError} current={thread?.info.model ?? null} onchoose={model => void chooseModel(model)} />
      </Popover>
      <Popover open={popover === "effort"} onclose={closePopover} align="end" width="160px">
        {#snippet trigger()}
          <button class="chip" disabled={busy || saved || !thread} title="Effort" onclick={() => openPopover("effort")}>
            <Icon name="sparkle" size={13} /><span class="chip-text">{thread?.info.thinkingLevel ?? row?.thinkingLevel ?? "effort"}</span><Icon name="chevronDown" size={12} />
          </button>
        {/snippet}
        {#each thread?.info.availableThinkingLevels ?? [] as level (level)}
          <button class="menu-item" class:current={thread?.info.thinkingLevel === level} onclick={() => void chooseEffort(level)}>{level}</button>
        {/each}
      </Popover>
      {#if cwd}<span class="chip cwd" title={cwd}><Icon name="folder" size={13} /><span class="chip-text">{shortPath(cwd)}</span></span>{/if}
      {#if thread?.children.length}
        <Popover open={popover === "agents"} onclose={closePopover} align="end" width="320px">
          {#snippet trigger()}
            <button class="chip" class:active={runningChildren > 0} title="Agents" onclick={() => openPopover("agents")}>
              <Icon name="users" size={13} /><span class="chip-text">{runningChildren ? `${runningChildren} of ${thread.children.length}` : thread.children.length}</span>
            </button>
          {/snippet}
          <div class="menu-heading">Agents</div>
          {#each thread.children as child (child.id)}
            <div class="agent">
              <div class="agent-head">
                <span class="status-dot" class:running={child.status === "running"} class:done={child.status === "done"} class:error={child.status === "error" || child.status === "cancelled"}></span>
                <span class="agent-name">{child.sessionName ?? child.label}</span>
                <span class="hint">{child.status}{child.durationMs !== undefined ? " · " + duration(child.durationMs) : ""}</span>
              </div>
              {#if child.sessionName && child.label !== child.sessionName}<div class="agent-label">{child.label}</div>{/if}
              {#if child.activity}<div class="agent-recap">{child.activity.kind}{child.activity.toolName ? " " + child.activity.toolName : ""}</div>{/if}
              {#if child.recap}<div class="agent-recap">{child.recap}</div>{/if}
              {#if child.error}<div class="agent-recap danger">{child.error}</div>{/if}
            </div>
          {/each}
        </Popover>
      {/if}
      {#if context}
        <span class="ring" title="Context: {contextPercent}% ({context.tokens.toLocaleString()} of {context.contextWindow.toLocaleString()} tokens)" aria-label="Context {contextPercent}% used" role="img">
          <svg width="22" height="22" viewBox="0 0 22 22">
            <circle cx="11" cy="11" r="8" fill="none" stroke="var(--border-strong)" stroke-width="2.5" />
            <circle cx="11" cy="11" r="8" fill="none" stroke={contextPercent >= 85 ? "var(--danger)" : contextPercent >= 65 ? "var(--warning)" : "var(--accent)"} stroke-width="2.5"
              stroke-linecap="round" stroke-dasharray="{RING * contextPercent / 100} {RING}" transform="rotate(-90 11 11)" />
          </svg>
          <span class="ring-text">{contextPercent}%</span>
        </span>
      {/if}
      <Popover open={popover === "more"} onclose={closePopover} align="end" width="200px">
        {#snippet trigger()}
          <button class="icon-button" aria-label="More" title="More" onclick={() => openPopover("more")}><Icon name="more" /></button>
        {/snippet}
        <button class="menu-item" disabled={busy || saved || !thread} onclick={() => void compact()}>Compact context</button>
        <button class="menu-item" onclick={() => { closePopover(); startRename(); }}>Rename<span class="hint">F2</span></button>
        <button class="menu-item" onclick={() => { closePopover(); store.drawer = "accounts"; }}>Accounts</button>
        <div class="menu-separator"></div>
        <button class="menu-item" onclick={copyId}>Copy session id</button>
      </Popover>
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
        {#each shown as turn (turn.key)}
          <Turn {turn} threadId={id} />
        {/each}
        {#if !shown.length}<div class="empty muted">No messages yet.</div>{/if}
      </div>
    </div>
    {#if !pinned}
      <button class="jump fade-in" onclick={() => { pinned = true; scrollToBottom(); }}><Icon name="arrowDown" size={14} /> Jump to latest</button>
    {/if}
    <div class="foot">
      <div class="column">
        <QueueChips threadId={id} queue={thread.queue} />
        <Composer draftKey={id} threadId={id} {busy} placeholder={saved ? "Reply to resume this thread" : "Message Prime Agent"}
          acceptsImages={thread.info.model?.input.includes("image") ?? true} focusOnMount={!narrow} {send} {stop} />
        <div class="status-line">
          {#if busy}<span class="spinner tiny"></span><span class="status-text" title={statusText}>{statusText}</span>{:else if saved}<span class="status-text">Saved thread. A reply resumes it.</span>{/if}
          <span class="spacer"></span>
          <span class="status-chip"><AccountChip threadId={id} compact /></span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .thread { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; min-height: 52px; border-bottom: 1px solid var(--border); background: var(--bg); flex-wrap: wrap; }
  .title-wrap { flex: 1; min-width: 120px; }
  .title { max-width: 100%; padding: 4px 8px; border-radius: var(--radius-small); font-weight: 600; font-size: 15px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover { background: var(--bg-hover); }
  .title-input { font-weight: 600; font-size: 15px; max-width: 480px; }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip-text { overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
  .cwd { color: var(--text-faint); }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .agent { padding: 6px 10px; font-size: 13px; }
  .agent + .agent { border-top: 1px solid var(--border); }
  .agent-head { display: flex; align-items: center; gap: 8px; }
  .agent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .agent-label, .agent-recap { color: var(--text-muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .danger { color: var(--danger); }
  .ring { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .ring svg { display: block; }
  .thin-bar { padding: 3px 12px; font-size: 12px; text-align: center; color: var(--accent); background: var(--accent-soft); }
  .error-bar { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 12px; font-size: 13px; color: var(--danger); background: var(--danger-soft); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; max-width: 420px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .column { width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 20px 24px; }
  .empty { padding: 48px 0; text-align: center; }
  .jump { position: absolute; left: 50%; bottom: 132px; transform: translateX(-50%); z-index: 5; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 13px; }
  .foot { flex: none; background: var(--bg); }
  .foot .column { padding: 4px 20px 8px; }
  .status-line { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 4px 6px 0; font-size: 12px; color: var(--text-muted); }
  .spacer { flex: 1; }
  .status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-chip { flex: none; }
  @container app (max-width: 899px) {
    .head { padding: 6px 8px; }
    .cwd { display: none; }
    .column { padding: 8px 12px 16px; }
    .foot .column { padding: 4px 10px 8px; }
  }
</style>
