<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import Checkbox from "./ui/Checkbox.svelte";
  import type { AgentQueueInput, AgentQueueView } from "../shared/types.ts";
  import { queueLine } from "./agent-queue.ts";

  const POLL_MS = 5000;
  type Field = "mac" | "tree" | "idle";

  let view = $state<AgentQueueView | null>(null);
  let error = $state<string | null>(null);
  let saving = $state<AgentQueueInput["action"] | null>(null);
  let drafts = $state<Record<Field, number | null>>({ mac: null, tree: null, idle: null });
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load(): Promise<void> {
    try { view = await api.agentQueue(); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  onMount(() => { void load(); timer = setInterval(() => { void load(); }, POLL_MS); });
  onDestroy(() => clearInterval(timer));

  async function apply(input: AgentQueueInput): Promise<void> {
    saving = input.action;
    try {
      view = await api.setAgentQueue(input);
      error = null;
      if (input.action !== "queue") drafts[input.action] = null;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { saving = null; }
  }

  const pool = $derived(view?.pool.state === "read" ? view.pool : null);
  const idleSaved = $derived(typeof view?.idleEvictionMinutes === "number" ? view.idleEvictionMinutes : null);
  const saved = $derived<Record<Field, number | null>>({ mac: pool?.macWorkingMax ?? null, tree: pool?.treeWorkingMax ?? null, idle: idleSaved });
  const shown = (field: Field) => drafts[field] ?? saved[field];
  const changed = (field: Field) => {
    const value = drafts[field];
    return value !== null && Number.isInteger(value) && value >= 1 && value !== saved[field];
  };

  function submit(event: SubmitEvent, field: Field): void {
    event.preventDefault();
    const value = drafts[field];
    if (changed(field) && value !== null) void apply({ action: field, value });
  }
</script>

{#snippet limit(field: Field, label: string, unit: string, max: number, enabled: boolean, notes: string[])}
  <form class="limit" onsubmit={event => submit(event, field)}>
    <label class="label" for="queue-{field}">{label}</label>
    <div class="field-row">
      <input id="queue-{field}" class="field" type="number" inputmode="numeric" min="1" {max} step="1" disabled={!enabled || saving !== null}
        placeholder={field === "idle" && view?.idleEvictionMinutes === "off" ? "Off" : ""}
        value={shown(field)} oninput={event => { drafts[field] = Number.isNaN(event.currentTarget.valueAsNumber) ? null : event.currentTarget.valueAsNumber; }} />
      {#if unit}<span class="unit">{unit}</span>{/if}
      <button type="submit" class="button small" disabled={!enabled || saving !== null || !changed(field)}>
        {#if saving === field}<span class="spinner tiny"></span>{:else}Set{/if}
      </button>
    </div>
    {#each notes as note (note)}<p class="note">{note}</p>{/each}
  </form>
{/snippet}

<section class="queue" aria-label="Agent queue">
  <h3>Agent queue</h3>
  {#if !view}
    <p class="note">{error ? `The agent queue is unavailable. ${error}` : "Reading the agent queue"}</p>
  {:else}
    <p class="live" class:problem={view.pool.state === "unread"} aria-live="polite">{queueLine(view.pool)}</p>
    {#if view.pool.state === "unread"}<p class="note">{view.pool.error}</p>{/if}

    <button type="button" class="toggle" role="switch" aria-checked={pool?.enabled ?? false} aria-busy={saving === "queue"} disabled={!pool || saving !== null}
      onclick={() => { if (pool) void apply({ action: "queue", on: !pool.enabled }); }}>
      {#if saving === "queue"}<span class="spinner tiny"></span>{:else}<Checkbox visual checked={pool?.enabled ?? false} />{/if}
      <span class="text">
        <span class="label">Queue agent turns</span>
        <span class="note">A job or subagent turn waits for a working slot while the limits below are full. Your own messages never wait. Off lets every turn start at once and keeps both numbers.</span>
      </span>
    </button>

    {@render limit("mac", "Working sessions on this Mac", "", 999, pool !== null,
      ["A p90 working session uses 426 MB; 16 fit in the 6.9 GB free (measured 10-14 07:38 KST)."])}
    {@render limit("tree", "Working sessions per chat", "", 999, pool !== null,
      ["Half of 16, so two chats at full fan-out fit, above the 7 working sessions VP of CI held at once on 10-14."])}
    {@render limit("idle", "Unload idle sessions after", "min", 1440, true, [
      "90 min is the daemon's own default, kept until reload gaps are measured; 10 timed reloads on 10-13 took 1.1 to 6.2 s. The daemon rereads it within 5 minutes, with no restart.",
      "Pinned chats stay loaded until the harness VP's detach fix lands, so for now this unloads idle jobs and threads only.",
    ])}
    {#if error}<p class="note problem">The last change failed. {error}</p>{/if}
  {/if}
</section>

<style>
  .queue { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border); }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .live { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; font-variant-numeric: tabular-nums; }
  .live.problem, .note.problem { color: var(--danger); }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .toggle { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .toggle:hover:not(:disabled) { background: var(--bg-hover); }
  .toggle:disabled { cursor: default; opacity: 0.75; }
  .toggle :global(.box), .toggle .spinner { margin-top: 2px; }
  .text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .label { font-weight: 500; }
  .limit { display: grid; grid-template-columns: 220px auto; align-items: center; gap: 4px 16px; }
  .limit .note { grid-column: 1 / -1; }
  .field-row { display: flex; align-items: center; gap: 8px; }
  .field-row .field { width: 88px; font-variant-numeric: tabular-nums; }
  .unit { color: var(--text-muted); }
  .field:disabled { opacity: 0.6; }
</style>
