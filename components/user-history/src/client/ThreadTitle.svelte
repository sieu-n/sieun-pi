<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { shortPath } from "./format.ts";
  import Icon from "./Icon.svelte";
  import TagChip from "./TagChip.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import PriorityPicker from "./PriorityPicker.svelte";
  import ProgressPicker from "./ProgressPicker.svelte";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import { labels, threadTags } from "./labels.ts";
  import { PRIORITY_LABEL, PROGRESS_LABEL } from "./organize.ts";

  /** The header's left half, shared by the thread and chat views: the name (click to rename), the workspace, tags, priority and progress. `reading` keeps only the name. */
  let { id, reading = false }: { id: string; reading?: boolean } = $props();

  const thread = $derived(store.thread(id)?.state ?? null);
  const row = $derived(store.session(id));
  const title = $derived(row?.name ?? thread?.info.name ?? "New chat");
  const cwd = $derived(thread?.info.cwd ?? row?.cwd ?? "");
  const rowTags = $derived((row?.tags ?? []).flatMap(tagId => store.tags.filter(tag => tag.id === tagId)));

  let labelPicker = $state<{ field: "tags" | "priority" | "progress"; anchor: HTMLElement } | null>(null);
  function pick(event: MouseEvent, field: "tags" | "priority" | "progress"): void {
    const anchor = event.currentTarget as HTMLElement;
    labelPicker = labelPicker?.field === field ? null : { field, anchor };
  }
  const closePicker = () => { labelPicker = null; };

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
</script>

<div class="title-wrap">
  {#if editingTitle !== null}
    <input class="field title-input" bind:value={editingTitle} placeholder="Thread name" aria-label="Thread name" use:focusAndSelect onkeydown={onTitleKey} onblur={() => { editingTitle = null; }} />
  {:else}
    <button type="button" class="title" aria-label="Rename thread {title}" onclick={startRename}>{title}</button>
  {/if}
  {#if cwd && !reading}<span class="cwd">{shortPath(cwd)}</span>{/if}
  {#if row && !reading}<span class="tags">
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

<style>
  .title-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .title { flex: 0 8 auto; max-width: 100%; min-width: 96px; padding: 3px 8px; border-radius: var(--radius-small); font-weight: 600; font-size: 14px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover { background: var(--bg-hover); }
  .title-input { font-weight: 600; font-size: 14px; height: 28px; max-width: 480px; }
  .cwd { flex: none; font-size: 12px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; }
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
  @container app (max-width: 899px) {
    .cwd, .label-text { display: none; }
  }
</style>
