<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import Checkbox from "./ui/Checkbox.svelte";
  import type { AgentQueueInput, AgentQueueView } from "../shared/types.ts";
  import { queueLine } from "./agent-queue.ts";

  const POLL_MS = 5000;

  let view = $state<AgentQueueView | null>(null);
  let error = $state<string | null>(null);
  let saving = $state<AgentQueueInput["action"] | null>(null);
  let macDraft = $state<number | null>(null);
  let treeDraft = $state<number | null>(null);
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
      if (input.action === "mac") macDraft = null;
      if (input.action === "tree") treeDraft = null;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { saving = null; }
  }

  const read = $derived(view?.state === "read" ? view : null);
  const enabled = $derived(read?.enabled ?? false);
  const macValue = $derived(macDraft ?? view?.restoreMax ?? null);
  const treeValue = $derived(treeDraft ?? read?.treeWorkingMax ?? null);
  const whole = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= 1 && value <= 999;
  const line = $derived(view ? queueLine(view) : null);

  function submit(event: SubmitEvent, action: "mac" | "tree"): void {
    event.preventDefault();
    const value = action === "mac" ? macValue : treeValue;
    if (whole(value)) void apply({ action, value });
  }
</script>

<section class="queue" aria-label="Agent queue">
  <h3>Agent queue</h3>
  {#if !view}
    <p class="note">{error ? `The agent queue is unavailable. ${error}` : "Reading the agent queue"}</p>
  {:else}
    <p class="live" class:problem={view.state === "unread"} aria-live="polite">{line}</p>
    {#if view.state === "unread"}<p class="note">{view.error}</p>{/if}

    <button type="button" class="toggle" role="switch" aria-checked={enabled} aria-busy={saving === "off" || saving === "on"} disabled={!read || saving !== null}
      onclick={() => void apply({ action: enabled ? "off" : "on" })}>
      {#if saving === "off" || saving === "on"}<span class="spinner tiny"></span>{:else}<Checkbox visual checked={enabled} />{/if}
      <span class="text">
        <span class="label">Queue agent turns</span>
        <span class="note">On, a job or subagent turn waits for a working slot when the limits below are full; your own messages never wait. Off writes mac_working_max "off", and on writes {view.restoreMax} back.</span>
      </span>
    </button>

    <form class="limit" onsubmit={event => submit(event, "mac")}>
      <label class="label" for="mac-working-max">Working sessions on this Mac</label>
      <div class="field-row">
        <input id="mac-working-max" class="field" type="number" inputmode="numeric" min="1" max="999" step="1" disabled={!enabled || saving !== null}
          value={macValue} oninput={event => { macDraft = event.currentTarget.valueAsNumber; }} />
        <button type="submit" class="button small" disabled={!enabled || saving !== null || macDraft === null || !whole(macValue) || macValue === view.restoreMax}>Set</button>
      </div>
      <p class="note">A p90 working session uses 426 MB; 16 fit in the 6.9 GB free (measured 10-14 07:38 KST).</p>
    </form>

    <form class="limit" onsubmit={event => submit(event, "tree")}>
      <label class="label" for="tree-working-max">Working sessions per chat</label>
      <div class="field-row">
        <input id="tree-working-max" class="field" type="number" inputmode="numeric" min="1" max="999" step="1" disabled={!read || saving !== null}
          value={treeValue} oninput={event => { treeDraft = event.currentTarget.valueAsNumber; }} />
        <button type="submit" class="button small" disabled={!read || saving !== null || treeDraft === null || !whole(treeValue) || treeValue === read?.treeWorkingMax}>Set</button>
      </div>
      <p class="note">Half of 16, so two chats at full fan-out fit, above the 7 working sessions VP of CI held at once on 10-14.</p>
    </form>
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
  .field:disabled { opacity: 0.6; }
</style>
