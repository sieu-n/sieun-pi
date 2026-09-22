<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { labels } from "./labels.ts";
  import { PRIORITY_LABEL } from "./organize.ts";
  import type { Priority, Tag } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import TagChip from "./TagChip.svelte";

  let { ids, at, onclose, onrename }: { ids: string[]; at: { x: number; y: number }; onclose: () => void; onrename?: () => void } = $props();

  const LEVELS: readonly Priority[] = [0, 1, 2, 3];
  let menu: HTMLElement | undefined = $state();
  let position = $state({ left: 0, top: 0 });
  let draft = $state("");
  let editing = $state<{ id: string; name: string } | null>(null);
  let confirmDelete = $state<string | null>(null);

  const rows = $derived(store.sessions.filter(row => ids.includes(row.id)));
  const priority = $derived(rows.length && rows.every(row => row.priority === rows[0]!.priority) ? rows[0]!.priority : null);
  const coverage = (tag: Tag): "all" | "some" | "none" => {
    const count = rows.filter(row => row.tags.includes(tag.id)).length;
    return count === 0 ? "none" : count === rows.length ? "all" : "some";
  };
  const matching = $derived(draft.trim() ? store.tags.filter(tag => tag.name.toLowerCase().includes(draft.trim().toLowerCase())) : store.tags);
  const exact = $derived(store.tags.some(tag => tag.name.toLowerCase() === draft.trim().toLowerCase()));

  $effect(() => {
    const node = menu;
    if (!node) return;
    node.showPopover();
    const box = node.getBoundingClientRect();
    position = { left: Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - box.height - 8)) };
    node.querySelector<HTMLElement>("[data-item]")?.focus();
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !node.contains(event.target)) onclose(); };
    document.addEventListener("pointerdown", onPointer, true);
    return () => { document.removeEventListener("pointerdown", onPointer, true); if (node.matches(":popover-open")) node.hidePopover(); };
  });

  function items(): HTMLElement[] { return menu ? [...menu.querySelectorAll<HTMLElement>("[data-item]")] : []; }
  function onKey(event: KeyboardEvent): void {
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (editing) editing = null; else onclose(); return; }
    if (event.key === "Tab") { event.preventDefault(); onclose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
      list[next]?.focus();
      return;
    }
    if (!typing && /^[0-3]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      void labels.setPriority(ids, Number(event.key) as Priority);
    }
  }
  async function createFromDraft(): Promise<void> {
    const name = draft.trim();
    if (!name) return;
    const existing = store.tags.find(tag => tag.name.toLowerCase() === name.toLowerCase());
    draft = "";
    if (existing) await labels.setTag(ids, existing.id, true);
    else await labels.create(name, ids);
  }
  function onDraftKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); void createFromDraft(); }
  }
  async function commitEdit(): Promise<void> {
    const current = editing;
    editing = null;
    if (!current) return;
    const tag = store.tags.find(candidate => candidate.id === current.id);
    if (tag && current.name.trim() && current.name.trim() !== tag.name) await labels.rename(current.id, current.name);
  }
  function onEditKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void commitEdit(); }
  }
  function focusAndSelect(node: HTMLInputElement): void { node.focus(); node.select(); }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="thread-menu" popover="manual" role="menu" tabindex="-1" aria-label={ids.length > 1 ? `Labels for ${ids.length} threads` : "Thread options"}
  bind:this={menu} style:left="{position.left}px" style:top="{position.top}px" onkeydown={onKey}>
  {#if onrename && ids.length === 1}
    <button class="menu-item" data-item role="menuitem" onclick={() => { onclose(); onrename(); }}><Icon name="pencil" size={15} />Rename<span class="hint">F2</span></button>
    <div class="menu-separator"></div>
  {/if}
  <div class="menu-heading">Priority <span class="keys">0 to 3</span></div>
  <div class="levels" role="group" aria-label="Priority">
    {#each LEVELS as level (level)}
      <button class="level" class:current={priority === level} data-item role="menuitemradio" aria-checked={priority === level}
        title="{PRIORITY_LABEL[level]} ({level})" onclick={() => void labels.setPriority(ids, level)}>
        {#if level === 0}<span class="none">None</span>{:else}<PriorityBars {level} size={13} />{/if}
      </button>
    {/each}
  </div>
  <div class="menu-separator"></div>
  <div class="menu-heading">Tags</div>
  <div class="tags">
    {#each matching as tag (tag.id)}
      {@const state = coverage(tag)}
      <div class="tag-row">
        {#if editing?.id === tag.id}
          <input class="field edit" bind:value={editing.name} aria-label="Tag name" maxlength="40" use:focusAndSelect onkeydown={onEditKey} onblur={() => void commitEdit()} />
        {:else}
          <button class="menu-item tag-toggle" data-item role="menuitemcheckbox" aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
            onclick={() => void labels.setTag(ids, tag.id, state !== "all")}>
            <span class="box" class:all={state === "all"} class:some={state === "some"}>{#if state === "all"}<Icon name="check" size={11} />{/if}</span>
            <TagChip {tag} />
          </button>
          <button class="icon-button small" aria-label="Rename tag {tag.name}" title="Rename tag" onclick={() => { confirmDelete = null; editing = { id: tag.id, name: tag.name }; }}><Icon name="pencil" size={13} /></button>
          {#if confirmDelete === tag.id}
            <button class="confirm" onclick={() => { confirmDelete = null; void labels.remove(tag.id); }}>Delete</button>
          {:else}
            <button class="icon-button small" aria-label="Delete tag {tag.name}" title="Delete tag from all threads" onclick={() => { confirmDelete = tag.id; }}><Icon name="x" size={13} /></button>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
  <input class="field draft" data-item bind:value={draft} placeholder={store.tags.length ? "Filter or create tag" : "Create a tag"} aria-label="Filter or create tag" maxlength="40" onkeydown={onDraftKey} />
  {#if draft.trim() && !exact}
    <button class="menu-item" data-item role="menuitem" onclick={() => void createFromDraft()}><Icon name="plus" size={15} />Create "{draft.trim()}"<span class="hint">Enter</span></button>
  {/if}
</div>

<style>
  .thread-menu { position: fixed; inset: auto; margin: 0; width: 244px; max-height: min(70vh, 520px); overflow: auto; padding: 6px; border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--bg-elevated); color: var(--text); box-shadow: var(--shadow); font-size: 14px; }
  .thread-menu:focus { outline: none; }
  .keys { float: right; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .levels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 2px 4px 4px; }
  .level { display: inline-flex; align-items: center; justify-content: center; height: 28px; border-radius: var(--radius-small); border: 1px solid var(--border); }
  .level:hover { background: var(--bg-hover); }
  .level.current { border-color: var(--accent); background: var(--accent-soft); }
  .none { font-size: 12px; color: var(--text-muted); }
  .tags { max-height: 220px; overflow: auto; }
  .tag-row { display: flex; align-items: center; gap: 2px; }
  .tag-toggle { flex: 1; min-width: 0; padding: 5px 8px; }
  .tag-row .icon-button.small, .tag-row .confirm { opacity: 0; }
  .tag-row:hover .icon-button.small, .tag-row:hover .confirm, .tag-row .confirm, .tag-row :focus-visible { opacity: 1; }
  .icon-button.small { width: 24px; height: 24px; }
  .confirm { height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--danger); background: var(--danger-soft); }
  .box { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: none; border-radius: 4px; border: 1.5px solid var(--border-strong); color: var(--accent-text); }
  .box.all { background: var(--accent); border-color: var(--accent); }
  .box.some { background: linear-gradient(var(--accent), var(--accent)) center / 8px 2px no-repeat; border-color: var(--accent); }
  .edit { margin: 2px 4px; font-size: 13px; padding: 3px 8px; }
  .draft { margin: 6px 4px 2px; width: calc(100% - 8px); font-size: 13px; padding: 5px 8px; }
</style>
