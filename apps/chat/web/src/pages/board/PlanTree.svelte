<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ChatAgent, PlanItem } from "$lib/api";
  import { Badge, Chip, IconButton, IdChip, Icon } from "$lib/ui";
  import PlanMark from "./PlanMark.svelte";
  import { router } from "$lib/router.svelte";
  import { boardHref } from "./chips";
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
  }: {
    chatId: string;
    plan: PlanItem[];
    awaitingGo: ReadonlySet<string>;
    agents?: ChatAgent[];
    where: "panel" | "page";
    focus?: string | null;
    onboardid?: (id: string) => void;
  } = $props();

  const steps = $derived(plan as Step[]);
  let openIds = $state(new Set<string>());
  let shownDone = $state(new Set<string>());
  let notesOpen = $state(new Set<string>());
  let flash = $state<string | null>(null);
  let root = $state<HTMLElement>();

  const view = $derived({ open: (id: string) => openIds.has(id), showDone: (parent: string) => shownDone.has(parent) });
  const groups = $derived(planGroups(steps));
  const finished = $derived(finishedSteps(steps));
  const allIds = $derived(parentIds(steps));
  const anyOpen = $derived(allIds.some(id => openIds.has(id)));

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  function rowsOf(list: Step[], key: string): Row[] {
    return treeRows(list, view, key);
  }

  $effect(() => {
    const id = focus;
    if (!id) return;
    const path = pathTo(steps, id);
    if (!path) return;
    untrack(() => {
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
</script>

{#snippet stepRow(row: Row)}
  {#if row.kind === "finished"}
    <li class="finished" style:--depth={row.depth}>
      <button type="button" class="fold-done t-caption" aria-pressed={row.shown} onclick={() => { shownDone = toggle(shownDone, row.parent); }}>
        <Icon name={row.shown ? "chevron-down" : "chevron-right"} size={14} />{row.shown ? "Hide done" : `Show done (${row.count})`}
      </button>
    </li>
  {:else}
    {@const step = row.step}
    {@const progress = stepProgress(step)}
    {@const wait = waitWords(step)}
    {@const agent = agentOf(step)}
    {@const owner = agent?.name ?? ownerName(step)}
    {@const open = openIds.has(step.id)}
    <li class="row-item" style:--depth={row.depth}>
      <div class="row {step.status}" class:flash={flash === step.id} data-step={step.id}>
        <span class="disclosure">
          {#if step.children.length}
            <IconButton size="xs" icon={open ? "chevron-down" : "chevron-right"} label="{open ? 'Collapse' : 'Expand'} {step.id}" onclick={() => { openIds = toggle(openIds, step.id); }} />
          {/if}
        </span>
        <PlanMark status={step.status} />
        <div class="label">
          <span class="text t-body-sm" class:struck={isFinished(step)}>{step.text}</span>
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
        </div>
      </div>
      {#if step.children.length && open}
        <ul class="list children">{#each rowsOf(step.children, step.id) as child (child.kind === "step" ? child.step.id : `${child.parent}/done`)}{@render stepRow(child)}{/each}</ul>
      {/if}
    </li>
  {/if}
{/snippet}

<div class="plan" bind:this={root}>
  {#if allIds.length}
    <div class="plan-tools">
      <button type="button" class="tool t-caption" onclick={() => { openIds = anyOpen ? new Set() : new Set(allIds); }}>{anyOpen ? "Collapse all" : "Expand all"}</button>
    </div>
  {/if}
  {#each groups as group (group.status)}
    <section class="group" aria-label={STATUS_LABEL[group.status]}>
      <h3 class="heading t-label-sm">{STATUS_LABEL[group.status]} <span class="count">{group.steps.length}</span></h3>
      <ul class="list">
        {#each group.steps as step (step.id)}
          {@render stepRow({ kind: "step", step, depth: 0, parent: "top" })}
        {/each}
      </ul>
    </section>
  {/each}
  {#if finished.length}
    <section class="group" aria-label="Done">
      <button type="button" class="heading t-label-sm fold-group" aria-expanded={shownDone.has("top")} onclick={() => { shownDone = toggle(shownDone, "top"); }}>
        <Icon name={shownDone.has("top") ? "chevron-down" : "chevron-right"} size={14} />Done <span class="count">{finished.length}</span>
      </button>
      {#if shownDone.has("top")}
        <ul class="list">{#each finished as step (step.id)}{@render stepRow({ kind: "step", step, depth: 0, parent: "top" })}{/each}</ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .plan { display: grid; gap: var(--space-6); container-type: inline-size; }
  .plan-tools { display: flex; justify-content: flex-end; height: 0; overflow: visible; position: relative; z-index: 1; }
  .plan-tools .tool { position: absolute; right: 0; top: 0; }
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
  .wait { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; }
  @container (max-width: 30rem) {
    .row { grid-template-columns: 1.5rem auto minmax(0, 1fr); }
    .details { grid-column: 3; justify-content: flex-start; max-width: none; }
  }
</style>
