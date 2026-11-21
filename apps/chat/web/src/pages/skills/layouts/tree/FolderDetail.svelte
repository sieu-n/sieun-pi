<script lang="ts">
  import type { BoxName, SkillsView } from "$lib/api/shared/skills";
  import { Badge, Button } from "$lib/ui";
  import InstallDialog from "./InstallDialog.svelte";
  import {
    PROBLEMS, boxLabel, folderLine, folderSkills, isBloated, sizeText, skillProblems, sourceText, tilde, usesText, type CopyRef, type Folder, type FolderSkill, type Problem,
  } from "./model";

  type Props = {
    view: SkillsView;
    folder: Folder | null;
    refs: readonly CopyRef[];
    roots: ReadonlyMap<BoxName, Folder[]>;
    problem: Problem | null;
    onskill: (id: string) => void;
    reload: () => Promise<void>;
  };
  let { view, folder, refs, roots, problem, onskill, reload }: Props = $props();

  let installOpen = $state(false);
  const t = $derived(view.thresholds);
  const isRoot = $derived(folder !== null && folder.children.length === 0 && folder.clutter.length === 0);
  const lists = $derived.by(() => {
    const all = folderSkills(refs, folder?.node.path ?? "/");
    const keep = (r: FolderSkill): boolean => problem === null || skillProblems(r.skill).includes(problem);
    return { used: all.used.filter(keep), never: all.never.filter(keep) };
  });

  function driftOf(row: FolderSkill): string | null {
    const most = Math.max(0, ...row.copies.map(c => c.changedLines ?? 0));
    return most > 0 ? `${most} ${most === 1 ? "line differs" : "lines differ"}` : null;
  }
</script>

<section class="folder" data-testid="tree-folder">
  <header>
    <div class="title">
      <h2>{folder ? tilde(folder.node.path) : "Every folder"}</h2>
      {#if folder}<Badge tone="outline">{boxLabel(folder.box)}</Badge>{/if}
      {#if folder?.stale}<Badge tone="warning">old clone</Badge>{/if}
      {#if folder && folder.broken > 0}<Badge tone="danger">{folder.broken} broken {folder.broken === 1 ? "link" : "links"}</Badge>{/if}
    </div>
    <p class="meta">
      {#if folder}{folderLine(folder)}.{:else}Pick a folder in the tree to see only its skills, or a skill to see its copies on every box.{/if}
      {#if problem}Showing only {PROBLEMS[problem].label} skills.{/if}
    </p>
    {#if isRoot}
      <div class="actions"><Button size="sm" icon="plus" onclick={() => (installOpen = true)} data-testid="tree-add-here">Add skill here</Button></div>
    {/if}
  </header>

  {#snippet rows(list: FolderSkill[])}
    <ul class="rows">
      {#each list as row (row.skill.id)}
        {@const s = row.skill}
        {@const drift = driftOf(row)}
        <li>
          <button type="button" class="row" onclick={() => onskill(s.id)} data-testid="tree-skill-row" data-skill={s.id}>
            <span class="name">
              <span class="label">{s.name}</span>
              {#each skillProblems(s) as p (p)}<Badge tone={p === "bloated" ? "warning" : "danger"}>{PROBLEMS[p].label}</Badge>{/each}
              <span class="source">{sourceText(s)}</span>
            </span>
            <span class="copies">{s.copies.length} {s.copies.length === 1 ? "copy" : "copies"}{folder && row.copies.length > 1 ? `, ${row.copies.length} here` : ""}</span>
            <span class="drift" class:warn={drift !== null}>{drift ?? "same as source"}</span>
            <span class="size" class:warn={isBloated(s.size.bytes, t)}>{sizeText(s.size.bytes, t) ?? ""}</span>
            <span class="uses">{s.use.uses ? usesText(s.use.uses) : "never"}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/snippet}

  {#if lists.used.length === 0 && lists.never.length === 0}
    <p class="none">{problem ? `No ${PROBLEMS[problem].label} skill here.` : "No skill here."}</p>
  {/if}
  {#if lists.used.length}
    <h3>Used in the last 30 days <span class="count">{lists.used.length}</span></h3>
    {@render rows(lists.used)}
  {/if}
  {#if lists.never.length}
    <h3>Never used in 30 days <span class="count">{lists.never.length}</span></h3>
    <p class="hint">A weak description may be why no thread picks one, so review it before removing.</p>
    {@render rows(lists.never)}
  {/if}
</section>

{#if folder && isRoot}<InstallDialog bind:open={installOpen} {view} {roots} {folder} skill={null} {reload} />{/if}

<style>
  .folder { display: flex; flex-direction: column; gap: var(--space-3); container-type: inline-size; }
  header { display: flex; flex-direction: column; gap: var(--space-2); }
  .title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  h2 { margin: 0; font: var(--text-heading); overflow-wrap: anywhere; }
  h3 { margin: var(--space-2) 0 0; font: var(--text-label-sm); }
  .count, .hint { color: var(--text-subtle); font: var(--text-caption); font-weight: 400; }
  .hint { margin: 0; }
  .meta, .none { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .actions { display: flex; gap: var(--space-2); }
  .rows { display: flex; flex-direction: column; margin: 0; padding: var(--space-1); list-style: none; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  .row {
    display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr); align-items: center;
    gap: var(--space-3); width: 100%; min-height: 40px; padding: var(--space-1) var(--space-3); border: 0; border-radius: 8px; background: transparent;
    color: var(--text-standard); font: var(--text-body-sm); text-align: left; cursor: pointer;
  }
  .row:hover { background: var(--affordance-ghost-hover); }
  .row:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
  .label { font: var(--text-label-sm); overflow-wrap: anywhere; }
  .source { flex-basis: 100%; color: var(--text-metadata); font: var(--text-caption); overflow-wrap: anywhere; }
  .copies, .drift, .size { color: var(--text-subtle); font: var(--text-caption); }
  .uses { justify-self: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .warn { color: var(--text-danger); }
  @container (width < 560px) {
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .copies, .drift, .size { display: none; }
  }
</style>
