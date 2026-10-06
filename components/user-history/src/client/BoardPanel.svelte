<script lang="ts">
  import { applyBoardOp, emptyBoard, nextIds } from "../shared/chat-board.ts";
  import type { BoardOp, ChatBoard, OwnerTodo, PlanItem } from "../shared/types.ts";
  import { isEmptyBoard, orderTodos, planProgress, PLAN_STATUS_LABEL } from "./board.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import Checkbox from "./ui/Checkbox.svelte";
  import Icon from "./Icon.svelte";

  /**
   * The chat's board: the plan the chat keeps (read-only here), the things it needs from the owner (editable), and its scratchpad.
   * `apply` gets the board after the owner's ops and the ops themselves; it resolves false when the server refused them.
   */
  let { board, cwd = "", onjob, apply }: {
    board: ChatBoard | null; cwd?: string; onjob: (name: string) => void; apply: (next: ChatBoard, ops: BoardOp[]) => Promise<boolean>;
  } = $props();

  const todos = $derived(board ? orderTodos(board.todos) : []);
  const openCount = $derived(todos.filter(todo => !todo.done).length);

  function send(ops: BoardOp[]): Promise<boolean> {
    let next = board ?? emptyBoard(new Date().toISOString());
    const newId = nextIds(next);
    for (const op of ops) next = applyBoardOp(next, op, "owner", new Date().toISOString(), newId).board;
    return apply(next, ops);
  }

  let folded = $state<Record<string, true>>({});
  const fold = (id: string) => { const { [id]: was, ...rest } = folded; folded = was ? rest : { ...rest, [id]: true }; };

  let editing = $state<{ id: string; text: string } | null>(null);
  let answering = $state<{ id: string; text: string } | null>(null);
  let note = $state("");
  function saveEdit(): void {
    const draft = editing;
    editing = null;
    if (!draft) return;
    const text = draft.text.trim();
    const todo = board?.todos.find(entry => entry.id === draft.id);
    if (!todo || !text || text === todo.text) return;
    void send([{ op: "todo_update", id: draft.id, text }]);
  }
  function saveAnswer(): void {
    const draft = answering;
    answering = null;
    if (!draft) return;
    const reply = draft.text.trim();
    const todo = board?.todos.find(entry => entry.id === draft.id);
    if (!todo || reply === (todo.reply ?? "")) return;
    void send([{ op: "todo_update", id: draft.id, reply: reply || null }]);
  }
  function addNote(): void {
    const text = note.trim();
    if (!text) return;
    note = "";
    void send([{ op: "todo_add", text }]).then(ok => { if (!ok && !note.trim()) note = text; });
  }
  const onKey = (save: () => void, cancel: () => void) => (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); save(); }
    else if (event.key === "Escape") { event.stopPropagation(); cancel(); }
  };
  function focusEnd(node: HTMLInputElement | HTMLTextAreaElement): void { node.focus(); node.setSelectionRange(node.value.length, node.value.length); }

  const SCRATCH_LINES = 6;
  let scratchOpen = $state(false);
  const scratchHtml = $derived(board?.scratchpad.trim() ? renderMarkdown(board.scratchpad, cwd) : "");
  const scratchLong = $derived((board?.scratchpad ?? "").split("\n").length > SCRATCH_LINES || (board?.scratchpad.length ?? 0) > 420);
  const todoLabel = (todo: OwnerTodo) => todo.from === "owner" ? "Your note" : "Ask from the chat";
</script>

{#snippet planRow(item: PlanItem, depth: number)}
  {@const progress = planProgress(item)}
  {@const open = !folded[item.id]}
  <li class="plan-item {item.status}" style:--depth={depth}>
    <div class="plan-line">
      {#if item.children.length}
        <button type="button" class="fold" aria-expanded={open} aria-label="{open ? 'Fold' : 'Unfold'} {item.text}" onclick={() => fold(item.id)}><span class="chev" class:open><Icon name="chevronDown" size={11} /></span></button>
      {:else}<span class="fold"></span>{/if}
      <span class="status" title={PLAN_STATUS_LABEL[item.status]} role="img" aria-label={PLAN_STATUS_LABEL[item.status]}>
        {#if item.status === "doing"}<span class="spinner tiny"></span>
        {:else if item.status === "done"}<span class="mark done"><Icon name="check" size={10} /></span>
        {:else}<span class="mark {item.status}"></span>{/if}
      </span>
      <span class="plan-text">{item.text}</span>
      {#if progress}<span class="progress">{progress.done} of {progress.total} done</span>{/if}
      {#if item.job}<button type="button" class="job-chip" title="Open job {item.job}" onclick={() => onjob(item.job!)}>{item.job}</button>{/if}
    </div>
    {#if item.note}<div class="plan-note">{item.note}</div>{/if}
    {#if item.children.length && open}
      <ul class="plan">{#each item.children as child (child.id)}{@render planRow(child, depth + 1)}{/each}</ul>
    {/if}
  </li>
{/snippet}

<div class="board">
  {#if isEmptyBoard(board)}
    <p class="empty">The plan, notes and things for you show up here once the chat starts work.</p>
    <input class="field add" bind:value={note} placeholder="Add a note for the agent" aria-label="Add a note for the agent" enterkeyhint="send"
      onkeydown={onKey(addNote, () => { note = ""; })} />
  {:else if board}
    <section>
      <h3>Plan</h3>
      {#if board.plan.length}
        <ul class="plan root">{#each board.plan as item (item.id)}{@render planRow(item, 0)}{/each}</ul>
      {:else}<p class="none">No plan yet.</p>{/if}
    </section>
    <section>
      <h3>For you{#if openCount}<span class="count">{openCount} open</span>{/if}</h3>
      <ul class="todos">
        {#each todos as todo (todo.id)}
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
            {#if answering?.id === todo.id}
              <div class="answer-row">
                <input class="field inline" bind:value={answering.text} placeholder="Your answer" aria-label="Answer to {todo.text}" use:focusEnd onkeydown={onKey(saveAnswer, () => { answering = null; })} onblur={saveAnswer} />
              </div>
            {:else if todo.reply}
              <button type="button" class="reply" title="Click to change your answer" onclick={() => { answering = { id: todo.id, text: todo.reply ?? "" }; }}><span class="reply-lead">You:</span> {todo.reply}</button>
            {:else if !todo.done && todo.from === "agent"}
              <button type="button" class="answer" onclick={() => { answering = { id: todo.id, text: "" }; }}>Answer</button>
            {/if}
          </li>
        {/each}
        {#if !todos.length}<li class="none">Nothing waiting on you.</li>{/if}
      </ul>
      <input class="field add" bind:value={note} placeholder="Add a note for the agent" aria-label="Add a note for the agent" enterkeyhint="send"
        onkeydown={onKey(addNote, () => { note = ""; })} />
    </section>
    <section>
      <h3>Scratchpad</h3>
      {#if scratchHtml}
        <div class="scratch" class:folded={scratchLong && !scratchOpen} style:--lines={SCRATCH_LINES}>
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose small" onclick={copyFromClick}>{@html scratchHtml}</div>
        </div>
        {#if scratchLong}<button type="button" class="more" onclick={() => { scratchOpen = !scratchOpen; }}>{scratchOpen ? "Less" : "More"}</button>{/if}
      {:else}<p class="none">Empty.</p>{/if}
    </section>
  {/if}
</div>

<style>
  .board { display: flex; flex-direction: column; gap: 18px; padding: 12px 12px 20px; font-size: 13px; }
  h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .count { font-size: 11px; font-weight: 500; color: var(--accent-bold); text-transform: none; letter-spacing: 0; }
  .empty, .none { margin: 0; padding: 4px 0; color: var(--text-faint); font-size: 12.5px; line-height: 1.5; }
  .empty { padding: 24px 8px; text-align: center; }
  .plan { list-style: none; margin: 0; padding: 0; }
  .plan-line { display: flex; align-items: flex-start; gap: 5px; padding: 3px 0 3px calc(var(--depth) * 16px); line-height: 18px; }
  .fold { display: inline-flex; flex: none; width: 14px; height: 18px; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 4px; }
  button.fold:hover { background: var(--bg-hover); color: var(--text); }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .status { display: inline-flex; flex: none; width: 14px; height: 18px; align-items: center; justify-content: center; }
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--border-strong); box-sizing: border-box; }
  .mark.done { width: 13px; height: 13px; border: 0; background: var(--success); color: #fff; }
  .mark.blocked { border: 0; background: var(--danger); }
  .mark.dropped { border-style: dashed; opacity: 0.6; }
  .plan-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .plan-item.done > .plan-line > .plan-text { color: var(--text-muted); }
  .plan-item.dropped > .plan-line > .plan-text { color: var(--text-faint); text-decoration: line-through; }
  .plan-item.blocked > .plan-line > .plan-text { color: var(--danger); }
  .progress { flex: none; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .job-chip { flex: none; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 7px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--bg-elevated); font-size: 11px; line-height: 17px; color: var(--text-muted); font-family: var(--mono); }
  .job-chip:hover { border-color: var(--accent); color: var(--accent-bold); }
  .plan-note { padding: 0 0 4px calc(var(--depth) * 16px + 38px); font-size: 12px; line-height: 1.45; color: var(--text-faint); overflow-wrap: anywhere; }
  .todos { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .todo { padding: 3px 0; border-radius: var(--radius-small); }
  .todo-line { display: flex; align-items: flex-start; gap: 6px; }
  .todo-line :global(.checkbox) { flex: none; margin-top: -1px; }
  .todo-text { flex: 1; min-width: 0; text-align: left; line-height: 18px; overflow-wrap: anywhere; border-radius: 4px; padding: 0 3px; margin: 0 -3px; }
  .todo-text:hover { background: var(--bg-hover); }
  .todo.done .todo-text { color: var(--text-faint); text-decoration: line-through; }
  .todo.mine .todo-text { color: var(--text-muted); }
  .remove { flex: none; opacity: 0; }
  .todo:hover .remove, .remove:focus-visible { opacity: 1; }
  .field.inline { flex: 1; min-width: 0; height: 24px; font-size: 13px; padding: 0 6px; }
  .answer-row { padding: 4px 0 2px 26px; display: flex; }
  .answer { margin: 1px 0 0 26px; padding: 1px 7px; border-radius: 999px; border: 1px dashed var(--border-strong); font-size: 11.5px; color: var(--text-faint); }
  .answer:hover { color: var(--accent-bold); border-color: var(--accent); border-style: solid; }
  .reply { display: block; margin: 2px 0 0 26px; padding: 2px 6px; border-radius: 4px; text-align: left; font-size: 12.5px; line-height: 1.45; color: var(--text-muted); overflow-wrap: anywhere; }
  .reply:hover { background: var(--bg-hover); }
  .reply-lead { font-weight: 600; }
  .field.add { width: 100%; height: 30px; font-size: 13px; }
  .scratch { position: relative; }
  .scratch.folded { max-height: calc(var(--lines) * 1.6em); overflow: hidden; }
  .scratch.folded::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2em; background: linear-gradient(to bottom, transparent, var(--bg-sunken)); }
  .prose.small { font-size: 13px; line-height: 1.6; }
  .prose.small :global(h1), .prose.small :global(h2), .prose.small :global(h3), .prose.small :global(h4) { font-size: 1.04em; margin: 1em 0 0.4em; }
  .prose.small :global(p), .prose.small :global(ul), .prose.small :global(ol) { margin-bottom: 0.6em; }
  .more { margin-top: 4px; padding: 2px 8px; border-radius: var(--radius-small); font-size: 12px; color: var(--accent-bold); }
  .more:hover { background: var(--accent-soft); }
</style>
