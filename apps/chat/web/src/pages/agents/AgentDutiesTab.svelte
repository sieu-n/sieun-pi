<script lang="ts">
  import { onDestroy } from "svelte";
  import { reads, view, type ConfigFile } from "$lib/api";
  import { LoadingText, ShowAllList } from "$lib/ui";
  import { hrefFor } from "$lib/router.svelte";
  import CheckInControl from "$pages/board/CheckInControl.svelte";
  import DutyList from "$pages/board/DutyList.svelte";
  import { dutiesCount } from "$pages/board/schedule";
  import type { AgentTabProps } from "./agent-tab";
  import ConfigFileRow from "./ConfigFileRow.svelte";

  /**
   * The Duties tab: a chat agent's duties with their runs, through the board's DutyList, and its check-in, through the board's CheckInControl.
   * A job has none of its own, so it links the agent or chat they belong to.
   */
  let { config }: AgentTabProps = $props();

  const chatId = $derived(config.agent.kind === "chat" ? config.agent.id : null);
  const dutyRows = view(() => (chatId ? reads.duties(chatId) : null));
  const checkIn = view(() => (chatId ? reads.checkIn(chatId) : null));
  const count = $derived(dutyRows.value ? dutiesCount(dutyRows.value.duties) : "");
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(clock));
</script>

{#if chatId}
  <section class="block" aria-label="Duties">
    <h3 class="t-caption heading">{count ? count.charAt(0).toUpperCase() + count.slice(1) : "Duties"}</h3>
    {#if dutyRows.value}
      <DutyList chatId={chatId} duties={dutyRows.value.duties} onchange={next => dutyRows.set({ duties: next })} {now} />
    {:else if dutyRows.error}
      <p class="t-caption warn">{dutyRows.error}</p>
    {:else}
      <LoadingText text="Loading duties…" />
    {/if}
  </section>
  <section class="block" aria-label="Check-in">
    <h3 class="t-caption heading">Check-in</h3>
    <CheckInControl chatId={chatId} view={checkIn.value} onchange={next => checkIn.set(next)} {now} />
  </section>
  {#if config.swarm.dutiesFile}
    <section class="block" aria-label="Duty files">
      <h3 class="t-caption heading">Where they live</h3>
      <ShowAllList items={[config.swarm.dutiesFile, ...config.swarm.dutyStates]} key={file => file.path} noun="files">
        {#snippet row(file: ConfigFile)}<ConfigFileRow item={file} />{/snippet}
      </ShowAllList>
    </section>
  {/if}
{:else}
  <section class="block" aria-label="Duties">
    {#if config.swarm.dutiesOf}
      <p class="t-caption belongs" data-testid="duties-owner">
        This job has no duties of its own. Its duties and check-in belong to <a href={hrefFor("agents", [config.swarm.dutiesOf.id], { section: "duties" })}>{config.swarm.dutiesOf.name}</a>.
      </p>
    {:else}
      <p class="t-caption belongs" data-testid="duties-owner">This job belongs to no agent or chat, so it has no duties or check-in.</p>
    {/if}
  </section>
{/if}
