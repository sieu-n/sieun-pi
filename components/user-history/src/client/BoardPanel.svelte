<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { applyBoardOp, emptyBoard, nextIds } from "../shared/chat-board.ts";
  import type { ArtifactLink, BoardOp, ChatBoard, OwnerTodo, PlanItem, ScratchItem } from "../shared/types.ts";
  import { countItems, groupTodos, idColor, isEmptyBoard, isFinished, linkChip, linkLabel, offeredLink, planProgress, planTotals, PLAN_STATUS_LABEL, treeRows, type TreeRow, type TreeView } from "./board.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import Checkbox from "./ui/Checkbox.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The chat's board as three cards: the plan the chat keeps (read-only here), For you (the chat's asks, answered by a tap on a choice
   * or a typed reply), and Notes (nested notes with links to jobs, messages, wiki pages, files and web pages; the owner adds and removes notes).
   * Plan steps and notes are trees: everything with children starts folded, done and dropped steps hide behind "Show done" per parent, and
   * each item carries its id chip (the id the chat uses, with a color hashed from the chat and item ids; a click copies the id).
   * A row reads as one paragraph: the fold, the status mark and the chip sit inline before the text, and a wrapped line comes back to the row's
   * left edge. A note's link opens through `store.openArtifact` (the reader, the thread, or a tab); the text of a plan step with an owner
   * (`item.job`) is a link that `onjob` resolves (the job drawer, or the owner's own thread). `checkIn` is the server's 5-minute tick line
   * under the cards. `apply` gets the board after the owner's ops and the ops themselves; it resolves false when the server refused them.
   */
  let { id, board, checkIn, onjob, apply }: {
    id: string; board: ChatBoard | null; checkIn: { text: string; on: boolean }; onjob: (name: string) => void; apply: (next: ChatBoard, ops: BoardOp[]) => Promise<boolean>;
  } = $props();

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
  let copied = $state<string | null>(null);
  function copyId(itemId: string): void {
    void navigator.clipboard?.writeText(itemId);
    copied = itemId;
    setTimeout(() => { if (copied === itemId) copied = null; }, 1200);
  }

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
  const onStepKey = (job: string) => (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onjob(job); } };
</script>

{#snippet card(key: "plan" | "foryou" | "notes", title: string, count: string, open: boolean, toggle: () => void, body: Snippet)}
  <section class="island {key}" class:open>
    <button type="button" class="island-head" aria-expanded={open} onclick={toggle}>
      <span class="island-title">{title}</span>
      {#if count}<span class="island-count">{count}</span>{/if}
      <span class="chev" class:open><Icon name="chevronDown" size={13} /></span>
    </button>
    {#if open}<div class="island-body">{@render body()}</div>{/if}
  </section>
{/snippet}

{#snippet idChip(itemId: string)}
  <button type="button" class="id-chip" class:copied={copied === itemId} style:--dot={idColor(id, itemId)} aria-label="Copy the id {itemId}"
    title={copied === itemId ? "Copied" : `Copy ${itemId}`} onclick={() => copyId(itemId)}><span class="dot" aria-hidden="true"></span>{itemId}</button>
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
    {@const open = view.open(item.id)}
    <li class="plan-item {item.status}" style:--depth={row.depth}>
      <p class="plan-line">
        {@render foldButton(item, open)}
        <span class="status" title={PLAN_STATUS_LABEL[item.status]} role="img" aria-label={PLAN_STATUS_LABEL[item.status]}>
          {#if item.status === "doing"}<span class="spinner tiny"></span>
          {:else if item.status === "done"}<span class="mark done"><Icon name="check" size={11} /></span>
          {:else}<span class="mark {item.status}"></span>{/if}
        </span>
        {@render idChip(item.id)}
        {#if item.job}
          {@const job = item.job}
          <span class="plan-text linked" role="button" tabindex="0" title="Open {job}" onclick={() => onjob(job)} onkeydown={onStepKey(job)}>{item.text}</span>
        {:else}<span class="plan-text">{item.text}</span>{/if}
        {#if progress}<span class="progress">{progress.done} of {progress.total} done</span>{/if}
      </p>
      {#if item.note}<p class="plan-note">{item.note}</p>{/if}
    </li>
  {/if}
{/snippet}

{#snippet todoRow(todo: OwnerTodo)}
  <li class="todo" class:done={todo.done} class:mine={todo.from === "owner"}>
    <div class="todo-line">
      <Checkbox checked={todo.done} label="{todo.done ? 'Reopen' : 'Done'}: {todo.text}" onchange={done => void send([{ op: "todo_update", id: todo.id, done }])} />
      {#if editing?.id === todo.id}
        <input class="field inline" bind:value={editing.text} aria-label="Edit {todo.text}" use:focusEnd onkeydown={onKey(saveEdit, () => { editing = null; })} onblur={saveEdit} />
      {:else}
        <button type="button" class="todo-text" title="{todoLabel(todo)}. Click to edit" onclick={() => { editing = { id: todo.id, text: todo.text }; }}>{todo.text}</button>
      {/if}
      {#if todo.from === "owner"}
        <button type="button" class="icon-button small remove" aria-label="Remove note {todo.text}" onclick={() => void send([{ op: "todo_remove", id: todo.id }])}><Icon name="x" /></button>
      {/if}
    </div>
    {#if !todo.done && todo.choices?.length}
      <div class="choices">
        {#each todo.choices as choice, index (index)}
          <button type="button" class="choice" class:recommended={index === 0} onclick={() => answer(todo, choice)}>{choice}{#if index === 0}<span class="rec">recommended</span>{/if}</button>
        {/each}
      </div>
    {/if}
    {#if answering?.id === todo.id}
      <div class="answer-row">
        <input class="field inline" bind:value={answering.text} placeholder="Your reply, Enter sends" aria-label="Reply to {todo.text}" use:focusEnd
          onkeydown={onKey(() => { if (answering) answer(todo, answering.text); }, () => { answering = null; })} />
      </div>
    {:else if todo.reply}
      <button type="button" class="reply" title="Click to change your answer" onclick={() => { answering = { id: todo.id, text: todo.reply ?? "" }; }}><span class="reply-lead">You:</span> {todo.reply}</button>
    {:else if !todo.done && todo.from === "agent"}
      <button type="button" class="reply-link" onclick={() => { answering = { id: todo.id, text: "" }; }}>Reply…</button>
    {/if}
  </li>
{/snippet}

{#snippet noteRow(row: TreeRow<ScratchItem>)}
  {#if row.kind === "item"}
    {@const item = row.item}
    {@const open = view.open(item.id)}
    <li class="note" style:--depth={row.depth}>
      <div class="note-body">
        <p class="note-text">
          {@render foldButton(item, open)}
          {@render idChip(item.id)}
          {item.text}{#if item.children.length && !open}<span class="progress">{item.children.length} under it</span>{/if}
        </p>
        {#if item.links.length}
          <div class="chips">
            {#each item.links as link, index (link.target + index)}
              {@const chip = linkChip(link)}
              {#if chip.target}
                {@const target = chip.target}
                <button type="button" class="link-chip {chip.kind}" title={link.target} onclick={() => store.openArtifact(target, id)}><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></button>
              {:else}
                <span class="link-chip broken" title="This link cannot be opened: {link.target}"><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></span>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
      <span class="note-actions">
        <button type="button" class="icon-button small remove" aria-label="Add a note under {item.text}" use:tooltip={"Add a note under this"} onclick={() => addUnder(item)}><Icon name="plus" /></button>
        <button type="button" class="icon-button small remove" aria-label="Remove note {item.text}" onclick={() => void send([{ op: "scratch_remove", id: item.id }])}><Icon name="x" /></button>
      </span>
    </li>
  {/if}
{/snippet}

{#snippet addNoteField()}
  <div class="add-note">
    {#if noteParent || noteLinks.length}
      <div class="chips pending">
        {#if noteParent}
          <span class="link-chip under" title="The new note goes under {noteParent.id}">under {@render idChip(noteParent.id)}
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
    <ul class="plan">{#each planRows as row (row.kind === "item" ? row.item.id : `${row.parent}/done`)}{@render planRow(row)}{/each}</ul>
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
{#snippet notesBody()}
  {#if scratch.length}<ul class="notes">{#each noteRows as row (row.kind === "item" ? row.item.id : `${row.parent}/done`)}{@render noteRow(row)}{/each}</ul>{/if}
  {@render addNoteField()}
{/snippet}

<div class="board">
  {#if isEmptyBoard(board)}
    <p class="empty">The plan, the chat's questions and its notes show up here once it starts work.</p>
    {@render addNoteField()}
  {:else}
    {@render card("plan", "Plan", totals.total ? `${totals.done} of ${totals.total} done` : "", planOpen, () => ui.setBoardCard("plan", !planOpen), planBody)}
    {@render card("foryou", "For you", openCount ? `${openCount} open` : "", forYouOpen, () => { forYouOpen = !forYouOpen; }, forYouBody)}
    {@render card("notes", "Notes", noteCount ? String(noteCount) : "", notesOpen, () => ui.setBoardCard("notes", !notesOpen), notesBody)}
  {/if}
  <p class="check-in" class:on={checkIn.on}><Icon name="bolt" size={12} /><span>{checkIn.text}</span></p>
</div>

<style>
  .board { display: flex; flex-direction: column; gap: 10px; padding: 10px 10px 20px; font-size: 13px; }
  .island { border-radius: var(--radius); background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow-small); }
  .island-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px 9px 12px; border-radius: var(--radius); text-align: left; }
  .island-head:hover { background: var(--bg-hover); }
  .island.open > .island-head { border-radius: var(--radius) var(--radius) 0 0; }
  .island-title { font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .island-count { font-size: 11px; font-weight: 500; color: var(--accent-bold); font-variant-numeric: tabular-nums; }
  .island-head .chev { margin-left: auto; color: var(--text-faint); }
  .island-body { padding: 2px 12px 12px; }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .empty, .none { margin: 0; padding: 4px 0; color: var(--text-faint); font-size: 12.5px; line-height: 1.5; }
  .empty { padding: 24px 8px; text-align: center; }
  .plan { list-style: none; margin: 0; padding: 0; }
  /*
   * A row is a paragraph: the fold, the status mark and the id chip are 18 px inline boxes at the start of the text, so a wrapped line
   * comes back to the row's left edge. Indents stop growing at 25% of the card, so a 10-deep chain stays readable at the default width.
   */
  .plan-line { margin: 0; padding: 3px 0 3px min(calc(var(--depth) * 14px), 25%); line-height: 18px; overflow-wrap: anywhere; }
  .fold { display: inline-flex; vertical-align: top; width: 14px; height: 18px; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 4px; }
  button.fold:hover { background: var(--bg-hover); color: var(--text); }
  .status { display: inline-flex; vertical-align: top; width: 14px; height: 18px; align-items: center; justify-content: center; }
  .mark { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--border-strong); box-sizing: border-box; }
  .mark.done { width: 13px; height: 13px; border: 0; color: color-mix(in srgb, var(--success) 70%, var(--text-muted)); }
  /* Blocked: a hollow ring with a slash, in the muted text color; the step text keeps its color. */
  .mark.blocked { width: 10px; height: 10px; border-color: var(--text-muted); }
  .mark.blocked::after { content: ""; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1.5px; margin-left: -0.75px; background: var(--text-muted); transform: rotate(45deg); }
  .mark.dropped { border-style: dashed; opacity: 0.6; }
  .plan-text.linked { cursor: pointer; border-radius: 3px; }
  .plan-text.linked:hover, .plan-text.linked:focus-visible { text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 0.16em; }
  .plan-item.done > .plan-line > .plan-text { color: var(--text-muted); }
  .plan-item.dropped > .plan-line > .plan-text { color: var(--text-faint); text-decoration: line-through; }
  .progress { margin-left: 4px; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .id-chip { display: inline-flex; vertical-align: top; align-items: center; gap: 4px; height: 18px; padding: 0 3px; margin: 0 -1px; border-radius: 4px; font-family: var(--mono); font-size: 11px; line-height: 18px; color: var(--text); opacity: 0.6; font-variant-numeric: tabular-nums; }
  .id-chip:hover, .id-chip:focus-visible { opacity: 1; background: var(--bg-hover); }
  .id-chip.copied { opacity: 1; color: var(--accent-bold); }
  .id-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot); }
  .finished { list-style: none; padding-left: calc(min(calc(var(--depth) * 14px), 25%) + 14px); }
  .finished .done-fold { margin-top: 2px; }
  .plan-note { margin: 0; padding: 0 0 4px min(calc(var(--depth) * 14px), 25%); font-size: 12px; line-height: 1.45; color: var(--text-faint); overflow-wrap: anywhere; }
  .todos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .todo { padding: 3px 0; }
  .todo-line { display: flex; align-items: flex-start; gap: 6px; }
  .todo-line :global(.checkbox) { flex: none; margin-top: -1px; }
  .todo-text { flex: 1; min-width: 0; text-align: left; line-height: 18px; overflow-wrap: anywhere; border-radius: 4px; padding: 0 3px; margin: 0 -3px; }
  .todo-text:hover { background: var(--bg-hover); }
  .todo.done .todo-text { color: var(--text-faint); text-decoration: line-through; }
  .todo.mine .todo-text { color: var(--text-muted); }
  .remove { flex: none; opacity: 0; }
  .todo:hover .remove, .note:hover .remove, .remove:focus-visible { opacity: 1; }
  .field.inline { flex: 1; min-width: 0; height: 26px; font-size: 13px; padding: 0 8px; }
  .choices { display: flex; flex-wrap: wrap; gap: 5px; padding: 5px 0 2px 26px; }
  .choice { display: inline-block; max-width: 100%; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--bg); font-size: 12px; line-height: 16px; text-align: left; overflow-wrap: anywhere; }
  .choice:hover { border-color: var(--accent); color: var(--accent-bold); background: var(--accent-soft); }
  .choice.recommended { border-color: color-mix(in srgb, var(--accent) 50%, var(--border-strong)); }
  .rec { margin-left: 6px; font-size: 10px; font-weight: 500; color: var(--accent-bold); text-transform: uppercase; letter-spacing: 0.04em; }
  .answer-row { padding: 4px 0 2px 26px; display: flex; }
  .reply-link { margin: 2px 0 0 26px; padding: 1px 3px; border-radius: 4px; font-size: 12px; color: var(--text-faint); }
  .reply-link:hover { color: var(--accent-bold); background: var(--bg-hover); }
  .reply { display: block; margin: 2px 0 0 26px; padding: 2px 6px; border-radius: 4px; text-align: left; font-size: 12.5px; line-height: 1.45; color: var(--text-muted); overflow-wrap: anywhere; }
  .reply:hover { background: var(--bg-hover); }
  .reply-lead { font-weight: 600; }
  .done-fold { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 2px 4px; border-radius: 4px; font-size: 12px; color: var(--text-faint); }
  .done-fold:hover { color: var(--text); background: var(--bg-hover); }
  .done-fold + .todos { margin-top: 4px; }
  .notes { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .note { display: flex; align-items: flex-start; gap: 4px; padding-left: min(calc(var(--depth) * 14px), 25%); }
  .note-actions { display: inline-flex; flex: none; }
  .link-chip.under { gap: 2px; padding-right: 4px; }
  .link-chip.under .id-chip { opacity: 1; }
  .note-body { flex: 1; min-width: 0; }
  .note-text { margin: 0; line-height: 18px; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .link-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 220px; padding: 0 7px 0 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-sunken); font-size: 11.5px; line-height: 18px; color: var(--text-muted); }
  button.link-chip:hover { border-color: var(--accent); color: var(--accent-bold); background: var(--accent-soft); }
  .link-chip.broken { border-style: dashed; color: var(--text-faint); }
  .chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
