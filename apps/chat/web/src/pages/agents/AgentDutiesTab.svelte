<script lang="ts">
  import { reads, view } from "$lib/api";
  import { LoadingText, stampLabel } from "$lib/ui";
  import DutyList from "$pages/board/DutyList.svelte";
  import { everyLabel } from "./agents-model";
  import type { AgentTabProps } from "./agent-tab";
  import ConfigFileRow from "./ConfigFileRow.svelte";

  /** The Duties tab: a chat agent's duties, which it runs, pauses, edits, removes and adds through the board's list, and its check-in. */
  let { config }: AgentTabProps = $props();

  const dutyChat = $derived(config.agent.kind === "chat" ? config.agent.id : null);
  const dutyRows = view(() => (dutyChat ? reads.duties(dutyChat) : null));
</script>

<section class="block" aria-label="Duties">
  <h3 class="t-caption heading">Duties</h3>
  {#if dutyChat}
    {#if dutyRows.value}
      <DutyList chatId={dutyChat} duties={dutyRows.value.duties} onchange={next => dutyRows.set({ duties: next })} now={Date.now()} />
    {:else}
      <LoadingText text="Loading duties…" />
    {/if}
  {:else}
    <p class="t-caption meta">Duties belong to its chat.</p>
  {/if}
  {#if config.swarm.checkIn}
    <span class="t-caption meta">Check-in {everyLabel(config.swarm.checkIn.everyMs)}{config.swarm.checkIn.paused ? ", paused" : config.swarm.checkIn.nextAt ? `, next ${stampLabel(config.swarm.checkIn.nextAt)}` : ""}</span>
  {/if}
  {#if config.swarm.dutiesFile}<ul class="files"><ConfigFileRow item={config.swarm.dutiesFile} /></ul>{/if}
</section>
