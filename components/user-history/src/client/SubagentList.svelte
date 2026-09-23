<script lang="ts">
  import { api } from "./api.ts";
  import { duration } from "./format.ts";
  import { modelShort, money } from "./organize.ts";
  import type { ChildAgent, ChildUsage } from "../shared/types.ts";

  /**
   * A compact subagent list that stays fast with hundreds of children: one 28 px row each (status, name, model, cost, time), a filter box,
   * an All / Active / Inactive switch, and windowed rendering so only the rows in view exist in the DOM.
   */
  let { threadId, children, height = 320 }: { threadId: string; children: readonly ChildAgent[]; height?: number } = $props();

  const ROW = 28;
  const OVERSCAN = 6;
  type Scope = "all" | "active" | "inactive";
  let query = $state("");
  let scope = $state<Scope>("all");
  let scrollTop = $state(0);
  let usage = $state<ChildUsage[] | null>(null);
  let usageError = $state(false);

  const isActive = (child: ChildAgent) => child.status === "running" || child.status === "queued";
  $effect(() => {
    void children.length;
    let cancelled = false;
    api.childUsage(threadId).then(entries => { if (!cancelled) { usage = entries; usageError = false; } }, () => { if (!cancelled) usageError = true; });
    return () => { cancelled = true; };
  });
  const costOf = $derived.by(() => {
    const byId = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const entry of usage ?? []) {
      if (entry.cost === undefined) continue;
      if (entry.rlmChildId) byId.set(entry.rlmChildId, entry.cost);
      if (entry.sessionName) byName.set(entry.sessionName, entry.cost);
    }
    return (child: ChildAgent): number | undefined => byId.get(child.id) ?? (child.sessionName ? byName.get(child.sessionName) : undefined);
  });
  const nameOf = (child: ChildAgent) => child.sessionName ?? child.label.split("\n", 1)[0]!.slice(0, 80);
  const counts = $derived({ all: children.length, active: children.filter(isActive).length, inactive: children.filter(child => !isActive(child)).length });
  const rows = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return children
      .filter(child => scope === "all" || (scope === "active") === isActive(child))
      .filter(child => !needle || (nameOf(child) + " " + (child.model ?? "") + " " + child.label).toLowerCase().includes(needle))
      .sort((left, right) => Number(isActive(right)) - Number(isActive(left)));
  });
  const total = $derived(rows.reduce((sum, child) => sum + (costOf(child) ?? 0), 0));
  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const end = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
  $effect(() => { void query; void scope; scrollTop = 0; });
</script>

<div class="subagents">
  <div class="tools">
    <input class="field" data-autofocus bind:value={query} placeholder="Filter by name or model" aria-label="Filter subagents" />
    <div class="segmented" role="radiogroup" aria-label="Show">
      {#each [["all", "All"], ["active", "Active"], ["inactive", "Done"]] as [value, label] (value)}
        <button type="button" role="radio" aria-checked={scope === value} class:on={scope === value} onclick={() => { scope = value as Scope; }}>{label} <span class="n">{counts[value as Scope]}</span></button>
      {/each}
    </div>
  </div>
  <div class="scroll" style:height="{Math.min(height, Math.max(rows.length, 1) * ROW)}px" onscroll={event => { scrollTop = (event.currentTarget as HTMLElement).scrollTop; }}
    role="list" aria-label="Subagents">
    <div class="spacer" style:height="{rows.length * ROW}px">
      {#each rows.slice(start, end) as child, offset (child.id)}
        {@const cost = costOf(child)}
        <div class="row" role="listitem" style:top="{(start + offset) * ROW}px">
          <span class="state">
            {#if child.status === "running"}<span class="spinner tiny" role="img" aria-label="Running"></span>
            {:else}<span class="mark {child.status}" role="img" aria-label={child.status}></span>{/if}
          </span>
          <span class="name" class:inactive={!isActive(child)}>{nameOf(child)}</span>
          <span class="model">{modelShort(child.model)}</span>
          <span class="cost" class:unknown={cost === undefined}>{money(cost)}</span>
          <span class="time">{child.durationMs !== undefined ? duration(child.durationMs) : ""}</span>
        </div>
      {/each}
    </div>
    {#if !rows.length}<div class="empty">No subagents match.</div>{/if}
  </div>
  <div class="foot">
    <span>{rows.length} shown</span>
    <span class="sum">{usageError ? "Cost not available" : usage === null ? "" : "Total " + money(total)}</span>
  </div>
</div>

<style>
  .subagents { display: flex; flex-direction: column; min-width: 0; }
  .tools { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px; }
  .tools .segmented { display: flex; }
  .tools .segmented > button { flex: 1; }
  .n { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .scroll { position: relative; overflow-y: auto; overscroll-behavior: contain; min-height: 28px; }
  .spacer { position: relative; }
  .row { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12.5px; }
  .row:hover { background: var(--bg-hover); }
  .state { display: inline-flex; width: 12px; justify-content: center; flex: none; }
  .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .mark.queued { background: transparent; border: 1.5px solid var(--accent); }
  .mark.error { background: var(--danger); }
  .mark.cancelled { background: var(--text-faint); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .name.inactive { font-weight: 400; color: var(--text-muted); }
  .model { flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-size: 11.5px; }
  .cost, .time { flex: none; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11.5px; }
  .cost { width: 48px; }
  .cost.unknown { color: var(--text-faint); }
  .time { width: 48px; color: var(--text-faint); }
  .empty { padding: 6px 8px; font-size: 12.5px; color: var(--text-faint); }
  .foot { display: flex; justify-content: space-between; padding: 6px 8px 2px; border-top: 1px solid var(--border); margin-top: 4px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
</style>
