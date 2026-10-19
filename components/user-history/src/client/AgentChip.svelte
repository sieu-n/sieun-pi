<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import type { ChatAgent, PlanItem } from "../shared/types.ts";
  import { queueText, stepAgent, stepAgentTitle } from "./board.ts";
  import { clock } from "./clock.svelte.ts";
  import { store } from "./store.svelte.ts";

  /**
   * A plan step's agent after its text, in the Plan card and the plan view: the Agents card's status dot (a spinner while it works) and the
   * agent's name (`stepAgent`) in full, wrapped onto more lines when it is long, with the dot on its first line. A click opens it in place: an Agents row through
   * `onagent` (the job drawer or the thread), a stored session as its thread, an owner with no row through `onjob`. `onopen` runs first (the plan view closes itself). An agent
   * whose turn waits in the Mac-wide turn queue shows the waiting dot; its place and wait ("Queued 3 of 7, waiting 4 min") show only in the tooltip.
   */
  let { chat, item, agents, onagent, onjob, previewJob, onopen = () => {} }: {
    chat: string; item: PlanItem; agents: readonly ChatAgent[]; onagent: (agent: ChatAgent) => void; onjob: (owner: string) => void;
    previewJob: (owner: string) => string | undefined; onopen?: () => void;
  } = $props();

  const chip = $derived(stepAgent(item, agents));
  const name = $derived(chip ? chip.agent ? chip.name : store.session(chip.sessionId ?? chip.job ?? null)?.name ?? chip.name : "");
  const preview = $derived(chip?.agent ? chip.agent.job : chip?.job ? previewJob(chip.job) : undefined);
  const queued = $derived(chip?.agent?.queued ? queueText(chip.agent.queued, clock.now) : "");
  function open(): void {
    if (!chip) return;
    onopen();
    if (chip.agent) onagent(chip.agent);
    else if (chip.sessionId) store.openArtifact({ kind: "thread", sessionId: chip.sessionId }, chat);
    else if (chip.job) onjob(chip.job);
  }
</script>

{#if chip}
  <button type="button" class="link-chip agent-chip" title={stepAgentTitle(chip, name, queued || chip.agent?.wait || "")} data-preview-chat={chat} data-preview-job={preview} onclick={open}>
    {#if queued || chip.agent?.wait}<span class="dot waiting"></span>{:else if chip.state === "working"}<Spinner />{:else}<span class="dot {chip.state ?? ""}"></span>{/if}<span class="chip-label">{name}</span></button>
{/if}

<style>
  .agent-chip { vertical-align: top; margin-left: 4px; gap: 4px; max-width: 100%; align-items: flex-start; text-align: left; }
  .agent-chip .chip-label { white-space: normal; overflow-wrap: anywhere; }
  .agent-chip > :global(.spinner) { margin-top: 3.5px; }
  .dot { flex: none; width: 7px; height: 7px; margin-top: 5.5px; border-radius: 50%; background: var(--border-strong); }
  .dot.idle { background: var(--success); }
  .dot.waiting { background: var(--warning); }
  .dot.failed { background: var(--danger); }
</style>
