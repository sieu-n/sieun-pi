<script lang="ts">
  import { activeAgents } from "./active-agents.ts";
  import { store } from "./store.svelte.ts";

  /** One footer row: how many Prime Agent sessions run a turn right now, threads and subagents at any depth, from the sessions stream. */
  const active = $derived(activeAgents(store.sessions));
  const known = $derived(store.daemon === "up");
  const title = $derived(known
    ? `${active.total} Prime Agent sessions running a turn right now\n${active.threads} chats, threads and jobs\n${active.subagents} subagents at any depth`
    : "The Prime Agent daemon is not connected");
</script>

<div class="line" title={title} aria-label="{known ? active.total : 'Unknown'} agents running">
  <span class="name">Agents</span>
  <span class="split">{known ? `${active.threads} threads, ${active.subagents} sub` : ""}</span>
  <span class="figure" class:idle={known && active.total === 0}>{known ? active.total : "–"}<span class="unit">active</span></span>
</div>

<style>
  .line { display: flex; align-items: center; gap: 10px; padding: 4px 6px; font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums; }
  .name { width: 48px; flex: none; font-weight: 600; color: var(--text-muted); }
  .split { flex: 1; min-width: 0; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .figure { flex: none; min-width: 58px; text-align: right; font-weight: 600; color: var(--text); }
  .idle { color: var(--text-faint); }
  .unit { margin-left: 3px; font-weight: 500; color: var(--text-faint); }
</style>
