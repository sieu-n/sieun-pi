<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { agents, api } from "$lib/api";
  import { SKILL_RUNTIMES, THREAD_KINDS, type SkillEntry, type SkillRuntime, type SkillsChange, type SkillsView } from "$lib/api/shared/skills";
  import { ageLabel, Badge, Button, Disclosure, EmptyState, Icon, IconButton, Input, Picker, SearchField, Select, toast, tooltip } from "$lib/ui";
  import type { PickerItem } from "$lib/ui/types";
  import {
    PROBLEMS, ROLE_LABEL, boxNotices, cellFor, columnTitle, driftOf, families, homeBox, kindColumns, ownerLabel, problemCount, rowsFor, sizeOf,
    installDrift, pathTitle, shortPath, sourceLabel, tokensLabel, usesLabel, usesTitle, type Filter, type Problem,
  } from "./kinds-model";

  let { view, reload }: { view: SkillsView; reload: () => Promise<void> } = $props();

  let filter = $state<Filter>("all");
  let text = $state("");
  let showUnused = $state(false);
  const open = new SvelteSet<string>();
  let busy = $state<string | null>(null);
  let moving = $state<{ installId: string; path: string } | null>(null);
  let adding = $state<{ skillId: string; box: string; runtime: SkillRuntime; path: string } | null>(null);
  let picker = $state<{ kind: "merge" | "agent"; entry: SkillEntry; anchor: HTMLElement } | null>(null);
  let pickerOpen = $state(false);
  let unownedOpen = $state(false);

  const columns = $derived(kindColumns(view));
  const groups = families();
  const rows = $derived(rowsFor(view, filter, text));
  const folding = $derived(filter === "all" && !text.trim() && !showUnused);
  const used = $derived(folding ? rows.filter(r => !r.problems.includes("unused")) : rows);
  const hiddenUnused = $derived(rows.length - used.length);
  const notices = $derived(boxNotices(view.boxes));
  const generated = $derived(view.generatedAt ? Date.parse(view.generatedAt) : null);
  const liveAgents = $derived(agents.list.filter(a => a.kind === "chat" && !a.archived && !a.test));
  const agentNames = $derived(new Map(liveAgents.map(a => [a.id as string, a.name])));
  const span = THREAD_KINDS.length + 4;

  const pickerItems = $derived.by((): PickerItem[] => {
    if (!picker) return [];
    const entry = picker.entry;
    if (picker.kind === "agent") return liveAgents.map(a => ({ id: a.id, label: a.name, detail: a.id }));
    return view.skills
      .filter(s => s.id !== entry.id)
      .map(s => ({ id: s.id, label: s.name, detail: sourceLabel(s), group: s.name === entry.name ? "Same name" : "Other skills" }))
      .sort((a, b) => Number(b.group === "Same name") - Number(a.group === "Same name"));
  });

  function setFilter(next: Problem): void {
    filter = filter === next ? "all" : next;
  }

  function toggle(id: string): void {
    if (open.has(id)) open.delete(id);
    else open.add(id);
  }

  function message(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  async function undo(moveId: string): Promise<void> {
    try {
      const result = await api.undoSkillMove({ moveId });
      toast.show(`Undone: ${result.move.summary}`);
      await reload();
    } catch (reason) {
      toast.error(`Undo failed: ${message(reason)}`);
    }
  }

  async function change(key: string, run: () => Promise<SkillsChange>): Promise<boolean> {
    busy = key;
    try {
      const result = await run();
      const steps = result.apply?.steps ?? [];
      const failed = steps.filter(s => s.result === "failed");
      const queued = steps.some(s => s.result === "queued");
      const action = { label: "Undo", run: () => void undo(result.move.id) };
      if (failed.length > 0) toast.error(`${result.move.summary}, but ${failed.length} disk ${failed.length === 1 ? "step" : "steps"} failed: ${failed[0]?.note ?? "no reason given"}`, { action });
      else toast.success(queued ? `${result.move.summary}. The Mac part waits until the Mac wakes.` : result.move.summary, { action });
      await reload();
      return true;
    } catch (reason) {
      toast.error(message(reason));
      return false;
    } finally {
      busy = null;
    }
  }

  function openPicker(kind: "merge" | "agent", entry: SkillEntry, event: MouseEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    picker = { kind, entry, anchor: event.currentTarget };
    pickerOpen = true;
  }

  function pick(id: string): void {
    const current = picker;
    pickerOpen = false;
    picker = null;
    if (!current) return;
    const entry = current.entry;
    if (current.kind === "merge") {
      void change(`merge:${entry.id}`, () => api.mergeSkill({ skillId: entry.id, into: id }));
      return;
    }
    const box = homeBox(entry, view.boxes);
    if (!box) {
      toast.error("No box has scanned yet, so there is nowhere to install it");
      return;
    }
    void change(`agent:${entry.id}`, () => api.installSkill({ name: entry.name, box, runtime: "pi-host", agent: id }));
  }

  function startAdd(entry: SkillEntry): void {
    adding = { skillId: entry.id, box: homeBox(entry, view.boxes) ?? "", runtime: "prime", path: "" };
  }

  async function submitAdd(entry: SkillEntry): Promise<void> {
    const form = adding;
    if (!form || !form.box) return;
    const path = form.path.trim();
    const done = await change(`add:${entry.id}`, () => api.installSkill({ name: entry.name, box: form.box, runtime: form.runtime, path: path || null }));
    if (done) adding = null;
  }

  async function submitMoveInstall(key: string, from: string): Promise<void> {
    const form = moving;
    if (!form) return;
    const path = form.path.trim();
    if (!path || path === from) {
      moving = null;
      return;
    }
    const done = await change(`move:${key}`, () => api.moveSkill({ installId: form.installId, path }));
    if (done) moving = null;
  }

  function onFormKey(event: KeyboardEvent, cancel: () => void): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    }
  }

  const boxOptions = $derived(view.boxes.map(b => ({ value: b.box, label: b.box })));
  const runtimeOptions = SKILL_RUNTIMES.map(r => ({ value: r, label: r }));
</script>

<section class="kinds" data-testid="skills-kinds">
  <div class="counts" role="group" aria-label="Problems">
    {#each PROBLEMS as problem (problem.id)}
      <button type="button" class="count" class:quiet={problem.id === "unused"} aria-pressed={filter === problem.id} onclick={() => setFilter(problem.id)} use:tooltip={problem.hint} data-problem={problem.id}>
        <span class="value">{problemCount(view, problem.id).toLocaleString("en-US")}</span>
        <span class="label">{problem.label}</span>
      </button>
    {/each}
  </div>
  <p class="summary">
    {view.counts.skills.toLocaleString("en-US")} skills in {view.counts.copies.toLocaleString("en-US")} folders on {view.boxes.length === 1 ? "1 box" : `${view.boxes.length} boxes`}.
    {#if generated !== null}Scanned {ageLabel(generated) === "now" ? "just now" : `${ageLabel(generated)} ago`}{view.scan.running ? ", and a new scan runs now." : "."}{/if}
  </p>
  {#each notices as notice (notice.box)}
    <p class="notice" role="status" use:tooltip={notice.error}>{notice.text}</p>
  {/each}
  {#if view.scan.error}<p class="notice bad" role="status" use:tooltip={view.scan.error}>The last scan failed, so this shows the one before it.</p>{/if}

  <div class="controls">
    <div class="search"><SearchField bind:value={text} placeholder="Filter by name, description or folder" label="Filter skills" clearable /></div>
    {#if filter !== "all"}
      <Button variant="ghost" size="sm" icon="close" onclick={() => (filter = "all")}>{PROBLEMS.find(p => p.id === filter)?.label} only</Button>
    {/if}
  </div>

  {#if rows.length === 0}
    <EmptyState icon="filter" title="No skill matches" description="Clear the filter to see every skill." />
  {:else}
    <div class="matrix" role="region" aria-label="Skills by the kinds of thread that see them" tabindex="-1">
      <table>
        <thead>
          <tr>
            <th class="corner" scope="col" rowspan="2">Skill</th>
            <th class="metric" scope="col" rowspan="2">Uses, 30 days</th>
            <th class="metric" scope="col" rowspan="2">Copies</th>
            <th class="metric" scope="col" rowspan="2" use:tooltip={`SKILL.md bytes against the median of our skills, ${view.thresholds.medianBytes.toLocaleString("en-US")} bytes`}>Size</th>
            <th class="metric left" scope="col" rowspan="2">Problems</th>
            {#each groups as group (group.family)}<th class="family" scope="colgroup" colspan={group.span}>{group.family}</th>{/each}
          </tr>
          <tr>
            {#each columns as column (column.kind)}
              <th class="kind" scope="col" use:tooltip={columnTitle(column)} data-kind={column.kind}>
                <span class="kind-label">{column.label}</span>
                <span class="kind-stat">{column.listed} listed</span>
                <span class="kind-stat">{tokensLabel(column.tokens)}</span>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each used as row (row.entry.id)}
            {@const entry = row.entry}
            {@const size = sizeOf(entry.size.bytes, entry.size.lines, view.thresholds)}
            {@const expanded = open.has(entry.id)}
            {@const boxes = [...new Set(entry.copies.map(c => c.box))]}
            <tr class="row" class:expanded data-skill={entry.id}>
              <th scope="row" class="name">
                <button type="button" class="opener" aria-expanded={expanded} aria-controls={`kinds-${entry.id}`} onclick={() => toggle(entry.id)}>
                  <Icon name={expanded ? "chevron-down" : "chevron-right"} size={16} />
                  <span class="skill">{entry.name}</span>
                </button>
              </th>
              <td class="num" class:muted={entry.use.uses === 0} use:tooltip={usesTitle(entry)}>{row.problems.includes("unused") ? "never" : entry.use.uses.toLocaleString("en-US")}</td>
              <td class="num" use:tooltip={`On ${boxes.join(" and ") || "no box"}`}>{entry.copies.length}</td>
              <td class="num" class:bad={size?.bloated} use:tooltip={size?.title}>{size ? (size.ratio ?? size.label) : "?"}</td>
              <td><span class="flags">{#each row.problems.filter(p => p !== "unused") as problem (problem)}<Badge tone={problem === "bloated" ? "danger" : "warning"}>{problem}</Badge>{/each}</span></td>
              {#each THREAD_KINDS as kind (kind)}
                {@const cell = cellFor(entry, kind)}
                <td class="cell {cell.tone}" use:tooltip={cell.title}>{cell.label}</td>
              {/each}
            </tr>
            {#if expanded}
              <tr class="detail" id={`kinds-${entry.id}`}>
                <td colspan={span}>
                  <div class="detail-body">
                    <p class="description" class:missing={!entry.description}>{entry.description || "No description, so no thread knows when to pick it."}</p>
                    <p class="facts">
                      {usesLabel(entry, row.problems.includes("unused"))}. Owned by {ownerLabel(entry, agentNames)}. Source {sourceLabel(entry)}{size ? `, ${size.label}${size.ratio ? `, ${size.ratio}` : ""}` : ""}.
                    </p>
                    {#if entry.verdicts.length > 0}
                      <ul class="verdicts">{#each entry.verdicts as verdict, i (i)}<li>{verdict.detail}</li>{/each}</ul>
                    {/if}

                    <table class="copies">
                      <caption class="sr-only">Copies of {entry.name}</caption>
                      <thead><tr><th scope="col">Box</th><th scope="col">Folder</th><th scope="col">Role</th><th scope="col">Drift</th><th scope="col">Size</th><th scope="col">Loaded by</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {#each entry.copies as copy (copy.id)}
                          {@const install = entry.installs.find(i => i.id === copy.installId) ?? null}
                          {@const drift = driftOf(copy, install)}
                          {@const copySize = sizeOf(copy.bytes, copy.lines, view.thresholds, copy.folderBytes)}
                          <tr data-copy={copy.id}>
                            <td>{copy.box}</td>
                            <td class="path">
                              {#if moving && install && moving.installId === install.id}
                                <form class="inline" onsubmit={event => { event.preventDefault(); void submitMoveInstall(copy.id, copy.path); }}>
                                  <Input size="sm" bind:value={moving.path} aria-label="New folder" onkeydown={event => onFormKey(event, () => (moving = null))} />
                                  <Button size="sm" variant="primary" type="submit" loading={busy === `move:${copy.id}`}>Move</Button>
                                  <Button size="sm" variant="ghost" type="button" onclick={() => (moving = null)}>Cancel</Button>
                                </form>
                              {:else}
                                <span use:tooltip={pathTitle(copy)}>{shortPath(copy.path)}</span>
                                {#if install?.agent}<span class="for">for {agentNames.get(install.agent) ?? install.agent}</span>{/if}
                              {/if}
                            </td>
                            <td>{ROLE_LABEL[copy.role]}</td>
                            <td><span class="drift {drift.tone}" use:tooltip={drift.title}>{drift.label}</span></td>
                            <td class="num" class:bad={copySize?.bloated} use:tooltip={copySize?.title}>{copySize ? copySize.label : "?"}</td>
                            <td>{copy.loadedBy.length ? copy.loadedBy.join(", ") : "nothing"}</td>
                            <td class="actions">
                              {#if copy.role === "unowned"}
                                <Button size="sm" variant="ghost" loading={busy === `adopt:${copy.id}`} onclick={() => void change(`adopt:${copy.id}`, () => api.adoptSkill({ copyId: copy.id, skillId: entry.id }))}>Adopt</Button>
                              {/if}
                              {#if install && !moving}
                                <Button size="sm" variant="ghost" onclick={() => (moving = { installId: install.id, path: copy.path })}>Move</Button>
                              {/if}
                              {#if copy.role !== "source"}
                                <IconButton icon="trash" size="sm" label={`Remove ${copy.box}:${copy.path}`} loading={busy === `remove:${copy.id}`} onclick={() => void change(`remove:${copy.id}`, () => api.removeSkill({ target: copy.id }))} />
                              {/if}
                            </td>
                          </tr>
                        {/each}
                        {#each entry.installs.filter(i => !entry.copies.some(c => c.installId === i.id)) as install (install.id)}
                          {@const drift = installDrift(install)}
                          <tr data-install={install.id}>
                            <td>{install.box}</td>
                            <td class="path">
                              {#if moving && moving.installId === install.id}
                                <form class="inline" onsubmit={event => { event.preventDefault(); void submitMoveInstall(install.id, install.path); }}>
                                  <Input size="sm" bind:value={moving.path} aria-label="New folder" onkeydown={event => onFormKey(event, () => (moving = null))} />
                                  <Button size="sm" variant="primary" type="submit" loading={busy === `move:${install.id}`}>Move</Button>
                                  <Button size="sm" variant="ghost" type="button" onclick={() => (moving = null)}>Cancel</Button>
                                </form>
                              {:else}
                                <span use:tooltip={install.path}>{shortPath(install.path)}</span>
                                {#if install.agent}<span class="for">for {agentNames.get(install.agent) ?? install.agent}</span>{/if}
                              {/if}
                            </td>
                            <td>install</td>
                            <td><span class="drift {drift.tone}" use:tooltip={drift.title}>{drift.label}</span></td>
                            <td class="num">?</td>
                            <td>{install.runtimes.join(", ")}</td>
                            <td class="actions">
                              {#if !moving}<Button size="sm" variant="ghost" onclick={() => (moving = { installId: install.id, path: install.path })}>Move</Button>{/if}
                              <IconButton icon="trash" size="sm" label={`Remove ${install.box}:${install.path}`} loading={busy === `remove:${install.id}`} onclick={() => void change(`remove:${install.id}`, () => api.removeSkill({ target: install.id }))} />
                            </td>
                          </tr>
                        {/each}
                        {#if entry.copies.length === 0 && entry.installs.length === 0}<tr><td colspan="7" class="muted">The last scan saw no folder for it.</td></tr>{/if}
                      </tbody>
                    </table>

                    {#if adding && adding.skillId === entry.id}
                      <form class="inline add" onsubmit={event => { event.preventDefault(); void submitAdd(entry); }}>
                        <Select size="sm" label="Box" showLabel bind:value={adding.box} options={boxOptions} />
                        <Select size="sm" label="For" showLabel bind:value={adding.runtime} options={runtimeOptions} />
                        <Input size="sm" bind:value={adding.path} placeholder="Folder, or empty for the runtime's own" aria-label="Folder" onkeydown={event => onFormKey(event, () => (adding = null))} />
                        <Button size="sm" variant="primary" type="submit" loading={busy === `add:${entry.id}`}>Add</Button>
                        <Button size="sm" variant="ghost" type="button" onclick={() => (adding = null)}>Cancel</Button>
                      </form>
                    {:else}
                      <div class="skill-actions">
                        <Button size="sm" variant="outline" icon="plus" loading={busy === `agent:${entry.id}`} onclick={event => openPicker("agent", entry, event)}>Add to agent</Button>
                        <Button size="sm" variant="outline" icon="folder" onclick={() => startAdd(entry)}>Add to folder</Button>
                        <Button size="sm" variant="outline" loading={busy === `merge:${entry.id}`} onclick={event => openPicker("merge", entry, event)}>Merge into…</Button>
                        <Button size="sm" variant="ghost" icon="trash" loading={busy === `remove:${entry.id}`} onclick={() => void change(`remove:${entry.id}`, () => api.removeSkill({ target: entry.id }))}>Remove skill</Button>
                      </div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
          {#if folding && hiddenUnused > 0}
            <tr class="fold">
              <td colspan={span}>
                <div class="detail-body"><Button size="sm" variant="ghost" icon="chevron-down" onclick={() => (showUnused = true)}>Show {hiddenUnused.toLocaleString("en-US")} skills no thread used in 30 days</Button></div>
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}

  {#if view.unowned.length > 0}
    <Disclosure title={`${view.unowned.length.toLocaleString("en-US")} folders no skill owns`} detail="Adopt one to give it a row, or remove it" bind:open={unownedOpen}>
      <table class="copies" data-testid="skills-unowned">
        <thead><tr><th scope="col">Box</th><th scope="col">Folder</th><th scope="col">Size</th><th scope="col">Loaded by</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each view.unowned as copy (copy.id)}
            {@const copySize = sizeOf(copy.bytes, copy.lines, view.thresholds, copy.folderBytes)}
            <tr data-copy={copy.id}>
              <td>{copy.box}</td>
              <td class="path"><span use:tooltip={pathTitle(copy)}>{shortPath(copy.path)}</span></td>
              <td class="num" class:bad={copySize?.bloated} use:tooltip={copySize?.title}>{copySize ? copySize.label : "?"}</td>
              <td>{copy.loadedBy.length ? copy.loadedBy.join(", ") : "nothing"}</td>
              <td class="actions">
                <Button size="sm" variant="ghost" loading={busy === `adopt:${copy.id}`} onclick={() => void change(`adopt:${copy.id}`, () => api.adoptSkill({ copyId: copy.id }))}>Adopt</Button>
                <IconButton icon="trash" size="sm" label={`Remove ${copy.box}:${copy.path}`} loading={busy === `remove:${copy.id}`} onclick={() => void change(`remove:${copy.id}`, () => api.removeSkill({ target: copy.id }))} />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Disclosure>
  {/if}
</section>

<Picker
  bind:open={pickerOpen}
  anchor={picker?.anchor}
  items={pickerItems}
  searchable
  label={picker?.kind === "merge" ? "Merge into" : "Add to agent"}
  placeholder={picker?.kind === "merge" ? "Find the skill to keep" : "Find an agent"}
  emptyText={picker?.kind === "merge" ? "No other skill" : "No agent"}
  onselect={id => pick(id)}
  onclose={() => (picker = null)}
/>

<style>
  .kinds { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .counts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .count {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 9rem; padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-standard); border-radius: var(--radius-container); background: var(--surface-panel); color: var(--text-standard);
    font: inherit; text-align: left; cursor: pointer;
  }
  .count:hover { border-color: var(--border-prominent); }
  .count[aria-pressed="true"] { border-color: var(--text-standard); box-shadow: inset 0 0 0 1px var(--text-standard); }
  .count .value { font: var(--text-title); font-variant-numeric: tabular-nums; }
  .count .label { color: var(--text-subtle); font: var(--text-body-sm); }
  .count.quiet .value { color: var(--text-subtle); }
  .summary { margin: 0; color: var(--text-subtle); font: var(--text-body); }
  .notice { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .notice.bad { color: var(--text-danger); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .search { flex: 1 1 16rem; max-width: 24rem; }

  .matrix {
    container-type: inline-size; overflow: auto; max-block-size: calc(100dvh - 18rem); min-block-size: 16rem;
    border: 1px solid var(--border-standard); border-radius: var(--radius-container); background: var(--surface-panel);
  }
  table { border-collapse: separate; border-spacing: 0; font: var(--text-body-sm); font-variant-numeric: tabular-nums; }
  .matrix > table { min-width: 100%; }
  thead { position: sticky; inset-block-start: 0; z-index: 2; background: var(--surface-panel); }
  thead th { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--border-standard); color: var(--text-subtle); font: var(--text-caption); font-weight: 400; text-align: left; white-space: nowrap; background: var(--surface-panel); }
  th.family { color: var(--text-standard); border-left: 1px solid var(--border-standard); }
  th.corner { position: sticky; inset-inline-start: 0; z-index: 3; vertical-align: bottom; }
  th.kind { vertical-align: bottom; border-left: 1px solid var(--border-standard); cursor: default; }
  .kind-label { display: block; color: var(--text-standard); font: var(--text-label-sm); }
  .kind-stat { display: block; }
  th.metric { vertical-align: bottom; text-align: right; }
  th.metric.left { text-align: left; }

  tbody th, tbody td { padding: 6px var(--space-2); border-bottom: 1px solid var(--border-standard); text-align: left; font-weight: 400; white-space: nowrap; }
  tbody th.name { position: sticky; inset-inline-start: 0; z-index: 1; background: var(--surface-panel); padding: 0; }
  .row:hover th.name, .row:hover td { background: var(--surface-inset); }
  .row.expanded th.name, .row.expanded td { border-bottom-color: transparent; }
  .opener {
    display: flex; align-items: center; gap: 4px; width: 100%; min-width: 12rem; max-width: 18rem; padding: 6px var(--space-2); border: 0; background: none;
    color: var(--text-standard); font: var(--text-body-sm); font-weight: 500; text-align: left; cursor: pointer;
  }
  .opener .skill { overflow: hidden; text-overflow: ellipsis; }
  .cell { border-left: 1px solid var(--border-standard); color: var(--text-standard); }
  .cell.imported, .cell.inlined { font-weight: 500; }
  .cell.cwd { color: var(--text-subtle); font-style: normal; }
  .cell.hidden { color: var(--text-subtle); opacity: 0.55; }
  .num { text-align: right; }
  .muted { color: var(--text-subtle); }
  .bad { color: var(--text-danger); }
  .flags { display: inline-flex; gap: 4px; }

  .detail td { padding: 0; background: var(--surface-inset); }
  .fold td { padding: 0; }
  .detail-body {
    position: sticky; inset-inline-start: 0; box-sizing: border-box; width: 100cqi; max-width: 100cqi; padding: var(--space-2) var(--space-3) var(--space-3);
    display: flex; flex-direction: column; gap: var(--space-2); white-space: normal;
  }
  .description { margin: 0; max-width: 60rem; color: var(--text-standard); font: var(--text-body); }
  .description.missing { color: var(--text-danger); }
  .facts { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .verdicts { margin: 0; padding-left: var(--space-4); color: var(--text-standard); font: var(--text-body-sm); }
  .copies { width: 100%; background: var(--surface-panel); border: 1px solid var(--border-standard); border-radius: var(--radius-row); }
  .copies th { padding: 4px var(--space-2); border-bottom: 1px solid var(--border-standard); color: var(--text-subtle); font: var(--text-caption); text-align: left; }
  .copies td { padding: 4px var(--space-2); border-bottom: 1px solid var(--border-standard); vertical-align: middle; }
  .copies tbody tr:last-child td { border-bottom: 0; }
  .copies .path { max-width: 34rem; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 12px; }
  .copies .for { margin-left: var(--space-1); color: var(--text-subtle); font-family: var(--font-sans, inherit); }
  .drift.ok { color: var(--text-subtle); }
  .drift.warn { color: var(--text-standard); font-weight: 500; }
  .drift.bad { color: var(--text-danger); font-weight: 500; }
  .drift.muted { color: var(--text-subtle); }
  .actions { display: flex; justify-content: flex-end; align-items: center; gap: 2px; }
  .skill-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .inline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
  .inline.add :global(.input) { flex: 1 1 18rem; max-width: 28rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
