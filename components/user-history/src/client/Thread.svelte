<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import { buildTurns, liveTurn, messageText } from "../shared/turns.ts";
  import type { ModelCatalog, ModelInfo, ThinkingLevel, ThreadMessage } from "../shared/types.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import ContextMeter from "./ContextMeter.svelte";
  import { clockTime, duration, shortPath } from "./format.ts";
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
  const live = $derived(thread ? liveTurn(turns.at(-1), thread.streaming, thread.tools, messages.length, thread.info.isStreaming) : null);
  const shown = $derived.by(() => {
    if (!live) return turns;
    const last = turns.at(-1);
    return last && last.key === live.key ? [...turns.slice(0, -1), live] : [...turns, live];
  });
  const questions = $derived(turns.flatMap(turn => {
    if (!turn.prompt) return [];
    const content = turn.prompt.message.content;
    return [{ key: turn.key, text: messageText(turn.prompt.message).trim(), skill: turn.prompt.message.skill ?? null,
      images: typeof content === "string" ? 0 : content.filter(part => part.type === "image").length, at: clockTime(turn.prompt.message.timestamp) }];
  }));
  async function jumpTo(key: string): Promise<void> {
    ui.setViewMode("default");
    pinned = false;
    await tick();
    const target = document.getElementById(key);
    target?.scrollIntoView({ block: "start" });
    requestAnimationFrame(() => target?.scrollIntoView({ block: "start" }));
    target?.classList.add("flash");
    setTimeout(() => target?.classList.remove("flash"), 1200);
  }
  const context = $derived(thread?.info.context ?? null);
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

  let agentsOpen = $state(false);
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
        <button class="title" title="{title}. Click or press F2 to rename. Session {id}" onclick={startRename}>{title}</button>
      {/if}
      {#if cwd}<span class="cwd" title={cwd}>{shortPath(cwd)}</span>{/if}
    </div>
    <div class="controls">
      <div class="segmented" role="radiogroup" aria-label="View">
        <button role="radio" aria-checked={ui.viewMode === "default"} class:on={ui.viewMode === "default"} onclick={() => ui.setViewMode("default")}>Default</button>
        <button role="radio" aria-checked={ui.viewMode === "questions"} class:on={ui.viewMode === "questions"} onclick={() => ui.setViewMode("questions")}>Questions</button>
      </div>
      {#if thread?.children.length}
        <Popover open={agentsOpen} onclose={() => { agentsOpen = false; }} align="end" width="320px">
          {#snippet trigger()}
            <button class="bar-button" class:active-agents={runningChildren > 0} title="Agents" onclick={() => { agentsOpen = !agentsOpen; }}>
              <Icon name="users" size={14} /><span>{runningChildren ? `${runningChildren} of ${thread.children.length}` : thread.children.length}</span>
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
        {#if ui.viewMode === "questions"}
          {#each questions as question (question.key)}
            <button class="question" onclick={() => void jumpTo(question.key)} title="Show this turn">
              {#if question.skill}<span class="question-skill">{question.skill}</span>{/if}
              <span class="question-text">{question.text || (question.images ? "Image" : "(empty)")}</span>
              <span class="question-meta">{question.images ? `${question.images} image${question.images === 1 ? "" : "s"} · ` : ""}{question.at}</span>
            </button>
          {/each}
          {#if !questions.length}<div class="empty muted">No questions in this thread yet.</div>{/if}
        {:else}
          {#each shown as turn (turn.key)}
            <Turn {turn} threadId={id} />
          {/each}
          {#if !shown.length}<div class="empty muted">No messages yet.</div>{/if}
        {/if}
      </div>
    </div>
    {#if !pinned}
      <button class="jump fade-in" onclick={() => { pinned = true; scrollToBottom(); }}><Icon name="arrowDown" size={14} /> Jump to latest</button>
    {/if}
    <div class="foot">
      <div class="column">
        <QueueChips threadId={id} queue={thread.queue} />
        <Composer draftKey={id} threadId={id} {busy} placeholder={saved ? "Reply to resume this thread" : "Ask for follow-up changes"}
          acceptsImages={thread.info.model?.input.includes("image") ?? true} focusOnMount={!narrow} {send} {stop}>
          {#snippet left()}
            <AccountChip threadId={id} />
            {#if context && thread}
              <ContextMeter threadId={id} {context} usage={thread.info.usage} {messages} live={!saved} />
            {/if}
          {/snippet}
          {#snippet right()}
            <ModelPicker label={modelLabel} disabled={busy || saved || !thread}
              title={saved ? "Reply first to resume this thread, then change the model" : busy ? "Wait for the agent to finish" : "Model and effort"}
              {catalog} error={catalogError} current={thread?.info.model ?? null} onopen={loadCatalog} onchoose={model => void chooseModel(model)}
              effort={thread?.info.thinkingLevel ?? null} levels={thread?.info.availableThinkingLevels ?? []} oneffort={level => void chooseEffort(level)}
              note="Model and effort changes also become the default for new chats." />
          {/snippet}
        </Composer>
        <div class="status-line">
          {#if busy}<span class="spinner tiny"></span><span class="status-text" title={statusText}>{statusText}</span>{:else if saved}<span class="status-text">Saved thread. A reply resumes it.</span>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .thread { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 40px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .head .icon-button { width: 28px; height: 28px; }
  .title-wrap { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
  .cwd { flex: none; font-size: 12px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; }
  .segmented { display: inline-flex; padding: 2px; border-radius: var(--radius-small); background: var(--bg-hover); }
  .segmented button { height: 24px; padding: 0 10px; border-radius: 6px; font-size: 12px; color: var(--text-muted); }
  .segmented button:hover { color: var(--text); }
  .segmented button.on { background: var(--bg-elevated); color: var(--text); box-shadow: 0 1px 2px var(--shadow-near); }
  .active-agents { color: var(--accent); }
  .question { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 10px 12px; margin: 2px 0; border-radius: var(--radius-small); text-align: left; }
  .question:hover { background: var(--bg-hover); }
  .question-skill { flex: none; padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-family: var(--mono); }
  .question-text { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
  .question-meta { flex: none; font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .column :global(.turn.flash) { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent-soft); } to { background: transparent; } }
  .title { max-width: 100%; min-width: 0; padding: 3px 8px; border-radius: var(--radius-small); font-weight: 600; font-size: 14px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover { background: var(--bg-hover); }
  .title-input { font-weight: 600; font-size: 14px; height: 28px; max-width: 480px; }
  .controls { display: flex; align-items: center; gap: 6px; flex: none; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .agent { padding: 6px 10px; font-size: 13px; }
  .agent + .agent { border-top: 1px solid var(--border); }
  .agent-head { display: flex; align-items: center; gap: 8px; }
  .agent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .agent-label, .agent-recap { color: var(--text-muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .danger { color: var(--danger); }
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
  .status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @container app (max-width: 899px) {
    .cwd { display: none; }
    .column { padding: 8px 12px 16px; }
    .foot .column { padding: 4px 10px 8px; }
  }
</style>
