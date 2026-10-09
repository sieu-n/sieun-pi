<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { applyBoardOp, emptyBoard, nextIds } from "../shared/chat-board.ts";
  import type { ArtifactLink, BoardOp, ChatAgent, ChatBoard, OwnerTodo, PlanItem, ScratchItem } from "../shared/types.ts";
  import { AGENT_LINK_LABEL, AGENT_STATE_LABEL } from "./board.ts";
  import { elapsed } from "./organize.ts";
  import { countItems, groupTodos, isEmptyBoard, isFinished, linkChip, linkLabel, offeredLink, planProgress, planTotals, planWait, treeRows, type TreeRow, type TreeView } from "./board.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { ChatDuties, dutiesCount } from "./duties.svelte.ts";
  import DutyList from "./DutyList.svelte";
  import Icon from "./Icon.svelte";
  import IdChip from "./IdChip.svelte";
  import PlanMark from "./PlanMark.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { renderInline } from "./markdown.ts";
  import { proseClick } from "./prose.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";

  /**
   * The chat's board as cards, in this order: the plan the chat keeps (read-only here), For you (the chat's asks, each a question with its
   * choices in a row under it, answered by a tap on a choice or a typed reply; owner notes look the same), Duties (DutyList), Agents (every
   * thread the server links to the chat, `SessionRow.agents`: a status dot, the name, one line of activity and the age; a click opens the job
   * drawer for a subagent and the thread for anything else, `onagent`; a hover shows the report card), and Notes (nested notes with links to
   * jobs, messages, wiki pages, files and web pages; the owner adds and removes notes).
   * Plan steps and notes are trees: everything with children starts folded, done and dropped steps hide behind "Show done" per parent, and
   * each item carries its id chip (the id the chat uses, with a color hashed from the chat and item ids; a click copies the id).
   * A row is a fixed lead (the fold, the status mark and the chip) and a text block beside it, so a wrapped line, a counter, a wait and a note
   * line up under the start of the text (a hanging indent at every depth). A note's link opens through `store.openArtifact` (the reader, the
   * thread, or a tab); the text of a plan step with an owner (`item.job`) is a link that `onjob` resolves (the job drawer, or the owner's own thread). The Plan and Notes headers carry an "Open plan"
   * button, and a double click on a row or its hover "open" button opens the plan view (`store.openPlan`) on that item. `checkIn` is the
   * server's 5-minute tick line under the cards. `apply` gets the board after the owner's ops and the ops themselves; it resolves false when
   * the server refused them.
   */
  let { id, board, agents, now, checkIn, onjob, onagent, previewJob, apply }: {
    id: string; board: ChatBoard | null; agents: readonly ChatAgent[]; now: number; checkIn: { text: string; on: boolean }; onjob: (name: string) => void; onagent: (agent: ChatAgent) => void;
    previewJob: (owner: string) => string | undefined; apply: (next: ChatBoard, ops: BoardOp[]) => Promise<boolean>;
  } = $props();

  /** The Agents header counts the working agents, or every agent when none works. */
  const workingCount = $derived(agents.filter(agent => agent.state === "working").length);
  const agentsCount = $derived(workingCount ? `${workingCount} running` : agents.length ? String(agents.length) : "");
  const agentsOpen = $derived(ui.boardCards.agents ?? true);
  /** How long since the agent last did anything, on the minute. */
  const agentAge = (agent: ChatAgent): string => { const at = Date.parse(agent.lastActivityAt ?? ""); return at ? elapsed(Math.max(0, now - at)) : ""; };
  /** "48 tok/s", one decimal under 10. */
  const rateText = (tps: number): string => `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
  const agentTitle = (agent: ChatAgent): string => `${AGENT_STATE_LABEL[agent.state]}${agent.steps.length ? ` · ${agent.steps.join(", ")}` : ""} · ${AGENT_LINK_LABEL[agent.link]}`;

  /** The chat's standing duties (src/shared/chat-duties.ts), polled while the panel shows; the card appears once the chat has one. */
  const duties = new ChatDuties();
  $effect(() => duties.watch(id));
  const dutiesOpen = $derived(ui.boardCards.duties ?? true);

  const todos = $derived(groupTodos(board?.todos ?? []));
  const openCount = $derived(todos.open.length);
  const scratch = $derived(board?.scratch ?? []);
  const noteCount = $derived(countItems(scratch));
  const totals = $derived(planTotals(board?.plan ?? []));
  /** Folds and "Show done" are the owner's per chat, kept in the browser (ui.boardItemsOpen, ui.boardShowDone). */
  const view: TreeView = { open: itemId => ui.boardItemsOpen[`${id}/${itemId}`] === true, showDone: parent => ui.boardShowDone[`${id}/${parent}`] === true };
  const planRows = $derived(treeRows(board?.plan ?? [], view, isFinished));
  const noteRows = $derived(treeRows(scratch, view));
  const fold = (itemId: string) => ui.setBoardItemOpen(id, itemId, !view.open(itemId));
  const openPlan = (focus: string | null = null) => store.openPlan(id, focus);
  /** A double click on a row opens the plan view on it; one that lands on a control (the chip, the fold, a link) is that control's own. */
  const onRowDblClick = (itemId: string) => (event: MouseEvent) => { if (!(event.target instanceof Element && event.target.closest("button, a, input"))) openPlan(itemId); };

  function send(ops: BoardOp[]): Promise<boolean> {
    let next = board ?? emptyBoard(new Date().toISOString());
    const newId = nextIds(next);
    for (const op of ops) next = applyBoardOp(next, op, "owner", new Date().toISOString(), newId).board;
    return apply(next, ops);
  }

  /** Plan and Notes keep the owner's fold across chats; For you opens whenever something waits on the owner. */
  const planOpen = $derived(ui.boardCards.plan ?? true);
  const notesOpen = $derived(ui.boardCards.notes ?? true);
  let forYouOpen = $state(false);
  $effect(() => { if (openCount) untrack(() => { forYouOpen = true; }); });
  let doneOpen = $state(false);

  let editing = $state<{ id: string; text: string } | null>(null);
  let answering = $state<{ id: string; text: string } | null>(null);
  function saveEdit(): void {
    const draft = editing;
    editing = null;
    if (!draft) return;
    const text = draft.text.trim();
    const todo = board?.todos.find(entry => entry.id === draft.id);
    if (!todo || !text || text === todo.text) return;
    void send([{ op: "todo_update", id: draft.id, text }]);
  }
  /** An answer settles the ask: the reply is saved and the todo is checked, by a tap on a choice or by Enter in the reply field. */
  function answer(todo: OwnerTodo, reply: string): void {
    answering = null;
    const text = reply.trim();
    if (!text) return;
    void send([{ op: "todo_update", id: todo.id, reply: text, done: true }]);
  }
  const onKey = (save: () => void, cancel: () => void) => (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); save(); }
    else if (event.key === "Escape") { event.stopPropagation(); cancel(); }
  };
  function focusEnd(node: HTMLInputElement | HTMLTextAreaElement): void { node.focus(); node.setSelectionRange(node.value.length, node.value.length); }

  let noteDraft = $state("");
  let noteLinks = $state<ArtifactLink[]>([]);
  /** The note the next note goes under, picked with a note's + button; cleared by its chip's x, Escape, or the save. */
  let noteParent = $state<ScratchItem | null>(null);
  let noteField: HTMLInputElement | undefined = $state();
  function addUnder(item: ScratchItem): void { noteParent = item; noteField?.focus(); }
  const offer = $derived(offeredLink(noteDraft));
  function attachOffer(): void {
    if (!offer) return;
    noteLinks = [...noteLinks, { label: linkLabel(offer.target), target: offer.target }];
    noteDraft = offer.text;
  }
  function addNote(): void {
    const text = noteDraft.trim() || noteLinks[0]?.label || "";
    if (!text) return;
    const links = noteLinks;
    const parent = noteParent;
    noteDraft = "";
    noteLinks = [];
    noteParent = null;
    if (parent) ui.setBoardItemOpen(id, parent.id, true);
    void send([{ op: "scratch_add", text, links, ...(parent ? { parent: parent.id } : {}) }])
      .then(ok => { if (!ok && !noteDraft.trim() && !noteLinks.length) { noteDraft = text; noteLinks = links; noteParent = parent; } });
  }
  function clearNote(): void { noteDraft = ""; noteLinks = []; noteParent = null; }

  const todoLabel = (todo: OwnerTodo) => todo.from === "owner" ? "Your note" : "Ask from the chat";
  /** The step text is a span, not a button, so it wraps like the rest of the line; Enter and Space open it like a button would. */
  /** A link in a todo (a wiki page, a file, a job, a thread, a web URL) opens like it does in a chat bubble; editing is the pencil button. */
  function onTodoClick(event: MouseEvent): void {
    const click = proseClick(event);
    if (click?.kind === "artifact") { const target = parseArtifactTarget(click.target); if (target) store.openArtifact(target, id); }
    else if (click?.kind === "mention") store.openPlan(id, click.id);
    else if (click?.kind === "job") store.openArtifact({ kind: "job", name: click.name }, id);
  }
  const onStepKey = (job: string) => (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onjob(job); } };
</script>

{#snippet card(key: "plan" | "foryou" | "agents" | "duties" | "notes", title: string, count: string, open: boolean, toggle: () => void, body: Snippet, expandable = false)}
  <section class="island" data-card={key} class:open>
    <div class="island-head">
      <button type="button" class="island-toggle" aria-expanded={open} onclick={toggle}>
        <span class="island-title">{title}</span>
        {#if count}<span class="island-count">{count}</span>{/if}
      </button>
      {#if expandable}
        <button type="button" class="icon-button small island-open" aria-label="Open the plan view" use:tooltip={"Open plan"} onclick={() => openPlan()}><Icon name="expandBox" size={13} /></button>
      {/if}
      <span class="chev" class:open><Icon name="chevronDown" size={13} /></span>
    </div>
    {#if open}<div class="island-body">{@render body()}</div>{/if}
  </section>
{/snippet}

{#snippet openRow(itemId: string)}
  <button type="button" class="icon-button small row-open" aria-label="Open {itemId} in the plan view" use:tooltip={"Open in plan view"} onclick={() => openPlan(itemId)}><Icon name="expandBox" size={12} /></button>
{/snippet}

{#snippet foldButton(item: { id: string; text: string; children: unknown[] }, open: boolean)}
  {#if item.children.length}
    <button type="button" class="fold" aria-expanded={open} aria-label="{open ? 'Fold' : 'Unfold'} {item.text}" onclick={() => fold(item.id)}><span class="chev" class:open><Icon name="chevronDown" size={11} /></span></button>
  {:else}<span class="fold"></span>{/if}
{/snippet}

{#snippet finishedRow(row: Extract<TreeRow<unknown>, { kind: "finished" }>)}
  <li class="finished" style:--depth={row.depth}>
    <button type="button" class="done-fold" aria-pressed={row.shown} onclick={() => ui.setBoardShowDone(id, row.parent, !row.shown)}>
      <span class="chev" class:open={row.shown}><Icon name="chevronDown" size={11} /></span>{row.shown ? "Hide done" : `Show done (${row.count})`}
    </button>
  </li>
{/snippet}

{#snippet planRow(row: TreeRow<PlanItem>)}
  {#if row.kind === "finished"}{@render finishedRow(row)}
  {:else}
    {@const item = row.item}
    {@const progress = planProgress(item)}
    {@const wait = planWait(item, now)}
    {@const open = view.open(item.id)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <li class="plan-item {item.status}" style:--depth={row.depth} ondblclick={onRowDblClick(item.id)}>
      <span class="row-lead">
        {@render foldButton(item, open)}
        <PlanMark status={item.status} />
        <IdChip chat={id} id={item.id} />
      </span>
      <div class="row-body">
        <p class="plan-line">
          {#if item.job}
            {@const job = item.job}
            {@const preview = previewJob(job)}
            <span class="plan-text linked" role="button" tabindex="0" title={preview ? undefined : "Open " + job} data-preview-chat={id} data-preview-job={preview} onclick={() => onjob(job)} onkeydown={onStepKey(job)}>{item.text}</span>
          {:else}<span class="plan-text">{item.text}</span>{/if}
          {#if progress}<span class="progress">{progress.done} of {progress.total} done</span>{/if}
          {#if wait}<span class="wait">{wait}</span>{/if}
        </p>
        {#if item.note}<p class="plan-note">{item.note}</p>{/if}
      </div>
      {@render openRow(item.id)}
    </li>
  {/if}
{/snippet}

{#snippet todoRow(todo: OwnerTodo)}
  {@const setDone = (done: boolean) => void send([{ op: "todo_update", id: todo.id, done }])}
  <li class="ask" class:done={todo.done} class:mine={todo.from === "owner"}>
    {#if editing?.id === todo.id}
      <input class="field inline" bind:value={editing.text} aria-label="Edit {todo.text}" use:focusEnd onkeydown={onKey(saveEdit, () => { editing = null; })} onblur={saveEdit} />
    {:else}
      <div class="ask-line">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="ask-text prose-inline" title={todoLabel(todo)} onclick={onTodoClick}>{@html renderInline(todo.text)}</div>
        <button type="button" class="icon-button small edit" aria-label="Edit {todo.text}" use:tooltip={"Edit"} onclick={() => { editing = { id: todo.id, text: todo.text }; }}><Icon name="pencil" size={12} /></button>
      </div>
    {/if}
    {#if answering?.id === todo.id}
      <input class="field inline" bind:value={answering.text} placeholder="Your reply, Enter sends" aria-label="Reply to {todo.text}" use:focusEnd
        onkeydown={onKey(() => { if (answering) answer(todo, answering.text); }, () => { answering = null; })} />
    {:else if todo.reply}
      <button type="button" class="reply" title="Click to change your answer" onclick={() => { answering = { id: todo.id, text: todo.reply ?? "" }; }}><span class="reply-lead">You:</span> {todo.reply}</button>
    {/if}
    <div class="ask-actions">
      {#if !todo.done}
        {#each todo.choices ?? [] as choice, index (index)}
          <button type="button" class="choice" class:recommended={index === 0} title={index === 0 ? "The chat recommends this one" : undefined} onclick={() => answer(todo, choice)}>{choice}{#if index === 0}<span class="rec">recommended</span>{/if}</button>
        {/each}
      {/if}
      <span class="quiet-actions">
        {#if todo.done}
          <button type="button" class="quiet" onclick={() => setDone(false)}>Reopen</button>
        {:else}
          {#if todo.from === "agent" && answering?.id !== todo.id}<button type="button" class="quiet" onclick={() => { answering = { id: todo.id, text: "" }; }}>Reply</button>{/if}
          <button type="button" class="quiet" onclick={() => setDone(true)}>{todo.from === "agent" ? "Dismiss" : "Done"}</button>
        {/if}
        {#if todo.from === "owner"}<button type="button" class="quiet" onclick={() => void send([{ op: "todo_remove", id: todo.id }])}>Remove</button>{/if}
      </span>
    </div>
  </li>
{/snippet}

{#snippet noteRow(row: TreeRow<ScratchItem>)}
  {#if row.kind === "item"}
    {@const item = row.item}
    {@const open = view.open(item.id)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <li class="note" style:--depth={row.depth} ondblclick={onRowDblClick(item.id)}>
      <span class="row-lead">
        {@render foldButton(item, open)}
        <IdChip chat={id} id={item.id} />
      </span>
      <div class="note-body">
        <p class="note-text">{item.text}{#if item.children.length && !open}<span class="progress">{item.children.length} under it</span>{/if}</p>
        {#if item.links.length}
          <div class="chips">
            {#each item.links as link, index (link.target + index)}
              {@const chip = linkChip(link)}
              {#if chip.target}
                {@const target = chip.target}
                <button type="button" class="link-chip {chip.kind}" title={target.kind === "job" ? undefined : link.target} data-preview-chat={id} data-preview-job={target.kind === "job" ? target.name : undefined} onclick={() => store.openArtifact(target, id)}><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></button>
              {:else}
                <span class="link-chip broken" title="This link cannot be opened: {link.target}"><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></span>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
      <span class="note-actions">
        {@render openRow(item.id)}
        <button type="button" class="icon-button small" aria-label="Add a note under {item.text}" use:tooltip={"Add a note under this"} onclick={() => addUnder(item)}><Icon name="plus" /></button>
        <button type="button" class="icon-button small" aria-label="Remove note {item.text}" onclick={() => void send([{ op: "scratch_remove", id: item.id }])}><Icon name="x" /></button>
      </span>
    </li>
  {/if}
{/snippet}

{#snippet addNoteField()}
  <div class="add-note">
    {#if noteParent || noteLinks.length}
      <div class="chips pending">
        {#if noteParent}
          <span class="link-chip under" title="The new note goes under {noteParent.id}">under <IdChip chat={id} id={noteParent.id} />
            <button type="button" class="chip-x" aria-label="Add at the top level instead" onclick={() => { noteParent = null; }}><Icon name="x" size={10} /></button></span>
        {/if}
        {#each noteLinks as link, index (link.target + index)}
          {@const chip = linkChip(link)}
          <span class="link-chip {chip.kind}" title={link.target}><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span>
            <button type="button" class="chip-x" aria-label="Drop link {chip.label}" onclick={() => { noteLinks = noteLinks.filter((_, at) => at !== index); }}><Icon name="x" size={10} /></button></span>
        {/each}
      </div>
    {/if}
    <input class="field add" bind:this={noteField} bind:value={noteDraft} placeholder={noteLinks.length || noteParent ? "Note text, Enter saves" : "Add a note, paste a link or a path to attach it"} aria-label="Add a note" enterkeyhint="send"
      onkeydown={onKey(addNote, clearNote)} />
    {#if offer}
      <button type="button" class="offer" onclick={attachOffer}><Icon name="link" size={12} />Attach <span class="offer-target">{linkLabel(offer.target)}</span> as a link</button>
    {/if}
  </div>
{/snippet}

{#snippet planBody()}
  {#if board?.plan.length}
    <ul class="plan-list">{#each planRows as row (row.kind === "item" ? row.item.id : `${row.parent}/done`)}{@render planRow(row)}{/each}</ul>
  {:else}<p class="none">No plan yet.</p>{/if}
{/snippet}
{#snippet forYouBody()}
  <ul class="todos">
    {#each todos.open as todo (todo.id)}{@render todoRow(todo)}{/each}
    {#if !todos.open.length}<li class="none">Nothing waiting on you.</li>{/if}
  </ul>
  {#if todos.done.length}
    <button type="button" class="done-fold" aria-expanded={doneOpen} onclick={() => { doneOpen = !doneOpen; }}><span class="chev" class:open={doneOpen}><Icon name="chevronDown" size={11} /></span>Done ({todos.done.length})</button>
    {#if doneOpen}<ul class="todos">{#each todos.done as todo (todo.id)}{@render todoRow(todo)}{/each}</ul>{/if}
  {/if}
{/snippet}
{#snippet agentsBody()}
  {#if agents.length}
    <ul class="agent-list">
      {#each agents as agent (agent.key)}
        <li>
          <button type="button" class="agent" title={agentTitle(agent)} data-preview-chat={id} data-preview-job={agent.job} onclick={() => onagent(agent)}>
            <span class="agent-state">{#if agent.state === "working"}<span class="spinner tiny"></span>{:else}<span class="agent-dot {agent.state}"></span>{/if}</span>
            <span class="agent-name">{agent.name}</span>
            {#if agent.activity}<span class="agent-activity" class:failed={agent.state === "failed"}>{agent.activity}</span>{/if}
            {#if agent.rate}<span class="agent-rate" class:live={agent.rate.live && agent.state === "working"} title={agent.rate.live && agent.state === "working" ? "Output tokens per second now" : "Output tokens per second of its last turn"}>{rateText(agent.rate.tps)}</span>{/if}
            {#if agentAge(agent)}<span class="agent-age">{agentAge(agent)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else}<p class="none">No agents yet.</p>{/if}
{/snippet}
{#snippet notesBody()}
  {#if scratch.length}<ul class="note-list">{#each noteRows as row (row.kind === "item" ? row.item.id : `${row.parent}/done`)}{@render noteRow(row)}{/each}</ul>{/if}
  {@render addNoteField()}
{/snippet}

{#snippet dutiesBody()}<DutyList chat={id} {duties} {now} />{/snippet}
{#snippet dutiesCard()}
  {#if duties.views.length}{@render card("duties", "Duties", dutiesCount(duties.views), dutiesOpen, () => ui.setBoardCard("duties", !dutiesOpen), dutiesBody)}{/if}
{/snippet}

<div class="board">
  {#if isEmptyBoard(board)}
    <p class="empty">The plan, the chat's questions and its notes show up here once it starts work.</p>
    {@render dutiesCard()}
    {#if agents.length}{@render card("agents", "Agents", agentsCount, agentsOpen, () => ui.setBoardCard("agents", !agentsOpen), agentsBody)}{/if}
    {@render addNoteField()}
  {:else}
    {@render card("plan", "Plan", totals.total ? `${totals.done} of ${totals.total} done` : "", planOpen, () => ui.setBoardCard("plan", !planOpen), planBody, true)}
    {@render card("foryou", "For you", openCount ? `${openCount} open` : "", forYouOpen, () => { forYouOpen = !forYouOpen; }, forYouBody)}
    {@render dutiesCard()}
    {@render card("agents", "Agents", agentsCount, agentsOpen, () => ui.setBoardCard("agents", !agentsOpen), agentsBody)}
    {@render card("notes", "Notes", noteCount ? String(noteCount) : "", notesOpen, () => ui.setBoardCard("notes", !notesOpen), notesBody, true)}
  {/if}
  <p class="check-in" class:on={checkIn.on}><Icon name="bolt" size={12} /><span>{checkIn.text}</span></p>
</div>

<style>
  .board { display: flex; flex-direction: column; gap: 10px; padding: 10px 10px 20px; font-size: 13px; }
  .island { border-radius: var(--radius); background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow-small); }
  /* The header: the title button stretches over the whole row (its ::after), so the chevron area folds too; the Open plan button sits above it. */
  .island-head { position: relative; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 0; border-radius: var(--radius); }
  .island-head:hover { background: var(--bg-hover); }
  .island.open > .island-head { border-radius: var(--radius) var(--radius) 0 0; }
  .island-toggle { display: flex; flex: 1; min-width: 0; align-items: center; gap: 8px; padding: 9px 0 9px 12px; text-align: left; border-radius: inherit; }
  .island-toggle::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
  .island-toggle:focus-visible { outline: none; }
  .island-toggle:focus-visible::after { outline: 2px solid var(--accent); outline-offset: -2px; }
  .island-title { font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .island-count { font-size: 11px; font-weight: 500; color: var(--accent-bold); font-variant-numeric: tabular-nums; }
  .icon-button.island-open { position: relative; z-index: 1; width: 22px; height: 22px; color: var(--text-faint); opacity: 0; }
  .island-head:hover .island-open, .island-open:focus-visible, .island-head:focus-within .island-open { opacity: 1; }
  .island-head .chev { color: var(--text-faint); }
  .island-body { padding: 2px 12px 12px; }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .empty, .none { margin: 0; padding: 4px 0; color: var(--text-faint); font-size: 12.5px; line-height: 1.5; }
  .empty { padding: 24px 8px; text-align: center; }
  .plan-list, .note-list { list-style: none; margin: 0; padding: 0; }
  .note-list { margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
  /*
   * A row: a fixed lead (the fold, the status mark, the id chip; 18 px inline boxes) and the text block beside it, so a wrapped line and the
   * note under it start where the text starts. Indents stop growing at 25% of the card, so a 10-deep chain stays readable at the default width.
   */
  .plan-item, .note { position: relative; display: flex; align-items: flex-start; gap: 4px; padding-left: min(calc(var(--depth) * 14px), 25%); }
  .plan-item { padding-top: 3px; padding-bottom: 3px; }
  .row-lead { display: inline-flex; flex: none; align-items: center; height: 18px; gap: 2px; }
  .row-body { flex: 1; min-width: 0; }
  .plan-line { margin: 0; line-height: 18px; overflow-wrap: anywhere; }
  .fold { display: inline-flex; vertical-align: top; width: 14px; height: 18px; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 4px; }
  button.fold:hover { background: var(--bg-hover); color: var(--text); }
  .plan-text.linked { cursor: pointer; border-radius: 3px; }
  .plan-text.linked:hover, .plan-text.linked:focus-visible { text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 0.16em; }
  .plan-item.done .plan-text { color: var(--text-muted); }
  .plan-item.dropped .plan-text { color: var(--text-faint); text-decoration: line-through; }
  /* The counter and the wait follow the text after a space; no margin, so a wrapped counter starts under the text. */
  .progress, .wait { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wait { white-space: normal; }
  /*
   * The row's buttons (open in plan view; on a note also add under and remove) sit over the row's top right corner, out of the text flow, with
   * a fade so they read over a long first line. They show on hover and focus.
   */
  .plan-item > .row-open, .note-actions { position: absolute; top: 3px; right: -4px; height: 18px; border-radius: 4px; color: var(--text-faint); background: var(--bg-elevated); box-shadow: -8px 0 6px -2px var(--bg-elevated); opacity: 0; }
  .plan-item > .row-open { width: 20px; padding-left: 2px; }
  .icon-button.row-open :global(svg) { width: 12px; height: 12px; }
  .note-actions { top: 0; display: inline-flex; align-items: center; }
  .note-actions .icon-button { height: 18px; }
  .plan-item:hover > .row-open, .plan-item > .row-open:focus-visible, .note:hover > .note-actions, .note-actions:focus-within { opacity: 1; }
  .finished { list-style: none; padding-left: calc(min(calc(var(--depth) * 14px), 25%) + 14px); }
  .finished .done-fold { margin-top: 2px; }
  .plan-note { margin: 0; padding: 0 0 2px; font-size: 12px; line-height: 1.45; color: var(--text-faint); overflow-wrap: anywhere; }
  /*
   * For you: each ask is its question in the plan's type, the chat's choices in one wrapping row under it (the first one tinted and marked
   * recommended, all 24 px tall), and the quiet text actions (Reply, Dismiss or Done, Remove, Reopen) at the end of that row.
   */
  .todos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  /* `.ask`, not `.todo`: a plan row carries its status as a class, and "todo" is one of them. */
  .ask { display: flex; flex-direction: column; gap: 6px; padding: 5px 0; }
  .ask + .ask { border-top: 1px solid var(--border); padding-top: 9px; }
  .ask-line { display: flex; align-items: flex-start; gap: 4px; }
  .ask-text { flex: 1; min-width: 0; text-align: left; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
  .ask-text :global(a), .ask-text :global(.artifact-link) { display: inline; text-align: left; color: var(--accent); text-decoration: underline; text-underline-offset: 0.15em; font: inherit; padding: 0; margin: 0; cursor: pointer; overflow-wrap: anywhere; word-break: break-word; }
  .ask-text :global(code) { font-family: var(--mono); font-size: 0.9em; }
  .ask-line .edit { flex: none; width: 22px; height: 22px; color: var(--text-faint); opacity: 0; transition: opacity 0.12s; }
  .ask:hover .ask-line .edit, .ask-line .edit:focus-visible { opacity: 1; }
  @media (hover: none) { .ask-line .edit { opacity: 1; } }
  .ask.done .ask-text { color: var(--text-muted); }
  .ask.done.mine .ask-text { color: var(--text-faint); text-decoration: line-through; }
  .field.inline { width: 100%; min-width: 0; height: 26px; font-size: 13px; padding: 0 8px; }
  .ask-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .choice { display: inline-block; max-width: 100%; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg); font-size: 12px; line-height: 16px; text-align: left; overflow-wrap: anywhere; }
  .choice:hover { border-color: var(--accent); color: var(--accent-bold); background: var(--accent-soft); }
  .choice.recommended { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)); background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg)); }
  .rec { margin-left: 6px; font-size: 10.5px; color: var(--text-faint); white-space: nowrap; }
  .quiet-actions { display: inline-flex; gap: 2px; margin-left: auto; }
  .choice:hover .rec { color: var(--accent-bold); }
  .quiet { padding: 2px 4px; border-radius: 4px; font-size: 12px; color: var(--text-faint); }
  .quiet:hover { color: var(--accent-bold); background: var(--bg-hover); }
  .reply { display: block; align-self: flex-start; max-width: 100%; margin: -2px 0 0; padding: 2px 6px; border-radius: 4px; text-align: left; font-size: 12.5px; line-height: 1.45; color: var(--text-muted); overflow-wrap: anywhere; }
  .reply:hover { background: var(--bg-hover); }
  .reply-lead { font-weight: 600; }
  .done-fold { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 2px 4px; border-radius: 4px; font-size: 12px; color: var(--text-faint); }
  .done-fold:hover { color: var(--text); background: var(--bg-hover); }
  .done-fold + .todos { margin-top: 4px; }
  /* An agent row reads like a sidebar job row: the dot column, the name, the activity fading out, the age at the right edge. */
  .agent-list { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .agent { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 3px 6px; border-radius: var(--radius-small); text-align: left; line-height: 18px; }
  .agent:hover { background: var(--bg-hover); }
  .agent-state { display: inline-flex; flex: none; width: 12px; justify-content: center; }
  .agent-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .agent-dot.idle { background: var(--success); }
  .agent-dot.waiting { background: var(--warning); }
  .agent-dot.failed { background: var(--danger); }
  .agent-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-activity { flex: 1; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--text-faint); }
  .agent-activity.failed { color: var(--danger); }
  .agent-rate { flex: none; margin-left: auto; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .agent-rate.live { color: var(--accent-bold); }
  .agent-rate + .agent-age { margin-left: 0; }
  .agent-age { flex: none; margin-left: auto; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .link-chip.under { gap: 2px; padding-right: 4px; }
  .link-chip.under :global(.id-chip) { opacity: 1; }
  .note-body { flex: 1; min-width: 0; }
  .note-text { margin: 0; line-height: 18px; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .chip-x { display: inline-flex; margin: 0 -3px 0 0; padding: 2px; border-radius: 50%; color: var(--text-faint); }
  .chip-x:hover { color: var(--danger); background: var(--bg-hover); }
  .add-note { display: flex; flex-direction: column; gap: 5px; }
  .chips.pending { margin: 0; }
  .field.add { width: 100%; height: 30px; font-size: 13px; }
  .offer { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-strong); font-size: 12px; color: var(--text-muted); }
  .offer:hover { color: var(--accent-bold); border-color: var(--accent); background: var(--accent-soft); }
  .offer-target { font-weight: 600; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check-in { display: flex; align-items: center; gap: 6px; margin: 0; padding: 2px 4px; font-size: 11.5px; color: var(--text-faint); }
  .check-in.on { color: var(--text-muted); }
  @container app (max-width: 899px) {
    .board { padding: 10px 8px 20px; }
  }
</style>
