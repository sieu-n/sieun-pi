<script lang="ts">
  import { clock } from "./clock.svelte.ts";
  import { duration } from "./format.ts";
  import { statusLine } from "./agent-queue.ts";
  import type { AgentQueuePool, AgentQueueRow } from "../shared/types.ts";

  /** One box's turn queue: the status line, and the working and waiting agents while the queue is on. */
  let { pool }: { pool: AgentQueuePool } = $props();
  const read = $derived(pool.state === "read" ? pool : null);
  const working = $derived(read?.rows.filter(row => row.state === "working") ?? []);
  const waiting = $derived(read?.rows.filter(row => row.state === "waiting") ?? []);
</script>

{#snippet group(title: string, rows: AgentQueueRow[])}
  <div class="group-head">{title} <span class="count">{rows.length}</span></div>
  {#each rows as row (row.session)}
    <div class="qrow" class:owner={row.owner}>
      <span class="chat" title={row.chat}>{row.chat}</span>
      <span class="job" class:none={!row.job} title={row.job ?? ""}>{row.job ?? "chat"}</span>
      <span class="who">{row.owner ? "owner" : "background"}</span>
      <span class="time">{duration(Math.max(0, clock.now - row.since))}</span>
    </div>
  {:else}
    <div class="qrow empty">None</div>
  {/each}
{/snippet}

<p class="live" class:problem={pool.state === "unread"} aria-live="polite">{statusLine(pool)}</p>
{#if pool.state === "unread"}<p class="note">{pool.error}</p>{/if}
{#if read?.enabled}
  <div class="list" aria-label="Working and waiting agents">
    {@render group("Working", working)}
    {@render group("Waiting", waiting)}
  </div>
{/if}

<style>
  .live { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; font-variant-numeric: tabular-nums; }
  .live.problem { color: var(--danger); }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .list { max-height: 248px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-small); font-size: 12px; }
  .group-head { position: sticky; top: 0; padding: 4px 10px; background: var(--bg-elevated); border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 600; }
  .count { font-weight: 400; font-variant-numeric: tabular-nums; }
  .qrow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 76px 56px; gap: 10px; align-items: center; padding: 3px 10px; line-height: 18px; }
  .qrow + .qrow { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .qrow.empty { display: block; color: var(--text-faint); }
  .chat, .job { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat { font-weight: 500; }
  .job.none { color: var(--text-faint); }
  .who { color: var(--text-faint); }
  .qrow.owner .who { color: var(--accent); font-weight: 500; }
  .time { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); }
</style>
