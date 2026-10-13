<script lang="ts">
  import type { ChatAgent, PlanItem } from "../shared/types.ts";
  import { queueText, stepAgent, stepAgentTitle } from "./board.ts";
  import { clock } from "./clock.svelte.ts";
  import { store } from "./store.svelte.ts";
  import Icon from "./Icon.svelte";

  /**
   * A plan step's agent after its text, in the Plan card and the plan view: the Agents card's status dot (a spinner while it works), the job
   * or thread icon and the agent's name (`stepAgent`). A click opens it in place: an Agents row through `onagent` (the job drawer or the
   * thread), a stored session as its thread, an owner with no row through `onjob`. `onopen` runs first (the plan view closes itself). An agent
   * whose turn waits in the Mac-wide turn queue shows the waiting dot and "Queued 3 of 7, waiting 4 min" (`queueText`).
   */
  let { chat, item, agents, onagent, onjob, previewJob, onopen = () => {} }: {
    chat: string; item: PlanItem; agents: readonly ChatAgent[]; onagent: (agent: ChatAgent) => void; onjob: (owner: string) => void;
    previewJob: (owner: string) => string | undefined; onopen?: () => void;
  } = $props();

  const chip = $derived(stepAgent(item, agents));
  const name = $derived(chip ? chip.agent ? chip.name : store.session(chip.sessionId ?? chip.job ?? null)?.name ?? chip.name : "");
  const preview = $derived(chip?.agent ? chip.agent.job : chip?.job ? previewJob(chip.job) : undefined);
  const queued = $derived(chip?.agent?.queued ? queueText(chip.agent.queued, clock.now) : "");
  const icon = $derived(chip?.agent?.link === "subagent" || (chip?.job && !chip.sessionId) ? "briefcase" : "message");
  function open(): void {
    if (!chip) return;
    onopen();
    if (chip.agent) onagent(chip.agent);
    else if (chip.sessionId) store.openArtifact({ kind: "thread", sessionId: chip.sessionId }, chat);
    else if (chip.job) onjob(chip.job);
  }
</script>

{#if chip}
  <button type="button" class="link-chip agent-chip" title={stepAgentTitle(chip, name)} data-preview-chat={chat} data-preview-job={preview} onclick={open}>
    {#if queued}<span class="dot waiting"></span>{:else if chip.state === "working"}<span class="spinner tiny"></span>{:else}<span class="dot {chip.state ?? ""}"></span>{/if}<Icon name={icon} size={11} /><span class="chip-label">{name}</span>{#if queued}<span class="queued">{queued}</span>{/if}</button>
{/if}

<style>
  .agent-chip { vertical-align: top; margin-left: 4px; gap: 4px; }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .dot.idle { background: var(--success); }
  .dot.waiting { background: var(--warning); }
  .dot.failed { background: var(--danger); }
  .queued { color: var(--text-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
