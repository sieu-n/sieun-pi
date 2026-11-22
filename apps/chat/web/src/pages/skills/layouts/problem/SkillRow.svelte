<script lang="ts">
  import type { SkillEntry, SkillThresholds } from "$lib/api/shared/skills";
  import { Badge, Button, Icon, ageLabel, tooltip } from "$lib/ui";
  import {
    GROUP_TEXT, ROLE_TEXT, drift, headline, mergeInto, copyNotes, orderedCopies, problemsOf, shape, sight, sizeText, sourceText, splitPath, tilde, topKinds,
    weakDescription, type GroupKind, type RowActions,
  } from "./model";

  type Props = {
    skill: SkillEntry;
    kind: GroupKind | null;
    limits: SkillThresholds;
    nameOf: (id: string) => string;
    busy: string | null;
    act: RowActions;
    open: boolean;
    ontoggle: () => void;
  };
  let { skill, kind, limits, nameOf, busy, act, open, ontoggle }: Props = $props();

  const bodyId = `skill-${Math.random().toString(36).slice(2, 8)}`;
  const copies = $derived(orderedCopies(skill));
  const size = $derived(sizeText(skill.size.bytes, limits));
  const others = $derived(problemsOf(skill).filter(p => p !== kind));
  const weak = $derived(weakDescription(skill));
  const seen = $derived(sight(skill.sees));
  const kinds = $derived(topKinds(skill));
  const now = Date.now();
  const lead = $derived(kind ? headline(skill, kind, limits) : skill.description);
  const ownerText = $derived(skill.owner.kind === "owner" ? "you" : skill.owner.id);
  const merges = $derived([...new Set(skill.verdicts.flatMap(v => (v.action === "merge" && v.copyId === null && v.other ? [v.other] : [])))]);
</script>

<div class="skill" class:open data-testid="problem-skill" data-skill={skill.id}>
  <button type="button" class="head" aria-expanded={open} aria-controls={bodyId} onclick={ontoggle}>
    <Icon name="chevron-right" size={16} />
    <span class="title">
      <span class="name">{nameOf(skill.id)}</span>
      <span class="lead">{lead}</span>
    </span>
    <span class="facts">
      {#each others as other (other)}<Badge tone="outline">{GROUP_TEXT[other].title.toLowerCase()}</Badge>{/each}
      {#if weak}<Badge tone="warning" title="No session opened or called it in 30 days, so its description may be too weak for agents to pick it.">weak description, review</Badge>{/if}
      <span class="num" use:tooltip={"Folders and links that hold it"}>{skill.copies.length} {skill.copies.length === 1 ? "copy" : "copies"}</span>
      <span class="num" class:bad={size?.bloated}>{size ? size.text : "size unknown"}</span>
      <span class="num use">{skill.use.uses ? `${skill.use.uses.toLocaleString("en-US")} uses` : "never used"}</span>
    </span>
  </button>

  {#if open}
    <div class="body" id={bodyId}>
      {#if kind && skill.description}<p class="desc">{skill.description}</p>{/if}
      <dl class="meta">
        <dt>Source</dt><dd>{sourceText(skill.source)}</dd>
        <dt>Owner</dt><dd>{ownerText}</dd>
        <dt>Use in 30 days</dt>
        <dd>
          {#if skill.use.uses}
            {skill.use.uses.toLocaleString("en-US")} uses in {skill.use.sessions.toLocaleString("en-US")} sessions{#if skill.use.lastUse}, last {ageLabel(Date.parse(skill.use.lastUse), now)} ago{/if}{#if kinds.length}, most from {kinds.map(k => `${k.kind} (${k.uses.toLocaleString("en-US")})`).join(", ")}{/if}.
          {:else}
            No session opened or called it.{#if weak} Its description may be why, so review it before removing.{/if}
          {/if}
          {#if skill.preimported}<span class="aside"> Pre-imported as a Python module, so every call counts.</span>{/if}
        </dd>
        <dt>Seen by</dt>
        <dd>
          {seen.listed.length ? seen.listed.join(", ") : "no thread kind"}{#each seen.hidden as h (h.why)}<span class="hidden">Hidden from {h.kinds.join(", ")}, because {h.why}.</span>{/each}
        </dd>
      </dl>

      <div class="copies" role="table" aria-label="Copies of {skill.name}">
        <div class="crow cols" role="row">
          <span role="columnheader">Where</span><span role="columnheader">Drift</span><span role="columnheader">Size</span><span role="columnheader" class="sr">Actions</span>
        </div>
        {#each copies as copy (copy.id)}
          {@const where = splitPath(tilde(copy.path))}
          {@const d = drift(copy)}
          {@const s = sizeText(copy.bytes, limits)}
          {@const into = mergeInto(skill, copy)}
          {@const notes = copyNotes(skill, copy)}
          <div class="crow" role="row" data-testid="problem-copy" data-copy={copy.id}>
            <span class="where" role="cell">
              <span class="path" use:tooltip={`${copy.box}:${copy.path}`}><span class="box">{copy.box}</span><span class="head-part"><bdi>{where.head}</bdi></span><span class="tail">{where.tail}</span></span>
              <span class="sub">
                {ROLE_TEXT[copy.role]}, {tilde(shape(copy))}{#if copy.loadedBy.length}, read by {copy.loadedBy.join(", ")}{:else}, nothing reads it{/if}{#if copy.checkout?.stale}{copy.checkout.headAt ? `, old clone last committed ${copy.checkout.headAt.slice(0, 10)}` : ", old clone"}{/if}
              </span>
              {#each notes as note (note.rule + note.detail)}<span class="sub note">{note.detail}</span>{/each}
            </span>
            <span role="cell" class="num" class:bad={d.changed}>{d.text}</span>
            <span role="cell" class="num" class:bad={s?.bloated}>{s ? s.text : "unknown"}</span>
            <span role="cell" class="acts">
              {#if into}<Button size="sm" variant="ghost" icon="arrow-right" disabled={busy !== null} onclick={() => act.merge(skill, into)}>Merge into {nameOf(into)}</Button>{/if}
              {#if copy.role === "unowned"}<Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => act.adopt(skill, copy)}>Adopt</Button>{/if}
              {#if copy.installId}<Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => act.move(skill, copy)}>Move</Button>{/if}
              {#if copy.role !== "source"}<Button size="sm" variant="ghost" icon="trash" loading={busy === copy.id} disabled={busy !== null} onclick={() => act.removeCopy(skill, copy)}>Remove</Button>{/if}
            </span>
          </div>
        {/each}
      </div>

      <div class="skill-acts">
        <Button size="sm" variant="outline" icon="plus" disabled={busy !== null} onclick={() => act.install(skill)}>Install somewhere else</Button>
        {#each merges as other (other)}<Button size="sm" variant="outline" icon="arrow-right" disabled={busy !== null} onclick={() => act.merge(skill, other)}>Merge into {nameOf(other)}</Button>{/each}
        <Button size="sm" variant="ghost" icon="trash" loading={busy === skill.id} disabled={busy !== null} onclick={() => act.removeSkill(skill)}>Remove skill</Button>
      </div>
    </div>
  {/if}
</div>

<style>
  .skill { border-radius: 10px; }
  .skill:not(:first-child) { box-shadow: 0 -1px 0 var(--border-standard); }
  .head { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); width: 100%; min-height: 44px; padding: var(--space-1) var(--space-3); border: 0; border-radius: 10px; background: transparent; color: var(--text-standard); text-align: left; cursor: pointer; }
  .head:hover { background: var(--affordance-ghost-hover); }
  .head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .head :global(.icon) { color: var(--text-subtle); transition: transform var(--duration-base) var(--ease-standard); }
  .open .head :global(.icon) { transform: rotate(90deg); }
  .title { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .name { flex: none; font: var(--text-label-sm); }
  .lead { overflow: hidden; color: var(--text-subtle); font: var(--text-body-sm); text-overflow: ellipsis; white-space: nowrap; }
  .facts { display: flex; align-items: center; gap: var(--space-3); }
  .num { color: var(--text-subtle); font: var(--text-body-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .facts .num { min-width: 5.5em; text-align: right; }
  .facts .use { min-width: 7em; }
  .bad { color: var(--text-danger); }
  .body { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-1) var(--space-3) var(--space-4) calc(var(--space-3) + 16px + var(--space-2)); }
  .desc { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); max-width: 60rem; }
  .meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px var(--space-4); margin: 0; font: var(--text-body-sm); }
  .meta dt { color: var(--text-metadata); }
  .meta dd { margin: 0; color: var(--text-standard); }
  .aside { color: var(--text-subtle); }
  .hidden { display: block; color: var(--text-subtle); }
  .copies { display: flex; flex-direction: column; padding: var(--space-1); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  .crow { display: grid; grid-template-columns: minmax(0, 1fr) 9.5em 10em auto; align-items: center; gap: var(--space-3); min-height: 40px; padding: var(--space-1) var(--space-3); border-radius: 8px; }
  .crow:not(.cols):hover { background: var(--affordance-ghost-hover); }
  .cols { min-height: 28px; color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .where { display: flex; flex-direction: column; min-width: 0; }
  .path { display: flex; min-width: 0; font: var(--text-mono); font-size: 12px; white-space: nowrap; }
  .box { flex: none; margin-right: 0.6em; color: var(--text-metadata); }
  .head-part { overflow: hidden; color: var(--text-subtle); text-overflow: ellipsis; direction: rtl; text-align: left; }
  .tail { flex: none; }
  .sub { color: var(--text-subtle); font: var(--text-caption); }
  .note { color: var(--text-metadata); }
  .acts { display: flex; justify-content: flex-end; gap: 2px; white-space: nowrap; }
  .skill-acts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  @container (width < 760px) {
    .facts .num:not(.use) { display: none; }
    .crow { grid-template-columns: minmax(0, 1fr) auto; }
    .crow > .num { display: none; }
    .cols { display: none; }
  }
</style>
