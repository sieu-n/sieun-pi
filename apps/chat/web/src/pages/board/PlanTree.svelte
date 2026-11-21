<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { agents as agentList, api, requestId, type BoardOp, type ChatAgent, type PlanItem } from "$lib/api";
  import { Badge, Button, Chip, Dialog, EmptyState, IconButton, IdChip, Icon, Input, Menu, TextArea, toast, type MenuEntry } from "$lib/ui";
  import PlanMark from "./PlanMark.svelte";
  import { router } from "$lib/router.svelte";
  import { boardHref } from "./chips";
  import { NO_FILTER, filterActive, filterPlan, menuCount, pathIds, planOwners, type PlanFilter } from "./plan-filter";
  import {
    STATUS_LABEL, finishedSteps, firstSentence, isFinished, ownerName, parentIds, pathTo, planGroups, stepProgress, treeRows, waitWords,
    type Row, type Step,
  } from "./model";

  let {
    chatId,
    plan,
    awaitingGo,
    agents = [],
    where,
    focus = null,
    onboardid,
    onops,
    draft = $bindable(null),
  }: {
    chatId: string;
    plan: PlanItem[];
    awaitingGo: ReadonlySet<string>;
    agents?: ChatAgent[];
    where: "panel" | "page";
    focus?: string | null;
    onboardid?: (id: string) => void;
    /** Applies the owner's plan ops; without it the plan is read only. */
    onops?: (ops: BoardOp[]) => Promise<void>;
    /** The new step being typed: at the top level (parent null) or under a step. */
    draft?: { parent: string | null } | null;
  } = $props();

  const steps = $derived(plan as Step[]);
  let openIds = $state(new Set<string>());
  let shownDone = $state(new Set<string>());
  let notesOpen = $state(new Set<string>());
  let flash = $state<string | null>(null);
  let root = $state<HTMLElement>();

  /** The Find field and the Filter menu, as Slack Lists has them: the plan shows only matching steps and the path above each. */
  let filter = $state<PlanFilter>(NO_FILTER);
  let finding = $state(false);
  let filterMenuOpen = $state(false);
  let filterAnchor = $state<HTMLElement>();
  const ownerOf = (step: Step): string | null => agentOf(step)?.name ?? ownerName(step);
  const filtering = $derived(filterActive(filter));
  const cut = $derived(filtering ? filterPlan(steps, filter, { awaitingGo, ownerOf }) : null);
  const cutOpen = $derived(new Set(cut ? pathIds(cut.plan) : []));
  const isOpen = (id: string): boolean => (cut ? cutOpen.has(id) : openIds.has(id));
  const clearFilter = () => { filter = NO_FILTER; finding = false; };

  const view = $derived({ open: isOpen, showDone: (parent: string) => filtering || shownDone.has(parent) });
  const shownSteps = $derived((cut?.plan ?? steps).filter(step => !deleting.has(step.id)));
  const doneOpen = $derived(filtering || shownDone.has("top"));
  /** A new top-level step is a To do step, so its field sits at the end of To do, which shows for it while it is typed. */
  const groups = $derived.by(() => {
    const list = planGroups(shownSteps);
    if (draft?.parent !== null || list.some(group => group.status === "todo")) return list;
    const at = list.findIndex(group => group.status === "blocked");
    const todo = { status: "todo" as const, steps: [] };
    return at < 0 ? [...list, todo] : [...list.slice(0, at), todo, ...list.slice(at)];
  });
  const finished = $derived(finishedSteps(shownSteps));
  const allIds = $derived(parentIds(steps));
  const anyOpen = $derived(allIds.some(id => openIds.has(id)));

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  /** One level of rows: a row's own steps render inside its <li>, so the rows of a list never include its grandchildren. */
  function rowsOf(list: Step[], key: string): Row[] {
    return treeRows(list, { ...view, open: () => false }, key);
  }

  $effect(() => {
    const id = focus;
    if (!id) return;
    const path = pathTo(steps, id);
    if (!path) return;
    untrack(() => {
      if (cut && !cut.matches.has(id)) clearFilter();
      openIds = new Set([...openIds, ...path.slice(0, -1).map(step => step.id)]);
      if (path.some(isFinished)) shownDone = new Set([...shownDone, "top", ...path.map(step => step.id)]);
      flash = id;
    });
    void tick().then(() => root?.querySelector(`[data-step="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    const timer = setTimeout(() => { if (flash === id) flash = null; }, 2400);
    return () => clearTimeout(timer);
  });

  function agentOf(step: Step): ChatAgent | undefined {
    return agents.find(agent => agent.steps.includes(step.id) || (step.sessionId && agent.sessionId === step.sessionId) || (step.job && agent.job === step.job));
  }

  const agentName = $derived(agentList.byId(chatId)?.name ?? "the agent");
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /** Runs the owner's ops; `undo` puts an Undo on the toast that says what changed. */
  async function run(ops: BoardOp[], said?: string, undo?: BoardOp[]): Promise<boolean> {
    if (!onops) return false;
    try {
      await onops(ops);
    } catch (error) {
      toast.error(message(error));
      return false;
    }
    if (said) toast.show(said, undo ? { action: { label: "Undo", run: () => void run(undo) } } : {});
    return true;
  }

  const setStatus = (step: Step, status: Step["status"]) =>
    run([{ op: "plan_update", id: step.id, status }], `${step.id} is ${STATUS_LABEL[status].toLowerCase()}`, [{ op: "plan_update", id: step.id, status: step.status }]);

  let editing = $state<string | null>(null);
  let editText = $state("");
  function rename(step: Step) {
    editing = step.id;
    editText = step.text;
  }
  async function saveRename(step: Step) {
    const text = editText.trim();
    editing = null;
    if (text && text !== step.text) await run([{ op: "plan_update", id: step.id, text }], `Renamed ${step.id}`, [{ op: "plan_update", id: step.id, text: step.text }]);
  }

  let draftText = $state("");
  function addUnder(parent: string | null) {
    if (parent) openIds = new Set([...openIds, parent]);
    draftText = "";
    draft = { parent };
  }
  /** Enter saves the step and keeps the field open for the next one, as Slack Lists' new row does. */
  async function saveDraft() {
    const text = draftText.trim();
    if (!text || !draft) return;
    const parent = draft.parent;
    draftText = "";
    await run([{ op: "plan_add", text, ...(parent ? { parent } : {}) }]);
  }

  /** A delete waits out its toast, so Undo puts the step back with its id and its steps; leaving the board sends the ones still waiting. */
  let deleting = $state(new Set<string>());
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const DELETE_UNDO_MS = 6000;
  function commitDelete(id: string) {
    clearTimeout(pending.get(id));
    pending.delete(id);
    void run([{ op: "plan_remove", id }]).finally(() => { deleting = new Set([...deleting].filter(other => other !== id)); });
  }
  function remove(step: Step) {
    const below = stepCount(step.children);
    deleting = new Set([...deleting, step.id]);
    pending.set(step.id, setTimeout(() => commitDelete(step.id), DELETE_UNDO_MS));
    toast.show(`Deleted ${step.id}${below ? ` and its ${below} ${below === 1 ? "step" : "steps"}` : ""}`, {
      duration: DELETE_UNDO_MS,
      action: { label: "Undo", run: () => { clearTimeout(pending.get(step.id)); pending.delete(step.id); deleting = new Set([...deleting].filter(id => id !== step.id)); } },
    });
  }
  onDestroy(() => { for (const id of [...pending.keys()]) commitDelete(id); });
  const stepCount = (list: readonly Step[]): number => list.reduce((sum, step) => sum + 1 + stepCount(step.children), 0);

  /** The steps the row sits among on screen, and the whole list it sits in, for Move up and Move down. */
  function neighbours(step: Step, parent: string): { all: Step[]; shown: Step[] } {
    const all = parent === "top" ? steps : (pathTo(steps, parent)?.at(-1)?.children ?? []);
    const shown = parent === "top"
      ? all.filter(other => (isFinished(step) ? isFinished(other) : other.status === step.status))
      : all.filter(other => !isFinished(other) || shownDone.has(parent));
    return { all, shown: shown.filter(other => !deleting.has(other.id)) };
  }
  let moved = $state("");
  function move(step: Step, parent: string, by: -1 | 1) {
    const { all, shown } = neighbours(step, parent);
    const other = shown[shown.indexOf(step) + by];
    if (!other) return;
    const before = by < 0 ? other.id : (all[all.indexOf(other) + 1]?.id ?? null);
    moved = `Moved ${step.id} ${by < 0 ? "up" : "down"}`;
    void run([{ op: "plan_update", id: step.id, before }]);
  }

  let asking = $state<Step | null>(null);
  let askText = $state("");
  /** The question goes to the agent's DM, naming the step, so the answer lands where the rest of the talk with that agent is. */
  async function ask() {
    const step = asking;
    const text = askText.trim();
    if (!step || !text) return;
    const room = agentList.room(chatId);
    try {
      await api.send(room, { text: `About ${step.id} "${step.text}": ${text}`, requestId: requestId() });
    } catch (error) {
      toast.error(message(error));
      return;
    }
    asking = null;
    askText = "";
    toast.show(`Sent to ${agentName}`, { action: { label: "View", run: () => router.openConversation(room, {}) } });
  }

  let menu = $state<{ step: string; anchor: HTMLElement | { x: number; y: number }; items: MenuEntry[] } | null>(null);
  function stepMenu(step: Step, parent: string): MenuEntry[] {
    const { shown } = neighbours(step, parent);
    const at = shown.indexOf(step);
    return [
      isFinished(step)
        ? { id: "reopen", label: "Reopen", icon: "refresh", onselect: () => void setStatus(step, "todo") }
        : { id: "done", label: "Mark done", icon: "check", onselect: () => void setStatus(step, "done") },
      { type: "submenu", id: "status", label: "Status", items: (["todo", "doing", "blocked", "done", "dropped"] as const).map(status => (
        { type: "radio", id: `status-${status}`, group: "status", label: STATUS_LABEL[status], checked: step.status === status, onselect: () => void setStatus(step, status) })) },
      { type: "separator" },
      { id: "rename", label: "Rename", icon: "edit", onselect: () => rename(step) },
      { id: "add", label: "Add step under", icon: "plus", onselect: () => addUnder(step.id) },
      { id: "up", label: "Move up", icon: "arrow-up", disabled: filtering || at <= 0, onselect: () => move(step, parent, -1) },
      { id: "down", label: "Move down", icon: "arrow-down", disabled: filtering || at < 0 || at >= shown.length - 1, onselect: () => move(step, parent, 1) },
      { type: "separator" },
      { id: "ask", label: `Ask ${agentName} about it`, icon: "reply", onselect: () => { askText = ""; asking = step; } },
      { type: "separator" },
      { id: "delete", label: "Delete step", icon: "trash", tone: "danger", onselect: () => remove(step) },
    ];
  }
  const focusField = (input: HTMLInputElement) => { input.focus(); input.select(); };

  const STATUSES = ["doing", "todo", "blocked", "done", "dropped"] as const;
  const owners = $derived(planOwners(steps, ownerOf));
  const filterItems = $derived<MenuEntry[]>([
    { type: "label", label: "Status" },
    ...STATUSES.map(status => ({
      type: "checkbox" as const, id: `filter-${status}`, label: STATUS_LABEL[status], checked: filter.statuses.has(status),
      onselect: (checked: boolean) => {
        const statuses = new Set(filter.statuses);
        if (checked) statuses.add(status);
        else statuses.delete(status);
        filter = { ...filter, statuses };
      },
    })),
    { type: "separator" },
    {
      type: "checkbox", id: "filter-go", label: "Needs your go", detail: awaitingGo.size ? String(awaitingGo.size) : undefined, checked: filter.needsGo,
      disabled: !awaitingGo.size && !filter.needsGo, onselect: (checked: boolean) => { filter = { ...filter, needsGo: checked }; },
    },
    ...(owners.length ? [{
      type: "submenu" as const, id: "filter-owner", label: "Owner", icon: "robot", detail: filter.owner ?? undefined,
      items: [
        { type: "radio" as const, id: "owner-any", group: "owner", label: "Anyone", checked: filter.owner === null, onselect: () => { filter = { ...filter, owner: null }; } },
        ...owners.map(owner => ({
          type: "radio" as const, id: `owner-${owner.name}`, group: "owner", label: owner.name, detail: String(owner.count), checked: filter.owner === owner.name,
          onselect: () => { filter = { ...filter, owner: owner.name }; },
        })),
      ],
    }] : []),
    { type: "separator" },
    { id: "filter-clear", label: "Clear filters", icon: "close", disabled: !filtering, onselect: clearFilter },
  ]);
</script>

{#snippet stepRow(row: Row)}
  {#if row.kind === "finished"}
    <li class="finished" style:--depth={row.depth}>
      <button type="button" class="fold-done t-caption" aria-pressed={row.shown} onclick={() => { shownDone = toggle(shownDone, row.parent); }}>
        <Icon name={row.shown ? "chevron-down" : "chevron-right"} size={14} />{row.shown ? "Hide done" : `Show done (${row.count})`}
      </button>
    </li>
  {:else if !deleting.has(row.step.id)}
    {@const step = row.step}
    {@const progress = stepProgress(step)}
    {@const wait = waitWords(step)}
    {@const agent = agentOf(step)}
    {@const owner = agent?.name ?? ownerName(step)}
    {@const open = isOpen(step.id)}
    <li class="row-item" style:--depth={row.depth}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row {step.status}"
        class:context={cut !== null && !cut.matches.has(step.id)}
        class:flash={flash === step.id}
        class:menu-open={menu?.step === step.id}
        data-step={step.id}
        oncontextmenu={onops && editing !== step.id ? (e) => { e.preventDefault(); menu = { step: step.id, anchor: { x: e.clientX, y: e.clientY }, items: stepMenu(step, row.parent) }; } : undefined}
      >
        <span class="disclosure">
          {#if step.children.length}
            <IconButton size="xs" icon={open ? "chevron-down" : "chevron-right"} label="{open ? 'Collapse' : 'Expand'} {step.id}" onclick={() => { openIds = toggle(openIds, step.id); }} />
          {/if}
        </span>
        <PlanMark status={step.status} />
        <div class="label">
          {#if editing === step.id}
            <Input
              size="sm"
              bind:value={editText}
              aria-label="Rename {step.id}"
              {@attach focusField}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void saveRename(step); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editing = null; }
              }}
              onblur={() => { if (editing === step.id) editing = null; }}
            />
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span class="text t-body-sm" class:struck={isFinished(step)} ondblclick={onops ? () => rename(step) : undefined}>{step.text}</span>
          {/if}
          {#if where === "page" && step.note}
            {@const cut = firstSentence(step.note)}
            {@const whole = notesOpen.has(step.id)}
            <button type="button" class="note t-caption" disabled={!cut.cut} onclick={() => { notesOpen = toggle(notesOpen, step.id); }}>{whole ? step.note : cut.text}</button>
          {/if}
          {#if where === "page" && step.requirements?.length}
            <ul class="reqs">
              {#each step.requirements as req, index (index)}
                <li class="t-caption"><span class="req-status {req.status}">{req.status}</span> {req.text}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <div class="details">
          <IdChip id={step.id} {chatId} href={boardHref(chatId, step.id)} title="{step.id} · {STATUS_LABEL[step.status]}" onclick={onboardid ? (e: MouseEvent) => { e.preventDefault(); onboardid(step.id); } : undefined} />
          {#if progress}<span class="progress t-caption">{progress.done} of {progress.total} done</span>{/if}
          {#if owner && (where === "page" || !progress)}
            <Chip size="sm" icon="robot" label={owner} onclick={agent?.sessionId ? () => router.openConversation(agent.sessionId!, {}) : undefined} />
          {/if}
          {#if wait && !progress}<span class="wait t-caption" title={wait}>{wait}</span>{/if}
          {#if awaitingGo.has(step.id)}<Badge tone="accent" title="This step waits for your go in For you">needs your go</Badge>{/if}
          {#if onops}
            <span class="more">
              <IconButton size="xs" icon="more" label="{step.id} actions" aria-haspopup="menu" aria-expanded={menu?.step === step.id}
                onclick={(e: MouseEvent) => { menu = { step: step.id, anchor: e.currentTarget as HTMLElement, items: stepMenu(step, row.parent) }; }} />
            </span>
          {/if}
        </div>
      </div>
      {#if (step.children.length && open) || draft?.parent === step.id}
        <ul class="list children">
          {#each rowsOf(step.children, step.id) as child (child.kind === "step" ? child.step.id : `${child.parent}/done`)}{@render stepRow(child)}{/each}
          {#if draft?.parent === step.id}{@render draftRow()}{/if}
        </ul>
      {/if}
    </li>
  {/if}
{/snippet}

{#snippet draftRow()}
  <li class="row-item">
    <div class="row todo">
      <span class="disclosure"></span>
      <PlanMark status="todo" />
      <Input
        size="sm"
        bind:value={draftText}
        placeholder="New step, Enter to add"
        aria-label={draft?.parent ? `New step under ${draft.parent}` : "New step"}
        {@attach focusField}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void saveDraft(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); draft = null; }
        }}
        onblur={() => { draft = null; }}
      />
    </div>
  </li>
{/snippet}

<div class="plan" bind:this={root}>
  {#if steps.length || onops}
    <div class="plan-tools">
      {#if steps.length}
        {#if finding || filter.query}
          <span class="find">
            <Input
              size="sm"
              icon="search"
              value={filter.query}
              oninput={(e: Event) => { filter = { ...filter, query: (e.currentTarget as HTMLInputElement).value }; }}
              placeholder="Find steps"
              aria-label="Find steps"
              {@attach focusField}
              onkeydown={(e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); filter = { ...filter, query: "" }; finding = false; } }}
              onblur={() => { if (!filter.query.trim()) { filter = { ...filter, query: "" }; finding = false; } }}
            />
          </span>
        {:else}
          <button type="button" class="tool t-caption" onclick={() => { finding = true; }}><Icon name="search" size={14} />Find</button>
        {/if}
        <button type="button" class="tool t-caption" class:on={menuCount(filter) > 0} bind:this={filterAnchor} aria-haspopup="menu" aria-expanded={filterMenuOpen}
          onclick={() => { filterMenuOpen = !filterMenuOpen; }}><Icon name="filter" size={14} />Filter{menuCount(filter) ? ` ${menuCount(filter)}` : ""}</button>
      {/if}
      {#if cut}
        <span class="tally t-caption" aria-live="polite">{cut.matches.size} of {cut.total}</span>
        <button type="button" class="tool t-caption" onclick={clearFilter}>Clear</button>
      {:else}
        {#if onops}<button type="button" class="tool t-caption" onclick={() => addUnder(null)}><Icon name="plus" size={14} />Add step</button>{/if}
        {#if allIds.length}<button type="button" class="tool t-caption" onclick={() => { openIds = anyOpen ? new Set() : new Set(allIds); }}>{anyOpen ? "Collapse all" : "Expand all"}</button>{/if}
      {/if}
    </div>
  {/if}
  {#if cut && !cut.plan.length}
    <EmptyState icon="filter" title="No steps match" description="Change the words or the filter to see more of the plan." size="sm">
      {#snippet action()}<Button size="sm" onclick={clearFilter}>Clear filters</Button>{/snippet}
    </EmptyState>
  {/if}
  {#each groups as group (group.status)}
    <section class="group" aria-label={STATUS_LABEL[group.status]}>
      <h3 class="heading t-label-sm">{STATUS_LABEL[group.status]} <span class="count">{group.steps.length}</span></h3>
      <ul class="list">
        {#each group.steps as step (step.id)}
          {@render stepRow({ kind: "step", step, depth: 0, parent: "top" })}
        {/each}
        {#if group.status === "todo" && draft?.parent === null}{@render draftRow()}{/if}
      </ul>
    </section>
  {/each}
  {#if finished.length}
    <section class="group" aria-label="Done">
      <button type="button" class="heading t-label-sm fold-group" aria-expanded={doneOpen} disabled={filtering} onclick={() => { shownDone = toggle(shownDone, "top"); }}>
        <Icon name={doneOpen ? "chevron-down" : "chevron-right"} size={14} />Done <span class="count">{finished.length}</span>
      </button>
      {#if doneOpen}
        <ul class="list">{#each finished as step (step.id)}{@render stepRow({ kind: "step", step, depth: 0, parent: "top" })}{/each}</ul>
      {/if}
    </section>
  {/if}
  <p class="sr-only" role="status">{moved}</p>
</div>

<Menu open={menu !== null} anchor={menu?.anchor} items={menu?.items ?? []} label="Step actions" onclose={() => (menu = null)} />
<Menu bind:open={filterMenuOpen} anchor={filterAnchor} items={filterItems} placement="bottom-end" label="Filter steps" />

<Dialog
  open={asking !== null}
  title="Ask {agentName} about {asking?.id ?? ''}"
  description={asking?.text}
  width={480}
  dirty={askText.trim().length > 0}
  onclose={() => { asking = null; }}
>
  <TextArea
    bind:value={askText}
    rows={3}
    aria-label="Your question"
    placeholder="Your question goes to {agentName}'s DM with this step named. Enter sends."
    data-autofocus
    onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void ask(); } }}
  />
  {#snippet actions()}
    <Button variant="primary" disabled={!askText.trim()} onclick={() => void ask()}>Send</Button>
  {/snippet}
</Dialog>

<style>
  .plan { position: relative; display: grid; gap: var(--space-6); container-type: inline-size; }
  .plan-tools { position: absolute; top: 0; right: 0; z-index: 1; display: flex; align-items: center; gap: var(--space-3); }
  .find { width: 11rem; margin-block: calc(-1 * var(--space-1)); }
  .tool.on { color: var(--text-standard); font-weight: 500; }
  .tally { color: var(--text-subtle); white-space: nowrap; }
  .row.context .text { color: var(--text-subtle); }
  .tool, .fold-done, .fold-group { border: 0; background: none; padding: 0; color: var(--text-subtle); cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-1); font: inherit; }
  .tool:hover, .fold-done:hover, .fold-group:hover { color: var(--text-standard); }
  .group { display: grid; }
  .heading { display: flex; align-items: baseline; gap: var(--space-2); margin: 0 0 var(--space-1); color: var(--text-standard); }
  .fold-group { color: var(--text-standard); }
  .count { opacity: 0.5; }
  .list { list-style: none; margin: 0; padding: 0; }
  .children { padding-inline-start: var(--space-5); }
  .row {
    display: grid; grid-template-columns: 1.5rem auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2);
    padding-block: var(--space-2); border-bottom: 1px solid var(--border-standard); border-radius: 0;
    transition: background var(--duration-medium) var(--ease-standard);
  }
  .row.flash { background: var(--affordance-sidebar-hover); }
  .list > li:last-child > .row { border-bottom: 0; }
  .finished { padding: var(--space-2) 0 var(--space-1) 2rem; }
  .disclosure { display: flex; align-items: center; width: 1.5rem; }
  .label { display: grid; gap: var(--space-half); min-width: 0; }
  .text { overflow-wrap: anywhere; color: var(--text-standard); }
  .struck { text-decoration: line-through; color: var(--text-subtle); }
  .note { border: 0; background: none; padding: 0; text-align: start; color: var(--text-subtle); font: inherit; cursor: pointer; white-space: pre-wrap; }
  .note:disabled { cursor: default; }
  .reqs { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; color: var(--text-subtle); }
  .req-status { font-weight: 500; }
  .req-status.met { color: var(--status-online); }
  .req-status.missing, .req-status.failing { color: var(--border-danger); }
  .details { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-1); min-width: 0; max-width: 18rem; }
  .progress, .wait { color: var(--text-subtle); white-space: nowrap; }
  .more { display: inline-flex; opacity: 0; }
  .row:hover .more, .row:focus-within .more, .row.menu-open .more { opacity: 1; }
  @media (hover: none) { .more { opacity: 1; } }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  .wait { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; }
  @container (max-width: 30rem) {
    .row { grid-template-columns: 1.5rem auto minmax(0, 1fr); }
    .details { grid-column: 3; justify-content: flex-start; max-width: none; }
  }
</style>
