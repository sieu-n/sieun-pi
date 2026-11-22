<script lang="ts">
  import { tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { BoxName, SkillsView } from "$lib/api/shared/skills";
  import { router } from "$lib/router.svelte";
  import { Badge, Icon } from "$lib/ui";
  import FolderDetail from "./FolderDetail.svelte";
  import SkillDetail from "./SkillDetail.svelte";
  import {
    PROBLEM_IDS, ancestors, boxKey, boxLabel, boxLine, byBoxOrder, clutterKey, clutterLine, copiesByBox, findFolder, folderKey, folderLine,
    folders, kb, problemLine, roots, shortName, visibleRows, withProblem, type Folder, type Problem,
  } from "./model";

  /**
   * Settings > Skills, by folder tree: the duplicated, outdated and bloated counts, then each box's skill folders as a tree with who loads
   * each root, its skills, links against real folders, broken links, and old clones folded into one group. A folder lists its skills; a
   * skill shows its copies on every box side by side. The pick lives in the address (`box`, `folder`, `skill`), so Back and a shared link
   * keep it.
   */
  type Props = { view: SkillsView; reload: () => Promise<void> };
  let { view, reload }: Props = $props();

  const params = $derived(router.route.params);
  const problem = $derived<Problem | null>(PROBLEM_IDS.find(p => p === params.problem) ?? null);
  const byBox = $derived(copiesByBox(view));
  const allFolders = $derived(new Map(view.boxes.map(b => [b.box, folders(b, byBox.get(b.box) ?? [])])));
  const shown = $derived(byBoxOrder(view.boxes).map(b => ({ box: b.box, state: b, folders: withProblem(allFolders.get(b.box) ?? [], problem) })));
  const rootsByBox = $derived(new Map<BoxName, Folder[]>([...allFolders].map(([box, list]) => [box, roots(list)])));
  const selectedFolder = $derived(params.box && params.folder ? findFolder(allFolders.get(params.box) ?? [], params.folder) : null);
  const selectedSkill = $derived(params.skill ? (view.skills.find(s => s.id === params.skill) ?? null) : null);
  const refs = $derived(selectedFolder ? (byBox.get(selectedFolder.box) ?? []) : [...byBox.values()].flat());

  const open = new SvelteSet<string>();
  let opened = false;
  $effect(() => {
    if (opened || !view.boxes.length) return;
    opened = true;
    for (const b of view.boxes) {
      open.add(boxKey(b.box));
      for (const top of allFolders.get(b.box) ?? []) open.add(folderKey(b.box, top.node.path));
    }
  });
  $effect(() => {
    if (!params.box || !params.folder) return;
    const box = params.box;
    open.add(boxKey(box));
    let parent: string | null = null;
    for (const path of ancestors(allFolders.get(box) ?? [], params.folder)) {
      const key = folderKey(box, path);
      if (parent && findFolder(allFolders.get(box) ?? [], path)?.stale) open.add(clutterKey(parent));
      if (path !== params.folder) open.add(key);
      parent = key;
    }
  });

  const rows = $derived(visibleRows(shown, open));
  let focusId = $state<string | null>(null);
  const current = $derived(rows.some(r => r.id === focusId) ? focusId : (rows[0]?.id ?? null));

  function pick(next: { box?: string | null; folder?: string | null; skill?: string | null; problem?: string | null }): void {
    router.setParams({ box: params.box ?? null, folder: params.folder ?? null, skill: null, ...next });
  }
  const selectFolder = (f: Folder): void => pick({ box: f.box, folder: f.node.path, skill: null });
  const toggle = (id: string): void => void (open.has(id) ? open.delete(id) : open.add(id));

  async function focus(id: string): Promise<void> {
    focusId = id;
    await tick();
    document.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  }

  function activate(id: string): void {
    for (const b of shown) {
      if (id === boxKey(b.box)) return toggle(id);
      if (!id.startsWith(`${b.box}:`)) continue;
      if (id.endsWith("#clutter")) return toggle(id);
      const f = findFolder(allFolders.get(b.box) ?? [], id.slice(b.box.length + 1));
      if (f) return selectFolder(f);
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    const at = rows.findIndex(r => r.id === current);
    const row = rows[at];
    if (!row) return;
    const move = (to: number): void => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) void focus(next.id);
    };
    switch (event.key) {
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row.expandable) return;
        if (!open.has(row.id)) open.add(row.id);
        else move(at + 1);
        break;
      case "ArrowLeft":
        if (row.expandable && open.has(row.id)) open.delete(row.id);
        else if (row.parent) void focus(row.parent);
        break;
      case "Enter":
      case " ":
        activate(row.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const isSelected = (f: Folder): boolean => selectedFolder?.box === f.box && selectedFolder.node.path === f.node.path;
</script>

<div class="tree-layout" data-testid="skills-layout-tree">
  <section class="counts" aria-label="Problems">
    <div class="problems" role="group" aria-label="Show only skills that are">
      {#each PROBLEM_IDS as p (p)}
        <button type="button" class="problem" aria-pressed={problem === p} onclick={() => pick({ problem: problem === p ? null : p })} data-testid={`tree-count-${p}`}>
          <span class="number">{view.counts[p].toLocaleString("en-US")}</span>
          <span class="what">{p}</span>
        </button>
      {/each}
    </div>
    <p class="summary">
      {view.counts.skills.toLocaleString("en-US")} skills in {view.counts.copies.toLocaleString("en-US")} copies on {view.boxes.length === 1 ? "1 box" : `${view.boxes.length} boxes`},
      and {view.counts.neverUsed.toLocaleString("en-US")} never used in 30 days.
      The median SKILL.md is {kb(view.thresholds.medianBytes)}, and over {kb(view.thresholds.bloatBytes)} counts as bloated.
    </p>
    {#each view.boxes as b (b.box)}
      {#if boxLine(b)}<p class="offline" title={b.error ?? undefined} data-testid="tree-box-offline">{boxLine(b)}</p>{/if}
    {/each}
  </section>

  <div class="body">
    <nav class="nav" aria-label="Skill folders">
      <ul class="tree" role="tree" aria-label="Skill folders by box" {onkeydown}>
        {#each shown as b (b.box)}
          {@const id = boxKey(b.box)}
          <li role="treeitem" aria-level={1} aria-expanded={open.has(id)} aria-selected={false} tabindex={current === id ? 0 : -1} data-tree-id={id} class="item">
            <div class="line box-line" role="presentation" onclick={() => ((focusId = id), toggle(id))}>
              <span class="chevron" class:open={open.has(id)}><Icon name="chevron-right" size={16} /></span>
              <Icon name="server" size={16} />
              <span class="text"><span class="name">{boxLabel(b.box)}</span>{#if b.state.state !== "ok"}<span class="sub" title={b.state.error ?? undefined}>{b.state.state === "offline" ? "asleep or offline" : "no scan yet"}</span>{/if}</span>
            </div>
            {#if open.has(id)}
              <ul role="group">
                {#each b.folders as f (f.node.path)}{@render folderItem(f, 2)}{/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </nav>

    <div class="detail">
      {#if selectedSkill}
        <button type="button" class="back" onclick={() => pick({ skill: null })}><Icon name="arrow-left" size={16} />{selectedFolder ? `Back to ${shortName(selectedFolder.name)}` : "Back to every folder"}</button>
        {#key selectedSkill.id}<SkillDetail {view} skill={selectedSkill} roots={rootsByBox} folder={selectedFolder?.node.path ?? null} {reload} />{/key}
      {:else}
        <FolderDetail {view} folder={selectedFolder} {refs} roots={rootsByBox} {problem} onskill={id => router.setParams({ skill: id })} {reload} />
      {/if}
    </div>
  </div>
</div>

{#snippet folderItem(f: Folder, level: number)}
  {@const id = folderKey(f.box, f.node.path)}
  {@const expandable = f.children.length > 0 || f.clutter.length > 0}
  {@const problems = problemLine(f)}
  <li role="treeitem" aria-level={level} aria-expanded={expandable ? open.has(id) : undefined} aria-selected={isSelected(f)} tabindex={current === id ? 0 : -1} data-tree-id={id} class="item" data-testid="tree-folder-item" data-path={f.node.path}>
    <div class="line" class:selected={isSelected(f)} class:stale={f.stale} role="presentation" onclick={() => ((focusId = id), selectFolder(f))}>
      {#if expandable}
        <span class="chevron" class:open={open.has(id)} role="presentation" onclick={e => (e.stopPropagation(), toggle(id))}><Icon name="chevron-right" size={16} /></span>
      {:else}<span class="chevron"></span>{/if}
      <Icon name={f.node.links > 0 && f.node.copies === 0 ? "link" : "folder"} size={16} />
      <span class="text" title={f.node.path}>
        <span class="name">{shortName(f.name)}</span>
        <span class="sub">{folderLine(f)}</span>
        {#if problems}<span class="sub warn">{problems}</span>{/if}
      </span>
      <span class="flags">
        {#if f.broken > 0}<Badge tone="danger" title="Links whose target is gone">{f.broken} broken</Badge>{/if}
      </span>
    </div>
    {#if expandable && open.has(id)}
      <ul role="group">
        {#each f.children as child (child.node.path)}{@render folderItem(child, level + 1)}{/each}
        {#if f.clutter.length}{@render clutterItem(f, id, level + 1)}{/if}
      </ul>
    {/if}
  </li>
{/snippet}

{#snippet clutterItem(f: Folder, parent: string, level: number)}
  {@const id = clutterKey(parent)}
  <li role="treeitem" aria-level={level} aria-expanded={open.has(id)} aria-selected={false} tabindex={current === id ? 0 : -1} data-tree-id={id} class="item" data-testid="tree-clutter">
    <div class="line stale" role="presentation" onclick={() => ((focusId = id), toggle(id))}>
      <span class="chevron" class:open={open.has(id)}><Icon name="chevron-right" size={16} /></span>
      <Icon name="archive" size={16} />
      <span class="text">
        <span class="name">Old clones</span>
        <span class="sub">{clutterLine(f.clutter)}, nothing current loads them</span>
      </span>
    </div>
    {#if open.has(id)}
      <ul role="group">
        {#each f.clutter as child (child.node.path)}{@render folderItem(child, level + 1)}{/each}
      </ul>
    {/if}
  </li>
{/snippet}

<style>
  .tree-layout { display: flex; flex-direction: column; gap: var(--space-6); container-type: inline-size; }
  .counts { display: flex; flex-direction: column; gap: var(--space-2); }
  .problems { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .problem {
    display: flex; flex-direction: column; align-items: flex-start; min-width: 9rem; padding: var(--space-3) var(--space-4); border: 0; border-radius: 12px;
    background: transparent; box-shadow: inset 0 0 0 1px var(--border-standard); color: var(--text-standard); text-align: left; cursor: pointer;
  }
  .problem:hover { background: var(--affordance-ghost-hover); }
  .problem[aria-pressed="true"] { background: var(--interaction-selected); box-shadow: inset 0 0 0 1px var(--border-prominent); }
  .problem:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
  .number { font: var(--text-title); font-variant-numeric: tabular-nums; }
  .what { color: var(--text-subtle); font: var(--text-body-sm); }
  .summary { margin: 0; max-width: 48rem; color: var(--text-subtle); font: var(--text-body-sm); }
  .offline { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .body { display: grid; grid-template-columns: minmax(18rem, 26rem) minmax(0, 1fr); gap: var(--space-6); align-items: start; }
  .nav { position: sticky; top: 0; max-height: calc(100dvh - 160px); overflow: auto; padding: var(--space-1); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  ul { margin: 0; padding: 0; list-style: none; }
  ul[role="group"] { padding-left: var(--space-4); }
  .item { outline: none; }
  .item:focus-visible > .line { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .line { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: 8px; color: var(--text-standard); cursor: pointer; }
  .line:hover { background: var(--affordance-ghost-hover); }
  .line.selected { background: var(--interaction-selected); }
  .line.stale .name { color: var(--text-subtle); }
  .line > :global(svg) { flex: none; margin-top: 2px; color: var(--text-subtle); }
  .box-line { align-items: center; }
  .box-line > :global(svg) { margin-top: 0; }
  .chevron { display: inline-flex; flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--text-subtle); transition: transform var(--duration-base) var(--ease-standard); }
  .box-line .chevron { margin-top: 0; }
  .chevron.open { transform: rotate(90deg); }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .name { font: var(--text-label-sm); overflow-wrap: anywhere; }
  .sub { color: var(--text-subtle); font: var(--text-caption); }
  .flags { display: flex; flex: none; gap: var(--space-1); }
  .warn { color: var(--text-danger); }
  .detail { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .back { display: inline-flex; align-self: flex-start; align-items: center; gap: var(--space-1); padding: 0; border: 0; background: none; color: var(--text-subtle); font: var(--text-body-sm); cursor: pointer; }
  .back:hover { color: var(--text-standard); }
  @container (width < 820px) {
    .body { grid-template-columns: minmax(0, 1fr); }
    .nav { position: static; max-height: 24rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron { transition: none; }
  }
</style>
