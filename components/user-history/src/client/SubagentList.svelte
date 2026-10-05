<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { duration } from "./format.ts";
  import { modelShort, money } from "./organize.ts";
  import { clock } from "./clock.svelte.ts";
  import { readPulse } from "../shared/pulse.ts";
  import type { ChildAgent, ChildPulse, ChildStatus, ChildUsage } from "../shared/types.ts";
  import { childDetail, childName, isActiveChild } from "./children.ts";
  import StatusMark from "./StatusMark.svelte";

  /**
   * Subagents grouped Running, Failed, Done, Cancelled. Each row says what the child is doing now (its native activity and latest recap) or how it
   * ended (answer preview or error line), with model, cost and run time. A row whose session the daemon lists opens that child's transcript.
   * Rows render in a window, so hundreds of children stay fast.
   */
  let { threadId, children, pulses = [], height = 360 }: { threadId: string; children: readonly ChildAgent[]; pulses?: readonly ChildPulse[]; height?: number } = $props();
  const now = $derived(Math.floor(clock.now / 5000) * 5000);
  const pulseById = $derived(new Map(pulses.map(pulse => [pulse.rlmChildId, pulse])));
  const readingOf = (child: ChildAgent) => { const pulse = child.status === "running" ? pulseById.get(child.id) : undefined; return pulse ? readPulse(pulse, now) : null; };

  const ROW = 44;
  const HEADER = 26;
  const OVERSCAN = 4;
  type Scope = "all" | "active" | "inactive";
  type Group = "running" | "error" | "done" | "cancelled";
  const GROUPS: readonly Group[] = ["running", "error", "done", "cancelled"];
  const GROUP_LABEL: Record<Group, string> = { running: "Running", error: "Failed", done: "Done", cancelled: "Cancelled" };
  const groupOf = (status: ChildStatus): Group => status === "queued" ? "running" : status;
  let query = $state("");
  let scope = $state<Scope>("all");
  let scrollTop = $state(0);
  let usage = $state<ChildUsage[] | null>(null);
  let usageError = $state(false);

  $effect(() => {
    void children.length;
    let cancelled = false;
    api.childUsage(threadId).then(entries => { if (!cancelled) { usage = entries; usageError = false; } }, () => { if (!cancelled) usageError = true; });
    return () => { cancelled = true; };
  });
  const usageOf = $derived.by(() => {
    const byId = new Map<string, ChildUsage>();
    const byName = new Map<string, ChildUsage>();
    for (const entry of usage ?? []) {
      if (entry.rlmChildId) byId.set(entry.rlmChildId, entry);
      if (entry.sessionName) byName.set(entry.sessionName, entry);
    }
    return (child: ChildAgent): ChildUsage | undefined => byId.get(child.id) ?? (child.sessionName ? byName.get(child.sessionName) : undefined);
  });
  const nameOf = childName;
  const isActive = isActiveChild;
  const detailOf = (child: ChildAgent) => childDetail(child, readingOf(child));

  const counts = $derived({ all: children.length, active: children.filter(isActive).length, inactive: children.filter(child => !isActive(child)).length });
  const matched = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return children
      .filter(child => scope === "all" || (scope === "active") === isActive(child))
      .filter(child => !needle || (nameOf(child) + " " + (child.model ?? "") + " " + child.label + " " + (child.recap ?? "")).toLowerCase().includes(needle));
  });
  type Item = { kind: "header"; group: Group; count: number; top: number } | { kind: "child"; child: ChildAgent; top: number };
  const layout = $derived.by(() => {
    const items: Item[] = [];
    let top = 0;
    for (const group of GROUPS) {
      const members = matched.filter(child => groupOf(child.status) === group);
      if (!members.length) continue;
      items.push({ kind: "header", group, count: members.length, top });
      top += HEADER;
      for (const child of members) { items.push({ kind: "child", child, top }); top += ROW; }
    }
    return { items, total: top };
  });
  const visible = $derived(layout.items.filter(item => item.top + ROW >= scrollTop - OVERSCAN * ROW && item.top <= scrollTop + height + OVERSCAN * ROW));
  const total = $derived(matched.reduce((sum, child) => sum + (usageOf(child)?.cost ?? 0), 0));
  $effect(() => { void query; void scope; scrollTop = 0; });
</script>

<div class="subagents">
  <div class="tools">
    <input class="field" data-autofocus bind:value={query} placeholder="Filter by name, model or note" aria-label="Filter subagents" />
    <div class="segmented" role="radiogroup" aria-label="Show">
      {#each [["all", "All"], ["active", "Running"], ["inactive", "Finished"]] as [value, label] (value)}
        <button type="button" role="radio" aria-checked={scope === value} class:on={scope === value} onclick={() => { scope = value as Scope; }}>{label} <span class="n">{counts[value as Scope]}</span></button>
      {/each}
    </div>
  </div>
  <div class="scroll" style:height="{Math.min(height, Math.max(layout.total, ROW))}px" onscroll={event => { scrollTop = (event.currentTarget as HTMLElement).scrollTop; }}
    role="list" aria-label="Subagents">
    <div class="spacer" style:height="{layout.total}px">
      {#each visible as item (item.kind === "header" ? "group:" + item.group : item.child.id)}
        {#if item.kind === "header"}
          <div class="group" style:top="{item.top}px">{GROUP_LABEL[item.group]} <span class="n">{item.count}</span></div>
        {:else}
          {@const child = item.child}
          {@const entry = usageOf(child)}
          {@const detail = detailOf(child)}
          <div class="item" role="listitem" style:top="{item.top}px">
            <button type="button" class="row {child.status}" disabled={!entry} title={[nameOf(child), detail.lead, detail.text].filter(Boolean).join("\n")}
              aria-label="{nameOf(child)}, {detail.lead || child.status}{entry ? ', open transcript' : ''}" onclick={() => { if (entry) store.select(entry.sessionId); }}>
              <span class="line">
                <span class="state">
                  {#if child.status === "running"}<StatusMark status="working" level={readingOf(child)?.level ?? "live"} />{:else}<span class="mark {child.status}" aria-hidden="true"></span>{/if}
                </span>
                <span class="name">{nameOf(child)}</span>
                <span class="model">{modelShort(child.model)}</span>
                <span class="cost" class:unknown={entry?.cost === undefined}>{money(entry?.cost)}</span>
                <span class="time">{child.durationMs !== undefined ? duration(child.durationMs) : ""}</span>
              </span>
              <span class="line detail {detail.tone}">
                {#if detail.lead}<span class="lead">{detail.lead}</span>{/if}
                {#if detail.text}<span class="text">{detail.text}</span>{/if}
              </span>
            </button>
          </div>
        {/if}
      {/each}
    </div>
    {#if !matched.length}<div class="empty">No subagents match.</div>{/if}
  </div>
  <div class="foot">
    <span>{matched.length} shown</span>
    <span class="sum">{usageError ? "Cost not available" : usage === null ? "" : "Total " + money(total)}</span>
  </div>
</div>

<style>
  .subagents { display: flex; flex-direction: column; min-width: 0; }
  .tools { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px; }
  .tools .segmented { display: flex; }
  .tools .segmented > button { flex: 1; }
  .n { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; font-weight: 500; }
  .scroll { position: relative; overflow-y: auto; overscroll-behavior: contain; min-height: 44px; }
  .spacer { position: relative; }
  .group, .item { position: absolute; left: 0; right: 0; }
  .group { height: 26px; padding: 8px 8px 0; font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .item { height: 44px; }
  .row { display: flex; flex-direction: column; justify-content: center; gap: 1px; width: 100%; height: 42px; padding: 0 8px; border-radius: var(--radius-small); text-align: left; font-size: 12.5px; }
  .row:disabled { opacity: 1; cursor: default; }
  .row:hover:not(:disabled) { background: var(--bg-hover); }
  .line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .state { display: inline-flex; width: 12px; justify-content: center; flex: none; }
  .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .mark.queued { background: transparent; border: 1.5px solid var(--accent); }
  .mark.error { background: var(--danger); }
  .mark.cancelled { background: var(--text-faint); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .model { flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-size: 11.5px; }
  .cost, .time { flex: none; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11.5px; }
  .cost { width: 48px; }
  .cost.unknown { color: var(--text-faint); }
  .time { width: 48px; color: var(--text-faint); }
  .detail { padding-left: 20px; gap: 6px; font-size: 11.5px; line-height: 16px; color: var(--text-faint); }
  .lead { flex: none; color: var(--text-muted); font-weight: 500; }
  .running .lead, .queued .lead { color: var(--accent-bold); }
  .error .lead, .error .text, .detail.failed .lead, .detail.failed .text { color: var(--danger); }
  .detail.stalled .lead { color: var(--warning); }
  .detail.quiet .lead { color: var(--text-muted); }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 6px 8px; font-size: 12.5px; color: var(--text-faint); }
  .foot { display: flex; justify-content: space-between; padding: 6px 8px 2px; border-top: 1px solid var(--border); margin-top: 4px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
</style>
