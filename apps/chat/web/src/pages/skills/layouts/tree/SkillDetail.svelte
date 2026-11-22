<script lang="ts">
  import { api } from "$lib/api";
  import type { BoxName, SkillCopy, SkillEntry, SkillsView } from "$lib/api/shared/skills";
  import { ageLabel, Badge, Button, Picker, type PickerItem } from "$lib/ui";
  import { act, type ChangeWords } from "./actions";
  import InstallDialog from "./InstallDialog.svelte";
  import MoveDialog from "./MoveDialog.svelte";
  import {
    boxLabel, boxLine, byBoxOrder, driftText, sourceText, isBloated, kb, roleLabel, runtimeLabel, sizeText, skillProblems, tilde, usesText, verdictsOf, type Folder,
  } from "./model";

  type Props = {
    view: SkillsView;
    skill: SkillEntry;
    roots: ReadonlyMap<BoxName, Folder[]>;
    /** The folder the person came from, whose copies are marked. */
    folder: string | null;
    reload: () => Promise<void>;
  };
  let { view, skill, roots, folder, reload }: Props = $props();

  let installOpen = $state(false);
  let moveOpen = $state(false);
  let moving = $state<SkillCopy | null>(null);
  let mergeOpen = $state(false);
  let mergeAnchor = $state<HTMLElement | undefined>();
  let busy = $state<string | null>(null);
  const now = Date.now();

  const problems = $derived(skillProblems(skill));
  const t = $derived(view.thresholds);
  const columns = $derived(byBoxOrder(view.boxes).map(box => ({ box, copies: skill.copies.filter(c => c.box === box.box).sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path)) })));
  const mergeItems = $derived(
    view.skills
      .filter(s => s.id !== skill.id)
      .sort((a, b) => Number(b.name === skill.name) - Number(a.name === skill.name) || a.name.localeCompare(b.name))
      .map((s): PickerItem => ({ id: s.id, label: s.name, detail: sourceText(s), group: s.name === skill.name ? "Same name" : "Other skills" })),
  );

  const ROLE_ORDER = { source: 0, install: 1, checkout: 2, unowned: 3 } as const;
  const order = (c: SkillCopy): number => ROLE_ORDER[c.role] + (c.checkout?.stale ? 4 : 0);
  const linksTo = (c: SkillCopy): SkillCopy[] => skill.copies.filter(l => l !== c && l.box === c.box && l.link !== null && l.realPath === c.realPath);
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const inFolder = (c: SkillCopy): boolean => folder !== null && c.path.startsWith(`${folder}/`);

  function useLine(): string {
    const u = skill.use;
    if (u.uses === 0) return "Never used in 30 days.";
    const last = u.lastUse ? `, last ${ageLabel(Date.parse(u.lastUse), now)} ago` : "";
    return `${usesText(u.uses)} in 30 days from ${u.sessions.toLocaleString("en-US")} ${u.sessions === 1 ? "session" : "sessions"}${last}.`;
  }

  function sizeLine(): string | null {
    const { lines, bytes } = skill.size;
    if (bytes === null) return null;
    return [lines === null ? null : `${lines} lines`, kb(bytes), sizeText(bytes, t)].filter(Boolean).join(", ");
  }

  async function run(key: string, words: ChangeWords, call: () => ReturnType<typeof api.removeSkill>): Promise<void> {
    busy = key;
    await act(words, call, reload);
    busy = null;
  }

  const remove = (c: SkillCopy) => run(c.id, { doing: `Removing ${tilde(c.path)}`, done: `Removed ${skill.name} from ${tilde(parentOf(c.path))} on ${boxLabel(c.box)}` }, () => api.removeSkill({ target: c.id }));
  const adopt = (c: SkillCopy) => run(c.id, { doing: `Adopting ${tilde(c.path)}`, done: `Adopted ${tilde(c.path)} as a copy of ${skill.name}` }, () => api.adoptSkill({ copyId: c.id, skillId: skill.id }));
  const removeSkill = () => run(skill.id, { doing: `Removing ${skill.name}`, done: `Removed ${skill.name} from every box` }, () => api.removeSkill({ target: skill.id }));
  const merge = (into: string) => run(skill.id, { doing: `Merging ${skill.name}`, done: `Handed the merge of ${skill.name} into ${view.skills.find(s => s.id === into)?.name ?? into} to agent factory` }, () => api.mergeSkill({ skillId: skill.id, into }));
</script>

<article class="skill" data-testid="tree-skill" data-skill={skill.id}>
  <header>
    <div class="title">
      <h2>{skill.name}</h2>
      {#each problems as p (p)}<Badge tone={p === "bloated" ? "warning" : "danger"}>{p}</Badge>{/each}
      {#if skill.use.uses === 0}<Badge tone="outline" title="A weak description may be why no thread picks it.">never used</Badge>{/if}
    </div>
    {#if skill.description}<p class="description">{skill.description}</p>{/if}
    <p class="meta">
      Owned by {skill.owner.kind === "owner" ? "the owner" : skill.owner.id}. Source is {sourceText(skill)}.
      {useLine()}{skill.preimported ? " Its module is pre-imported, so each call counts." : ""}
      {#if sizeLine()}<span class:warn={isBloated(skill.size.bytes, t)}>{sizeLine()}.</span>{/if}
    </p>
    {#each verdictsOf(skill, null).filter(v => v.rule !== "bloated") as v (v.rule + v.detail)}<p class="verdict">{v.detail}</p>{/each}
    <div class="actions">
      <Button size="sm" icon="plus" onclick={() => (installOpen = true)}>Add to a folder</Button>
      <Button size="sm" icon="forward" trailingIcon="chevron-down" bind:element={mergeAnchor} loading={busy === skill.id && mergeOpen} onclick={() => (mergeOpen = !mergeOpen)}>Merge into</Button>
      <Button size="sm" variant="ghost" icon="trash" loading={busy === skill.id && !mergeOpen} onclick={() => void removeSkill()}>Remove skill</Button>
    </div>
  </header>

  <div class="copies" style:--columns={columns.length}>
    {#each columns as { box, copies } (box.box)}
      <section class="column" aria-label={`Copies on ${boxLabel(box.box)}`}>
        <h3>{boxLabel(box.box)} <span class="count">{copies.length} {copies.length === 1 ? "copy" : "copies"}</span></h3>
        {#if boxLine(box)}<p class="offline" title={box.error ?? undefined}>{boxLine(box)}</p>{/if}
        {#each copies as copy (copy.id)}
          {@const copyProblems = verdictsOf(skill, copy.id).filter(v => v.rule !== "bloated")}
          {@const via = linksTo(copy)}
          <div class="copy" class:here={inFolder(copy)} class:gone={!copy.exists} data-testid="tree-copy" data-copy={copy.id}>
            <div class="path"><code>{tilde(copy.path)}</code></div>
            <div class="tags">
              <Badge tone={copy.role === "source" ? "strong" : copy.role === "unowned" ? "warning" : "outline"}>{roleLabel(copy.role)}</Badge>
              {#if copy.link !== null}<Badge tone={copy.exists ? "neutral" : "danger"} title={copy.link}>{copy.exists ? "link" : "broken link"}</Badge>{:else}<Badge tone="neutral">folder</Badge>{/if}
              {#if copy.checkout?.stale}<Badge tone="warning" title={copy.checkout.root}>old clone</Badge>{/if}
            </div>
            <dl>
              {#if copy.link !== null}<dt>Points at</dt><dd><code>{tilde(copy.link)}</code></dd>{/if}
              <dt>Drift</dt><dd class:warn={(copy.changedLines ?? 0) > 0}>{driftText(copy)}</dd>
              {#if copy.bytes !== null && copy.link === null}<dt>Size</dt><dd class:warn={isBloated(copy.bytes, t)}>{copy.lines ?? "?"} lines, {kb(copy.bytes)}, {sizeText(copy.bytes, t)}{copy.folderBytes !== null && copy.folderBytes > copy.bytes ? `, folder ${kb(copy.folderBytes)}` : ""}</dd>{/if}
              <dt>Loaded by</dt>
              {#if copy.loadedBy.length}<dd>{copy.loadedBy.map(runtimeLabel).join(", ")}</dd>
              {:else if via.length}<dd>through {via.map(l => tilde(l.path)).join(", ")}</dd>
              {:else}<dd class="warn">nothing</dd>{/if}
              {#if copy.checkout}<dt>Checkout</dt><dd>{tilde(copy.checkout.root)}{copy.checkout.branch ? ` on ${copy.checkout.branch}` : ""}{copy.checkout.headAt ? `, last commit ${ageLabel(Date.parse(copy.checkout.headAt), now)} ago` : ""}</dd>{/if}
            </dl>
            {#each copyProblems as v (v.rule + v.detail)}<p class="verdict">{v.detail}</p>{/each}
            <div class="copy-actions">
              {#if copy.role === "install" && copy.installId}<Button size="sm" variant="ghost" icon="arrow-right" onclick={() => ((moving = copy), (moveOpen = true))} data-testid="tree-copy-move">Move</Button>{/if}
              {#if copy.role === "unowned"}<Button size="sm" variant="ghost" icon="check" loading={busy === copy.id} onclick={() => void adopt(copy)}>Adopt</Button>{/if}
              {#if copy.role !== "source"}<Button size="sm" variant="ghost" icon="trash" loading={busy === copy.id} onclick={() => void remove(copy)} data-testid="tree-copy-remove">Remove</Button>{/if}
            </div>
          </div>
        {:else}
          <p class="none">No copy here.</p>
        {/each}
      </section>
    {/each}
  </div>
</article>

<InstallDialog bind:open={installOpen} {view} {roots} folder={null} {skill} {reload} />
{#if moving}<MoveDialog bind:open={moveOpen} {skill} copy={moving} roots={roots.get(moving.box) ?? []} {reload} />{/if}
<Picker bind:open={mergeOpen} anchor={mergeAnchor} items={mergeItems} searchable width={360} label="Merge into" placeholder="Find the skill to keep" onselect={id => ((mergeOpen = false), void merge(id))} />

<style>
  .skill { display: flex; flex-direction: column; gap: var(--space-4); container-type: inline-size; }
  header { display: flex; flex-direction: column; gap: var(--space-2); }
  .title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  h2 { margin: 0; font: var(--text-heading); }
  .description { margin: 0; color: var(--text-standard); font: var(--text-body); }
  .meta { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .verdict { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); padding-left: var(--space-3); border-left: 2px solid var(--border-standard); }
  .warn { color: var(--text-danger); }
  .actions, .copy-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .copies { display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: var(--space-4); }
  .column { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
  h3 { margin: 0; font: var(--text-label-sm); }
  .count { color: var(--text-subtle); font: var(--text-caption); font-weight: 400; }
  .offline { margin: 0; color: var(--text-subtle); font: var(--text-caption); }
  .copy { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  .copy.here { box-shadow: inset 0 0 0 2px var(--border-prominent); }
  .copy.gone .path { text-decoration: line-through; }
  .path code, dd code { font: var(--text-mono); overflow-wrap: anywhere; }
  .tags { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px var(--space-3); margin: 0; font: var(--text-caption); }
  dt { color: var(--text-metadata); }
  dd { margin: 0; color: var(--text-standard); overflow-wrap: anywhere; }
  .none { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  @container (width < 460px) {
    .copies { grid-template-columns: minmax(0, 1fr); }
  }
</style>
