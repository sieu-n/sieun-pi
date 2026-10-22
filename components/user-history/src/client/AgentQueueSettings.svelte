<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import Checkbox from "./ui/Checkbox.svelte";
  import QueueHistory from "./QueueHistory.svelte";
  import QueueRows from "./QueueRows.svelte";
  import type { AgentQueueInput, AgentQueuePool, AgentQueueView, HostQueueInput } from "../shared/types.ts";
  import { setLine } from "./agent-queue.ts";
  import { POOL_DEFAULTS } from "./pool-config.ts";

  /** `remote` is another box's card on Settings > Hosts: its pool comes from the Hosts poll, and a change goes to that box through api/hosts/queue. */
  let { remote }: { remote?: { name: string; pool: AgentQueuePool } } = $props();
  const uid = $props.id();

  const POLL_MS = 5000;
  type Field = "mac" | "tree" | "idle";

  let view = $state<AgentQueueView | null>(null);
  /** The pool a remote write answered with, shown while `from` is still the prop's pool, so the next Hosts poll replaces it. */
  let written = $state.raw<{ from: AgentQueuePool; pool: AgentQueuePool } | null>(null);
  let error = $state<string | null>(null);
  let saving = $state<AgentQueueInput["action"] | null>(null);
  let drafts = $state<Record<Field, number | null>>({ mac: null, tree: null, idle: null });
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load(): Promise<void> {
    try { view = await api.agentQueue(); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  onMount(() => { if (remote) return; void load(); timer = setInterval(() => { void load(); }, POLL_MS); });
  onDestroy(() => clearInterval(timer));

  async function write(input: AgentQueueInput): Promise<void> {
    if (!remote) { view = await api.setAgentQueue(input); return; }
    if (input.action === "idle") throw new Error("The idle unload time is set on the box itself.");
    const from = remote.pool;
    const host: HostQueueInput = { host: remote.name, ...input };
    written = { from, pool: await api.setHostQueue(host) };
  }

  async function apply(input: AgentQueueInput): Promise<void> {
    saving = input.action;
    try {
      await write(input);
      error = null;
      if (input.action !== "queue") drafts[input.action] = null;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { saving = null; }
  }

  const current = $derived<AgentQueuePool | null>(remote ? (written?.from === remote.pool ? written.pool : remote.pool) : view?.pool ?? null);
  const pool = $derived(current?.state === "read" ? current : null);
  const idleSaved = $derived(typeof view?.idleEvictionMinutes === "number" ? view.idleEvictionMinutes : null);
  const saved = $derived<Record<Field, number | null>>({ mac: pool?.workingMax ?? null, tree: pool?.treeWorkingMax ?? null, idle: idleSaved });
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

{#snippet limit(field: Field, label: string, unit: string, max: number, enabled: boolean)}
  <form class="limit" onsubmit={event => submit(event, field)}>
    <label class="label" for="{uid}-queue-{field}">{label}</label>
    <div class="field-row">
      <input id="{uid}-queue-{field}" class="field" type="number" inputmode="numeric" min="1" {max} step="1" disabled={!enabled || saving !== null}
        placeholder={field === "idle" && view?.idleEvictionMinutes === "off" ? "Off" : ""}
        value={shown(field)} oninput={event => { drafts[field] = Number.isNaN(event.currentTarget.valueAsNumber) ? null : event.currentTarget.valueAsNumber; }} />
      <span class="unit">{unit}</span>
      <button type="submit" class="button small" disabled={!enabled || saving !== null || !changed(field)}>
        {#if saving === field}<Spinner />{:else}Set{/if}
      </button>
    </div>
  </form>
{/snippet}

<section class="queue" aria-label={remote ? `Agent queue on ${remote.name}` : "Agent queue"}>
  <h3>Agent queue</h3>
  {#if !current}
    <p class="note">{error ? `The agent queue is unavailable. ${error}` : "Reading the agent queue"}</p>
  {:else}
    <QueueRows pool={current} />

    {#if view}<QueueHistory hours={view.history} />{/if}

    <button type="button" class="toggle" role="switch" aria-checked={pool?.enabled ?? false} aria-busy={saving === "queue"} disabled={!pool || saving !== null}
      onclick={() => { if (pool) void apply({ action: "queue", on: !pool.enabled }); }}>
      {#if saving === "queue"}<Spinner />{:else}<Checkbox visual checked={pool?.enabled ?? false} />{/if}
      <span class="label">Queue agent turns</span>
      <span class="note">Jobs and subagents wait for a free slot. Your own messages never wait.</span>
    </button>

    <div class="limits">
      {@render limit("mac", "Agents working on this box", "", 999, pool !== null)}
      {@render limit("tree", "Agents working per chat", "", 999, pool !== null)}
      {#if !remote}{@render limit("idle", "Unload idle sessions after", "min", 1440, true)}{/if}
    </div>
    {#if pool}<p class="note">{setLine(pool.workingMax, pool.workingMaxSet, POOL_DEFAULTS.working_max)}</p>{/if}
    {#if error}<p class="note problem">The last change failed. {error}</p>{/if}
  {/if}
</section>

<style>
  .queue { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border); }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .note.problem { color: var(--danger); }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .toggle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; padding: 8px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .toggle:hover:not(:disabled) { background: var(--bg-hover); }
  .toggle:disabled { cursor: default; opacity: 0.75; }
  .label { font-weight: 500; }
  .limits { display: flex; flex-direction: column; gap: 6px; }
  .limit { display: grid; grid-template-columns: 250px auto; align-items: center; gap: 16px; }
  .field-row { display: flex; align-items: center; gap: 8px; }
  .field-row .field { width: 80px; font-variant-numeric: tabular-nums; }
  .unit { width: 24px; color: var(--text-muted); }
  .field:disabled { opacity: 0.6; }
</style>
