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
  import { clockTime, shortPath } from "./format.ts";
  import Turn from "./Turn.svelte";
  import Composer from "./Composer.svelte";
  import QueueChips from "./QueueChips.svelte";
  import AccountChip from "./AccountChip.svelte";
  import Popover from "./Popover.svelte";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import TagChip from "./TagChip.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import PriorityPicker from "./PriorityPicker.svelte";
  import ProgressPicker from "./ProgressPicker.svelte";
  import SubagentList from "./SubagentList.svelte";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { labels, threadTags } from "./labels.ts";
  import { PRIORITY_LABEL, PROGRESS_LABEL } from "./organize.ts";
  import { clock } from "./clock.svelte.ts";
  import { readPulse } from "../shared/pulse.ts";

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
      images: typeof content === "string" ? [] : content.filter(part => part.type === "image"), at: clockTime(turn.prompt.message.timestamp) }];
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
  let labelPicker = $state<{ field: "tags" | "priority" | "progress"; anchor: HTMLElement } | null>(null);
  function pick(event: MouseEvent, field: "tags" | "priority" | "progress"): void {
    const anchor = event.currentTarget as HTMLElement;
    labelPicker = labelPicker?.field === field ? null : { field, anchor };
  }
  const closePicker = () => { labelPicker = null; };
  const rowTags = $derived((row?.tags ?? []).flatMap(tagId => store.tags.filter(tag => tag.id === tagId)));
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

  let editingTitle = $state<string | null>(null);
  function startRename(): void { if (editingTitle === null) editingTitle = title; }
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

  /** An open thread keeps its Needs response place while you read it; leaving it (another thread, or the tab going hidden) marks it read. */
  $effect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") store.markRead(id); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { document.removeEventListener("visibilitychange", onHidden); store.markRead(id); };
  });

  const send = (text: string, images: Parameters<typeof store.send>[2], mode: Parameters<typeof store.send>[3]) => store.send(id, text, images, mode);
  const stop = () => { void store.run(api.abort(id)); };
</script>

<div class="thread">
  <header class="head">
    {#if !store.sidebarOpen || narrow}
      <button type="button" class="icon-button" aria-label="Show sidebar" use:tooltip={"Show sidebar ⌘B"} onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
    <div class="title-wrap">
      {#if editingTitle !== null}
        <input class="field title-input" bind:value={editingTitle} placeholder="Thread name" aria-label="Thread name" use:focusAndSelect onkeydown={onTitleKey} onblur={() => void commitRename()} />
      {:else}
        <button type="button" class="title" aria-label="Rename thread {title}" onclick={startRename}>{title}</button>
      {/if}
      {#if cwd}<span class="cwd">{shortPath(cwd)}</span>{/if}
      {#if row}<span class="tags">
        {#each rowTags as tag (tag.id)}
          <button type="button" class="tag-button" aria-label="Remove tag {tag.name}" onclick={() => void labels.setTag([id], tag.id, false)}><TagChip {tag} /><span class="x" aria-hidden="true"><Icon name="x" size={10} /></span></button>
        {/each}
        <button type="button" class="add-tag" aria-haspopup="dialog" aria-expanded={labelPicker?.field === "tags"} onclick={event => pick(event, "tags")}>
          <Icon name="plus" size={12} />{rowTags.length ? "" : "Tag"}
        </button>
      </span>
      <button type="button" class="label-button" class:set={row.priority > 0} aria-haspopup="dialog" aria-expanded={labelPicker?.field === "priority"} onclick={event => pick(event, "priority")}>
        <PriorityBars level={row.priority} /><span class="label-text">{row.priority ? PRIORITY_LABEL[row.priority] : "Priority"}</span>
      </button>
      <button type="button" class="label-button" class:set={row.progress !== "none"} aria-haspopup="dialog" aria-expanded={labelPicker?.field === "progress"} onclick={event => pick(event, "progress")}>
        <ProgressSteps progress={row.progress} /><span class="label-text">{row.progress !== "none" ? PROGRESS_LABEL[row.progress] : "Progress"}</span>
      </button>{/if}
    </div>
    <div class="controls">
      <div class="segmented" role="radiogroup" aria-label="View">
        <button type="button" role="radio" aria-checked={ui.viewMode === "default"} class:on={ui.viewMode === "default"} onclick={() => ui.setViewMode("default")}>Default</button>
        <button type="button" role="radio" aria-checked={ui.viewMode === "questions"} class:on={ui.viewMode === "questions"} onclick={() => ui.setViewMode("questions")}>Questions</button>
      </div>
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
      <button type="button" class="icon-button" class:on={ui.notesOpen} aria-label="Notepad" aria-pressed={ui.notesOpen} use:tooltip={ui.notesOpen ? "Hide notepad" : "Notepad"}
        onclick={() => ui.setNotesOpen(!ui.notesOpen)}><Icon name="note" size={16} /></button>
      {#if row && !row.archived}
        <button type="button" class="icon-button" aria-label="Archive thread" use:tooltip={busy ? "Stop and archive" : "Archive"} onclick={archive}><Icon name="archive" size={16} /></button>
      {/if}
    </div>
  </header>
  {#if labelPicker?.field === "tags"}
    <Floating anchor={labelPicker.anchor} width={260} maxHeight={360} label="Tags" onclose={closePicker}><TagPicker selection={threadTags([id])} /></Floating>
  {:else if labelPicker?.field === "priority" && row}
    <Floating anchor={labelPicker.anchor} width={210} maxHeight={120} label="Priority" onclose={closePicker}>
      <div class="menu-heading">Priority</div>
      <PriorityPicker value={row.priority} autofocus onchange={level => { closePicker(); void labels.setPriority([id], level); }} />
    </Floating>
  {:else if labelPicker?.field === "progress" && row}
    <Floating anchor={labelPicker.anchor} width={300} maxHeight={120} label="Progress" onclose={closePicker}>
      <div class="menu-heading">Progress</div>
      <ProgressPicker value={row.progress} autofocus onchange={step => { closePicker(); void labels.setProgress([id], step); }} />
    </Floating>
  {/if}

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
            <button type="button" class="question" onclick={() => void jumpTo(question.key)}>
              <span class="question-body">
                {#if question.skill}<span class="question-skill">{question.skill}</span>{/if}
                {#if question.text || !question.images.length}<span class="question-text">{question.text || "(empty)"}</span>{/if}
                {#if question.images.length}
                  <span class="question-images">
                    {#each question.images as image, index (image.url + index)}<img src={image.url} alt="Attached {index + 1}" loading="lazy" />{/each}
                  </span>
                {/if}
              </span>
              <span class="question-meta">{question.at}</span>
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
  .title-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .cwd { flex: none; font-size: 12px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; }
  .active-agents { color: var(--accent-bold); }
  .head .icon-button.on { color: var(--accent-bold); background: var(--accent-soft); }
  .child-alert { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .child-alert.stalled { background: var(--warning); }
  .child-alert.failed { background: var(--danger); }
  .tags { display: inline-flex; align-items: center; gap: 4px; min-width: 0; flex: 0 1 auto; overflow: hidden; }
  .tag-button { position: relative; display: inline-flex; flex: none; border-radius: 4px; }
  .tag-button .x { position: absolute; right: -3px; top: -4px; display: none; width: 12px; height: 12px; border-radius: 50%; align-items: center; justify-content: center; background: var(--text); color: var(--bg); }
  .tag-button:hover .x, .tag-button:focus-visible .x { display: inline-flex; }
  .tag-button:hover :global(.tag) { text-decoration: line-through; }
  .add-tag { display: inline-flex; align-items: center; gap: 3px; flex: none; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px dashed var(--border-strong); font-size: 11.5px; color: var(--text-faint); }
  .add-tag:hover, .add-tag[aria-expanded="true"] { color: var(--text); border-color: var(--text-faint); border-style: solid; }
  .label-button { display: inline-flex; align-items: center; gap: 5px; flex: none; height: 22px; padding: 0 6px; border-radius: 4px; font-size: 11.5px; color: var(--text-faint); white-space: nowrap; transition: background-color 0.12s, color 0.12s; }
  .label-button.set { color: var(--text-muted); }
  .label-button:hover, .label-button[aria-expanded="true"] { background: var(--bg-hover); color: var(--text); }
  .modal-list { padding: 12px 14px; }
  .question { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 10px 12px; margin: 2px 0; border-radius: var(--radius-small); text-align: left; }
  .question:hover { background: var(--bg-hover); }
  .question-body { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; flex: 1; min-width: 0; }
  .question-images { display: flex; flex-wrap: wrap; gap: 6px; }
  .question-images img { display: block; max-width: 160px; max-height: 120px; border-radius: var(--radius-small); }
  .question-skill { flex: none; padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-family: var(--mono); }
  .question-text { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .question-meta { flex: none; font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .column :global(.turn.flash) { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent-soft); } to { background: transparent; } }
  .title { flex: 0 8 auto; max-width: 100%; min-width: 96px; padding: 3px 8px; border-radius: var(--radius-small); font-weight: 600; font-size: 14px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover { background: var(--bg-hover); }
  .title-input { font-weight: 600; font-size: 14px; height: 28px; max-width: 480px; }
  .controls { display: flex; align-items: center; gap: 6px; flex: none; }
  .thin-bar { padding: 3px 12px; font-size: 12px; text-align: center; color: var(--accent); background: var(--accent-soft); }
  .error-bar { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 12px; font-size: 13px; color: var(--danger); background: var(--danger-soft); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; max-width: 420px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .column { width: 100%; max-width: var(--column); margin: 0 auto; padding: 12px 20px 24px; }
  .empty { padding: 48px 0; text-align: center; }
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
    .cwd, .label-text { display: none; }
    .column { padding: 8px 12px 16px; }
    .foot .column { padding: 4px 10px 8px; }
  }
</style>
