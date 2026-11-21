<script lang="ts">
  import { api } from "$lib/api";
  import { SKILL_RUNTIMES, type SkillCopy, type SkillEntry, type SkillRuntime, type SkillsChange, type SkillsView } from "$lib/api/shared/skills";
  import { Button, Dialog, EmptyState, Field, Input, SearchField, Select, ageLabel, toast, tooltip } from "$lib/ui";
  import { SvelteSet } from "svelte/reactivity";
  import SkillRow from "./SkillRow.svelte";
  import { GROUP_TEXT, PROBLEMS, healthy, names, problemGroups, tilde, type Problem, type RowActions } from "./model";

  /**
   * Settings > Skills, by problem: the duplicated, outdated and bloated counts, each a filter, then the skills grouped by problem worst
   * first, then the healthy skills by use. Every button calls the skills API, reloads the view and offers Undo in a toast; the click is
   * the owner's approval, so nothing asks again.
   */
  type Props = { view: SkillsView; reload: () => Promise<void> };

  /** How long a change's Undo stays up: 10 s, as the wiki pane's Page saved toast (deeac18c) and the Accounts remove toast keep theirs. */
  const UNDO_MS = 10_000;
  let { view, reload }: Props = $props();

  let only = $state<Problem | null>(null);
  const opened = new SvelteSet<string>();
  const toggler = (key: string) => () => (opened.has(key) ? opened.delete(key) : opened.add(key));
  let text = $state("");
  let busy = $state<string | null>(null);

  type Form =
    | { kind: "install"; skillId: string; box: string; runtime: SkillRuntime; agent: string; mode: "link" | "copy"; path: string; locked: boolean }
    | { kind: "move"; skill: string; installId: string; box: string; from: string; path: string };
  let form = $state<Form | null>(null);
  let formOpen = $state(false);
  let formError = $state<string | null>(null);

  const groups = $derived(problemGroups(view.skills, only, text));
  const rest = $derived(only === null ? healthy(view.skills, text) : []);
  const used = $derived(rest.filter(skill => skill.use.uses > 0));
  const unused = $derived(rest.filter(skill => skill.use.uses === 0));
  const labels = $derived(names(view.skills));
  const nameOf = (id: string): string => labels.get(id) ?? id;
  const now = Date.now();
  const boxNames = $derived(view.boxes.map(box => box.box));
  const choices = $derived([{ value: "", label: "Pick a skill" }, ...[...view.skills].sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id))).map(s => ({ value: s.id, label: nameOf(s.id) }))]);
  const scanned = $derived(view.generatedAt ? Date.parse(view.generatedAt) : null);

  const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

  async function change(key: string, call: () => Promise<SkillsChange>, text: { said: string; undone: string; same?: string }): Promise<boolean> {
    busy = key;
    try {
      const done = await call();
      await reload();
      const queued = done.apply?.steps.filter(step => step.result === "queued").length ?? 0;
      const failed = done.apply?.steps.filter(step => step.result === "failed") ?? [];
      const tail = failed.length ? `, but ${failed.length} disk ${failed.length === 1 ? "step" : "steps"} failed` : queued ? `, and it waits for the Mac to wake` : "";
      const said = text.same && done.apply?.changes === 0 ? text.same : `${text.said}${tail}`;
      toast.show(said, { tone: failed.length ? "danger" : "neutral", duration: UNDO_MS, action: { label: "Undo", run: () => void undo(done.move.id, text.undone) } });
      return true;
    } catch (reason) {
      toast.error(message(reason));
      return false;
    } finally {
      busy = null;
    }
  }

  async function undo(moveId: string, undone: string): Promise<void> {
    try {
      await api.undoSkillMove({ moveId });
      await reload();
      toast.show(undone);
    } catch (reason) {
      toast.error(`Undo failed: ${message(reason)}`);
    }
  }

  function openInstall(skillId = "", locked = false): void {
    form = { kind: "install", skillId, box: boxNames[0] ?? "", runtime: "prime", agent: "", mode: "link", path: "", locked };
    formError = null;
    formOpen = true;
  }

  const act: RowActions = {
    removeCopy: (skill: SkillEntry, copy: SkillCopy) =>
      void change(copy.id, () => api.removeSkill({ target: copy.id }), {
        said: `Removed ${nameOf(skill.id)} at ${copy.box}:${tilde(copy.path)}`,
        undone: `Put ${nameOf(skill.id)} back at ${copy.box}:${tilde(copy.path)}`,
      }),
    removeSkill: (skill: SkillEntry) =>
      void change(skill.id, () => api.removeSkill({ target: skill.id }), { said: `Removed ${nameOf(skill.id)} and its installs`, undone: `Put ${nameOf(skill.id)} and its installs back` }),
    adopt: (skill: SkillEntry, copy: SkillCopy) =>
      void change(copy.id, () => api.adoptSkill({ copyId: copy.id, skillId: skill.id }), {
        said: `${copy.box}:${tilde(copy.path)} is now an install of ${nameOf(skill.id)}`,
        undone: `${copy.box}:${tilde(copy.path)} has no DB row again`,
      }),
    merge: (skill: SkillEntry, into: string) =>
      void change(skill.id, () => api.mergeSkill({ skillId: skill.id, into }), {
        said: `Agent factory merges ${nameOf(skill.id)} into ${nameOf(into)} and checks it first`,
        undone: `Called off the merge of ${nameOf(skill.id)}`,
      }),
    install: (skill: SkillEntry) => openInstall(skill.id, true),
    move: (skill: SkillEntry, copy: SkillCopy) => {
      if (!copy.installId) return;
      form = { kind: "move", skill: skill.id, installId: copy.installId, box: copy.box, from: copy.path, path: copy.path };
      formError = null;
      formOpen = true;
    },
  };

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const f = form;
    if (!f) return;
    let ok: boolean;
    if (f.kind === "install") {
      const skill = view.skills.find(s => s.id === f.skillId);
      if (!skill) {
        formError = "Pick the skill to install.";
        return;
      }
      const where = `${f.box}${f.path.trim() ? `:${tilde(f.path.trim())}` : ""}`;
      ok = await change(
        "form",
        () => api.installSkill({ name: skill.name, source: skill.id, box: f.box, runtime: f.runtime, mode: f.mode, agent: f.agent.trim() || null, path: f.path.trim() || null }),
        { said: `Installed ${nameOf(skill.id)} on ${where} for ${f.runtime}`, undone: `Took the new install of ${nameOf(skill.id)} off ${f.box}`, same: `${nameOf(skill.id)} was already installed there` },
      );
    } else {
      const to = f.path.trim();
      if (!to || to === f.from) {
        formError = "Give a new folder.";
        return;
      }
      ok = await change("form", () => api.moveSkill({ installId: f.installId, path: to }), {
        said: `Moved ${nameOf(f.skill)} to ${f.box}:${tilde(to)}`,
        undone: `Moved ${nameOf(f.skill)} back to ${f.box}:${tilde(f.from)}`,
      });
    }
    if (ok) formOpen = false;
  }

  const toggle = (problem: Problem): void => {
    only = only === problem ? null : problem;
  };
</script>

<div class="layout" data-testid="skills-layout-problem">
  {#each view.boxes.filter(box => box.state !== "ok") as box (box.box)}
    <p class="offline" role="status" use:tooltip={box.error ?? ""}>
      {box.message ?? (box.state === "never" ? `${box.box} has not been scanned yet.` : `${box.box} is offline.`)}
    </p>
  {/each}
  {#if view.scan.error}<p class="offline" role="status" use:tooltip={view.scan.error}>The last scan failed, so this shows the one before it.</p>{/if}

  <div class="top">
    <div class="counts" role="group" aria-label="Show one problem">
      {#each PROBLEMS as problem (problem)}
        <button type="button" class="count" aria-pressed={only === problem} onclick={() => toggle(problem)} data-testid="problem-count-{problem}">
          <span class="n">{view.counts[problem].toLocaleString("en-US")}</span>
          <span class="what">{GROUP_TEXT[problem].title.toLowerCase()}</span>
        </button>
      {/each}
    </div>
    <div class="side">
      <p class="totals">
        {view.counts.skills.toLocaleString("en-US")} skills in {view.counts.copies.toLocaleString("en-US")} folders, {view.counts.neverUsed.toLocaleString("en-US")} never used in 30 days.
        {#if scanned !== null}Scanned {ageLabel(scanned, now)} ago.{/if}
      </p>
      <div class="tools">
        <div class="search"><SearchField bind:value={text} placeholder="Filter by name or folder" label="Filter skills" clearable /></div>
        <Button variant="primary" size="sm" icon="plus" onclick={() => openInstall()} data-testid="add-skill">Add skill</Button>
      </div>
    </div>
  </div>

  {#each groups as group (group.kind)}
    <section class="group" aria-labelledby="problem-{group.kind}" data-testid="problem-group-{group.kind}">
      <header>
        <h2 id="problem-{group.kind}">{GROUP_TEXT[group.kind].title} <span class="k">{group.skills.length}</span></h2>
        <p>{GROUP_TEXT[group.kind].description}</p>
      </header>
      <div class="list">
        {#each group.skills as skill (skill.id)}<SkillRow {skill} kind={group.kind} limits={view.thresholds} {nameOf} {busy} {act} open={opened.has(`${group.kind}:${skill.id}`)} ontoggle={toggler(`${group.kind}:${skill.id}`)} />{/each}
      </div>
    </section>
  {/each}

  {#if only === null && used.length}
    <section class="group" aria-labelledby="problem-healthy" data-testid="problem-group-healthy">
      <header>
        <h2 id="problem-healthy">Healthy <span class="k">{used.length}</span></h2>
        <p>No duplicate, drift or bloat. Most used in 30 days first.</p>
      </header>
      <div class="list">
        {#each used as skill (skill.id)}<SkillRow {skill} kind={null} limits={view.thresholds} {nameOf} {busy} {act} open={opened.has(`healthy:${skill.id}`)} ontoggle={toggler(`healthy:${skill.id}`)} />{/each}
      </div>
    </section>
  {/if}

  {#if only === null && unused.length}
    <section class="group" aria-labelledby="problem-unused" data-testid="problem-group-unused">
      <header>
        <h2 id="problem-unused">Never used <span class="k">{unused.length}</span></h2>
        <p>No session opened or called these in 30 days. A weak description may be why, so the ones we wrote say to review it before any removal.</p>
      </header>
      <div class="list">
        {#each unused as skill (skill.id)}<SkillRow {skill} kind={null} limits={view.thresholds} {nameOf} {busy} {act} open={opened.has(`healthy:${skill.id}`)} ontoggle={toggler(`healthy:${skill.id}`)} />{/each}
      </div>
    </section>
  {/if}

  {#if groups.length === 0 && rest.length === 0}
    <EmptyState icon="filter" title={text ? "No skill matches" : "No skill has this problem"} description={text ? "Clear the filter to see every skill." : "Pick another count to see its skills."} />
  {/if}
</div>

{#if form}
  <Dialog bind:open={formOpen} title={form.kind === "install" ? (form.locked ? `Install ${nameOf(form.skillId)}` : "Add skill") : `Move ${nameOf(form.skill)}`} dirty={busy === "form"} onclose={() => (formError = null)}>
    <form id="skill-form" class="form" onsubmit={submit}>
      {#if form.kind === "install"}
        {#if !form.locked}
          <Field label="Skill" id="sf-skill" hint="A skill the table holds. A new skill starts as a commit in its git source."><Select id="sf-skill" label="Skill" bind:value={form.skillId} options={choices} /></Field>
        {/if}
        <div class="pair">
          <Field label="Box" id="sf-box"><Select id="sf-box" label="Box" bind:value={form.box} options={boxNames.map(b => ({ value: b, label: b }))} /></Field>
          <Field label="Runtime" id="sf-runtime"><Select id="sf-runtime" label="Runtime" bind:value={form.runtime} options={SKILL_RUNTIMES.map(r => ({ value: r, label: r }))} /></Field>
          <Field label="As" id="sf-mode"><Select id="sf-mode" label="As" bind:value={form.mode} options={[{ value: "link", label: "link" }, { value: "copy", label: "copy" }]} /></Field>
        </div>
        <Field label="Folder" id="sf-path" optional hint="Empty puts it in the runtime's skills folder on that box."><Input id="sf-path" bind:value={form.path} autocomplete="off" /></Field>
        <Field label="For agent" id="sf-agent" optional hint="An agent id such as ag_vent, to record which agent asked for it."><Input id="sf-agent" bind:value={form.agent} autocomplete="off" /></Field>
      {:else}
        <p class="from">Now at <code>{form.box}:{tilde(form.from)}</code></p>
        <Field label="New folder" id="sf-move" error={formError}><Input id="sf-move" bind:value={form.path} data-autofocus autocomplete="off" /></Field>
      {/if}
      {#if formError && form.kind === "install"}<p class="error" role="alert">{formError}</p>{/if}
    </form>
    {#snippet actions()}
      <Button variant="ghost" onclick={() => (formOpen = false)}>Cancel</Button>
      <Button variant="primary" type="submit" form="skill-form" loading={busy === "form"}>{form?.kind === "move" ? "Move" : "Install"}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .layout { display: flex; flex-direction: column; gap: var(--space-6); container-type: inline-size; }
  .offline { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-6); }
  .counts { display: flex; gap: var(--space-2); }
  .count { display: flex; flex-direction: column; align-items: flex-start; min-width: 8rem; padding: var(--space-3) var(--space-4); border: 0; border-radius: 12px; background: transparent; box-shadow: inset 0 0 0 1px var(--border-standard); color: var(--text-standard); text-align: left; cursor: pointer; }
  .count:hover { background: var(--affordance-ghost-hover); }
  .count:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
  .count[aria-pressed="true"] { background: var(--interaction-selected); box-shadow: inset 0 0 0 1.5px var(--border-prominent); }
  .n { font: var(--text-title); font-variant-numeric: tabular-nums; }
  .what { color: var(--text-subtle); font: var(--text-body-sm); }
  .side { display: flex; flex: 1 1 20rem; flex-direction: column; gap: var(--space-2); min-width: 0; }
  .totals { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .tools { display: flex; align-items: center; gap: var(--space-2); }
  .search { flex: 1 1 14rem; max-width: 24rem; }
  .group { display: flex; flex-direction: column; gap: var(--space-2); }
  .group header { display: flex; flex-direction: column; gap: 2px; padding: 0 var(--space-3); }
  .group h2 { margin: 0; font: var(--text-heading); }
  .k { color: var(--text-metadata); font-variant-numeric: tabular-nums; }
  .group p { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .list { display: flex; flex-direction: column; padding: var(--space-1); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  .form { display: flex; flex-direction: column; gap: var(--space-4); }
  .pair { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  .from { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .error { margin: 0; color: var(--text-danger); font: var(--text-body-sm); }
</style>
