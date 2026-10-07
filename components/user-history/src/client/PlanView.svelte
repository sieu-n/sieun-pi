<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ChatBoard, PlanItem, ScratchItem } from "../shared/types.ts";
  import { focusPlan, isFinished, linkChip, parentIds, planProgress, planTotals, treeRows, type TreeRow, type TreeView } from "./board.ts";
  import { store } from "./store.svelte.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import IdChip from "./IdChip.svelte";
  import PlanMark from "./PlanMark.svelte";
  import Checkbox from "./ui/Checkbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The whole board of a chat in one large modal: the plan as a tree with every level open, each step with its status mark, id chip, owner
   * (a chip that closes the view and has `onjob` open the job drawer or the owner's thread) and note; then the notes tree with its link chips. Done and dropped
   * steps stay hidden until "Show done" is on; one control folds or unfolds every parent. `focus` is the item the view opened on: its
   * parents unfold, done items show when it is one, and the row scrolls into view and lights up for 2 s. The board prop is live.
   */
  let { chat, board, focus, narrow, onjob, ownerName, previewJob, onclose }: {
    chat: string; board: ChatBoard | null; focus: string | null; narrow: boolean; onjob: (owner: string) => void; ownerName: (owner: string) => string; previewJob: (owner: string) => string | undefined; onclose: () => void;
  } = $props();

  const EMPTY_PLAN: PlanItem[] = [];
  const EMPTY_NOTES: ScratchItem[] = [];
  const plan = $derived(board?.plan ?? EMPTY_PLAN);
  const scratch = $derived(board?.scratch ?? EMPTY_NOTES);
  const totals = $derived(planTotals(plan));
  const hiddenCount = $derived(treeRows(plan, { open: () => true, showDone: () => true }, isFinished).filter(row => row.kind === "item" && isFinished(row.item)).length);
  let showDone = $state(false);
  /** Parents the owner folded here; everything starts open, and the choice lives only while the view is open. */
  let folded = $state.raw<Record<string, true>>({});
  const view: TreeView = { open: id => folded[id] !== true, showDone: () => showDone };
  const items = <T,>(rows: TreeRow<T>[]) => rows.filter((row): row is Extract<TreeRow<T>, { kind: "item" }> => row.kind === "item");
  const planRows = $derived(items(treeRows(plan, view, isFinished)));
  const noteRows = $derived(items(treeRows(scratch, view)));
  const parents = $derived([...parentIds(plan), ...parentIds(scratch)]);
  const anyFolded = $derived(parents.some(id => folded[id]));
  function fold(id: string, open: boolean): void {
    const { [id]: _was, ...rest } = folded;
    folded = open ? rest : { ...rest, [id]: true };
  }
  const foldAll = () => { folded = anyFolded ? {} : Object.fromEntries(parents.map(id => [id, true])); };

  let body: HTMLElement | undefined = $state();
  let lit = $state<string | null>(null);
  $effect(() => {
    const id = focus;
    if (!id) return;
    untrack(() => {
      const current = board;
      const target = current ? focusPlan(current, id) : null;
      if (!target) { store.toast(`${id} is not on this board.`, "info"); return; }
      if (target.showDone) showDone = true;
      if (target.unfold.some(parent => folded[parent])) folded = Object.fromEntries(Object.keys(folded).filter(key => !target.unfold.includes(key)).map(key => [key, true]));
      void tick().then(() => {
        body?.querySelector(`[data-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
        lit = id;
        setTimeout(() => { if (lit === id) lit = null; }, 2000);
      });
    });
  });
</script>

{#snippet foldButton(item: { id: string; text: string; children: unknown[] }, open: boolean)}
  {#if item.children.length}
    <button type="button" class="fold" aria-expanded={open} aria-label="{open ? 'Fold' : 'Unfold'} {item.text}" onclick={() => fold(item.id, !open)}><span class="chev" class:open><Icon name="chevronDown" size={12} /></span></button>
  {:else}<span class="fold"></span>{/if}
{/snippet}

<Modal title="Plan" icon="note" width="min(1100px, 94vw)" height="88vh" tall full={narrow} {onclose}>
  {#snippet header()}
    {#if totals.total}<span class="count">{totals.done} of {totals.total} done</span>{/if}
    <span class="tools">
      <button type="button" class="show-done" role="checkbox" aria-checked={showDone} onclick={() => { showDone = !showDone; }}><Checkbox checked={showDone} visual /><span>{hiddenCount ? `Show done (${hiddenCount})` : "Show done"}</span></button>
      <button type="button" class="button small" disabled={!parents.length} onclick={foldAll}><Icon name={anyFolded ? "expand" : "collapse"} size={12} />{anyFolded ? "Expand all" : "Collapse all"}</button>
    </span>
  {/snippet}
  <div class="view" bind:this={body}>
    <section class="section">
      <h3>Plan</h3>
      {#if planRows.length}
        <ul class="tree">
          {#each planRows as row (row.item.id)}
            {@const item = row.item}
            {@const progress = planProgress(item)}
            <li class="row plan {item.status}" class:lit={lit === item.id} data-item={item.id} style:--depth={row.depth}>
              <p class="line">
                {@render foldButton(item, view.open(item.id))}
                <PlanMark status={item.status} />
                <IdChip {chat} id={item.id} />
                <span class="text">{item.text}</span>
                {#if progress}<span class="progress">{progress.done} of {progress.total} done</span>{/if}
                {#if item.job}
                  {@const owner = item.job}
                  {@const preview = previewJob(owner)}
                  <button type="button" class="owner" title={preview ? undefined : "Open " + ownerName(owner)} data-preview-chat={chat} data-preview-job={preview} onclick={() => { onclose(); onjob(owner); }}><Icon name="bolt" size={11} /><span class="owner-name">{ownerName(owner)}</span></button>
                {/if}
              </p>
              {#if item.note}<p class="note">{item.note}</p>{/if}
            </li>
          {/each}
        </ul>
      {:else if plan.length}<p class="none">Every step is done. Turn on Show done to see them.</p>
      {:else}<p class="none">No plan yet.</p>{/if}
    </section>
    <section class="section">
      <h3>Notes</h3>
      {#if noteRows.length}
        <ul class="tree">
          {#each noteRows as row (row.item.id)}
            {@const item = row.item}
            <li class="row" class:lit={lit === item.id} data-item={item.id} style:--depth={row.depth}>
              <p class="line">
                {@render foldButton(item, view.open(item.id))}
                <IdChip {chat} id={item.id} />
                <span class="text">{item.text}</span>
                {#if item.children.length && !view.open(item.id)}<span class="progress">{item.children.length} under it</span>{/if}
              </p>
              {#if item.links.length}
                <div class="chips">
                  {#each item.links as link, index (link.target + index)}
                    {@const chip = linkChip(link)}
                    {#if chip.target}
                      {@const target = chip.target}
                      <button type="button" class="link-chip {chip.kind}" title={target.kind === "job" ? undefined : link.target} data-preview-chat={chat} data-preview-job={target.kind === "job" ? target.name : undefined} onclick={() => store.openArtifact(target, chat)}><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></button>
                    {:else}
                      <span class="link-chip broken" title="This link cannot be opened: {link.target}"><Icon name={chip.icon} size={11} /><span class="chip-label">{chip.label}</span></span>
                    {/if}
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}<p class="none">No notes yet.</p>{/if}
    </section>
  </div>
</Modal>

<style>
  .count { flex: none; font-size: 12px; color: var(--accent-bold); font-variant-numeric: tabular-nums; }
  .tools { display: flex; flex: 1; justify-content: flex-end; align-items: center; gap: 10px; min-width: 0; }
  .show-done { display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px 2px 4px; border-radius: var(--radius-small); font-size: 12.5px; color: var(--text-muted); white-space: nowrap; }
  .show-done:hover { background: var(--bg-hover); color: var(--text); }
  .tools .button { display: inline-flex; align-items: center; gap: 5px; }
  .view { padding: 8px 24px 40px; font-size: 14px; }
  .section + .section { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--border); }
  h3 { margin: 0 0 6px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .none { margin: 0; padding: 6px 0; color: var(--text-faint); font-size: 13px; }
  .tree { list-style: none; margin: 0; padding: 0; }
  /* A row is a paragraph, as in the board panel: inline 20 px boxes before the text, a wrapped line back at the row's left edge, 18 px per level. */
  .row { border-radius: 6px; padding-left: calc(var(--depth) * 18px); transition: background-color 0.3s; }
  .row.lit { animation: lit 2s ease-out; }
  @keyframes lit { from { background: color-mix(in srgb, var(--accent) 18%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent); } to { background: transparent; box-shadow: none; } }
  .line { margin: 0; padding: 4px 6px 4px 0; line-height: 20px; overflow-wrap: anywhere; }
  .line :global(.status) { height: 20px; }
  .line :global(.id-chip) { height: 20px; line-height: 20px; margin-right: 2px; }
  .fold { display: inline-flex; vertical-align: top; width: 18px; height: 20px; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 4px; }
  button.fold:hover { background: var(--bg-hover); color: var(--text); }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .row.plan.done > .line > .text { color: var(--text-muted); }
  .row.plan.dropped > .line > .text { color: var(--text-faint); text-decoration: line-through; }
  .progress { margin-left: 6px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .owner { display: inline-flex; vertical-align: top; align-items: center; gap: 3px; height: 20px; max-width: 220px; margin-left: 8px; padding: 0 7px 0 5px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-sunken); font-size: 11.5px; color: var(--text-muted); }
  .owner:hover { border-color: var(--accent); color: var(--accent-bold); background: var(--accent-soft); }
  .owner-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { margin: -2px 0 4px; padding: 0 0 0 calc(18px + 14px + 4px); font-size: 12.5px; line-height: 1.5; color: var(--text-faint); overflow-wrap: anywhere; white-space: pre-wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: -2px 0 6px; padding-left: calc(18px + 4px); }
  @container app (max-width: 899px) {
    .view { padding: 6px 12px 40px; }
    .count { display: none; }
    .row { padding-left: calc(var(--depth) * 12px); }
    .owner { max-width: 140px; }
  }
</style>
