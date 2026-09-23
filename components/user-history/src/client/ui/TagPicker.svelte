<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import { store } from "../store.svelte.ts";
  import { labels, type Coverage, type TagSelection } from "../labels.ts";
  import type { Tag } from "../../shared/types.ts";
  import Checkbox from "./Checkbox.svelte";
  import TagChip from "../TagChip.svelte";
  import Icon from "../Icon.svelte";
  import { tooltip } from "./tooltip.ts";

  /**
   * One tag combobox for every place that tags threads. Type to filter; Enter creates the typed tag and assigns it in one step, or toggles the
   * highlighted tag. Assigned tags sit on top as chips; a click on a chip, or Backspace in the empty field, removes one.
   */
  let { selection, autofocus = true }: { selection: TagSelection; autofocus?: boolean } = $props();

  const id = "tags-" + ++nextId;
  let draft = $state("");
  let active = $state(0);
  let editing = $state<{ id: string; name: string } | null>(null);
  let confirmDelete = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();

  type Entry = { kind: "create"; name: string } | { kind: "tag"; tag: Tag; state: Coverage };
  const coverage = (tag: Tag): Coverage => selection.coverage(tag);
  const needle = $derived(draft.trim().toLowerCase());
  const assigned = $derived(store.tags.filter(tag => coverage(tag) === "all"));
  const entries = $derived.by((): Entry[] => {
    const tags: Entry[] = store.tags.filter(tag => !needle || tag.name.toLowerCase().includes(needle)).map(tag => ({ kind: "tag", tag, state: coverage(tag) }));
    const exact = store.tags.some(tag => tag.name.toLowerCase() === needle);
    return needle && !exact ? [{ kind: "create", name: draft.trim() }, ...tags] : tags;
  });
  $effect(() => {
    void needle;
    const exactIndex = entries.findIndex(entry => entry.kind === "tag" && entry.tag.name.toLowerCase() === needle);
    active = exactIndex >= 0 ? exactIndex : 0;
  });

  async function activate(entry: Entry | undefined): Promise<void> {
    if (!entry) return;
    draft = "";
    if (entry.kind === "create") {
      const existing = store.tags.find(tag => tag.name.toLowerCase() === entry.name.toLowerCase());
      if (existing) await selection.set(existing.id, true);
      else await selection.create(entry.name);
    } else {
      await selection.set(entry.tag.id, entry.state !== "all");
    }
    input?.focus();
  }
  function remove(tag: Tag): void {
    void selection.set(tag.id, false);
    input?.focus();
  }
  function move(to: number): void {
    if (!entries.length) return;
    active = (to + entries.length) % entries.length;
    requestAnimationFrame(() => list?.querySelector(`#${id}-${active}`)?.scrollIntoView({ block: "nearest" }));
  }
  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Enter") { event.preventDefault(); void activate(entries[active]); }
    else if (event.key === "Backspace" && !draft && assigned.length) { event.preventDefault(); remove(assigned.at(-1)!); }
  }
  async function commitEdit(): Promise<void> {
    const current = editing;
    editing = null;
    if (!current) return;
    const tag = store.tags.find(candidate => candidate.id === current.id);
    if (tag && current.name.trim() && current.name.trim() !== tag.name) await labels.rename(current.id, current.name.trim());
    input?.focus();
  }
  function onEditKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); void commitEdit(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editing = null; input?.focus(); }
  }
  function focusAndSelect(node: HTMLInputElement): void { node.focus(); node.select(); }
</script>

<div class="picker">
  <div class="field-row">
    {#each assigned as tag (tag.id)}
      <button type="button" class="assigned" aria-label="Remove tag {tag.name}" onclick={() => remove(tag)}>
        <TagChip {tag} /><span class="x" aria-hidden="true"><Icon name="x" size={10} /></span>
      </button>
    {/each}
    <input bind:this={input} class="draft" data-autofocus={autofocus ? true : undefined} bind:value={draft} maxlength="40" placeholder={assigned.length ? "Add tag" : store.tags.length ? "Find or create a tag" : "Name a new tag"}
      role="combobox" aria-expanded="true" aria-controls="{id}-list" aria-autocomplete="list" aria-label={selection.label}
      aria-activedescendant={entries[active] ? `${id}-${active}` : undefined} onkeydown={onKey} />
  </div>
  <div class="list" id="{id}-list" role="listbox" aria-multiselectable="true" aria-label="Tags" bind:this={list}>
    {#each entries as entry, index (entry.kind === "create" ? "create" : entry.tag.id)}
      {#if entry.kind === "create"}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div id="{id}-{index}" class="menu-item option" role="option" tabindex="-1" aria-selected="false" data-active={index === active}
          onpointermove={() => { active = index; }} onclick={() => void activate(entry)}>
          <span class="plus"><Icon name="plus" size={13} /></span>
          <span class="name">Create <strong>{entry.name}</strong></span>
          <span class="hint">Enter</span>
        </div>
      {:else}
        {@const tag = entry.tag}
        <div class="tag-row" data-active={index === active}>
          {#if editing?.id === tag.id}
            <input class="field edit" bind:value={editing.name} aria-label="Tag name" maxlength="40" use:focusAndSelect onkeydown={onEditKey} onblur={() => void commitEdit()} />
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div id="{id}-{index}" class="menu-item option" role="option" tabindex="-1" aria-selected={entry.state === "all"} data-active={index === active}
              onpointermove={() => { active = index; }} onclick={() => void activate(entry)}>
              <Checkbox visual checked={entry.state === "all"} indeterminate={entry.state === "some"} />
              <TagChip {tag} />
              {#if entry.state === "some"}<span class="hint">some</span>{/if}
            </div>
            {#if confirmDelete === tag.id}
              <button type="button" class="confirm" onclick={() => { confirmDelete = null; void labels.remove(tag.id); input?.focus(); }}>Delete tag</button>
            {:else}
              <button type="button" class="icon-button small manage" tabindex="-1" aria-label="Rename tag {tag.name}" use:tooltip={"Rename"}
                onclick={() => { confirmDelete = null; editing = { id: tag.id, name: tag.name }; }}><Icon name="pencil" /></button>
              <button type="button" class="icon-button small manage" tabindex="-1" aria-label="Delete tag {tag.name}" use:tooltip={"Delete from all threads"}
                onclick={() => { confirmDelete = tag.id; }}><Icon name="trash" /></button>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
    {#if !entries.length}<div class="empty">Type a name to create the first tag.</div>{/if}
  </div>
</div>

<style>
  .picker { display: flex; flex-direction: column; min-width: 0; }
  .field-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 2px 2px 4px; padding: 4px 6px; min-height: 32px; border-radius: var(--radius-small);
    border: 1px solid var(--border-strong); background: var(--bg); transition: border-color 0.12s, box-shadow 0.12s; }
  .field-row:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .draft { flex: 1; min-width: 80px; border: 0; outline: none; background: none; font-size: 13px; padding: 2px 0; }
  .draft::placeholder { color: var(--text-faint); }
  .assigned { position: relative; display: inline-flex; align-items: center; border-radius: 4px; }
  .assigned .x { position: absolute; right: -4px; top: -5px; display: none; width: 13px; height: 13px; border-radius: 50%; align-items: center; justify-content: center;
    background: var(--text); color: var(--bg); }
  .assigned:hover .x, .assigned:focus-visible .x { display: inline-flex; }
  .assigned:hover :global(.tag) { text-decoration: line-through; }
  .list { max-height: 240px; overflow: auto; }
  .option { cursor: default; min-height: 28px; padding: 4px 8px; }
  .plus { display: inline-flex; width: 15px; justify-content: center; color: var(--accent-bold); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name strong { font-weight: 600; }
  .tag-row { display: flex; align-items: center; gap: 1px; border-radius: var(--radius-small); }
  .tag-row .option { flex: 1; min-width: 0; }
  .manage { opacity: 0; }
  .tag-row:hover .manage, .tag-row[data-active="true"] .manage { opacity: 1; }
  .confirm { height: 24px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12px; color: var(--danger); background: var(--danger-soft); white-space: nowrap; }
  .edit { margin: 2px 4px; }
  .empty { padding: 8px 10px; font-size: 12.5px; color: var(--text-faint); }
</style>
