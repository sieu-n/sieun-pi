<script lang="ts">
  import { reads, view, type AgentFolder } from "$lib/api";
  import { Button, EmptyState, LoadingText } from "$lib/ui";
  import { folderOwner, withFolder, type AgentTabProps } from "./agent-tab";
  import AgentMemory from "./AgentMemory.svelte";
  import ConfigFileRow from "./ConfigFileRow.svelte";
  import FolderNote from "./FolderNote.svelte";

  /**
   * The Memory tab: the agent's memory store, apart from its skills (owner, t8 answer msg mwwlxbdo, 11-26: memory "should scale to 10,000s
   * of entries"). The store can hold tens of thousands of entries, so the tab shows the newest page and searches the whole store on the
   * server, and it lists the shared stores every thread also reads.
   */
  let { agentId, agent, config, onconfig }: AgentTabProps = $props();

  const folder = $derived(config.folder);
  const owner = $derived(folderOwner(config, agent, agentId));
  /** The folder with its newest memory page, read while the tab shows and kept for its next open. */
  const memoryFolder = view(() => (folder ? reads.agentFolder(folder.agent) : null));
  const stores = $derived(config.memory.related.filter((file) => file.loaded !== false));

  function setFolder(next: AgentFolder) {
    onconfig(withFolder(config, next));
    if (memoryFolder.value?.agent === next.agent) memoryFolder.set(next);
  }
</script>

<section class="block" aria-label="Memory" data-testid="memory-tab">
  {#if folder}
    {#if !owner.own}<FolderNote agent={folder.agent} name={owner.name} />{/if}
    {#if memoryFolder.value}
      <AgentMemory folder={memoryFolder.value} name={owner.name} readonly={!owner.own} onsaved={setFolder} />
    {:else if memoryFolder.error}
      <EmptyState icon="warning" title="The memory could not load" description={memoryFolder.error} size="sm">
        {#snippet action()}<Button size="sm" icon="refresh" onclick={() => memoryFolder.refresh()}>Retry</Button>{/snippet}
      </EmptyState>
    {:else}
      <div class="loading"><LoadingText text="Reading its memory…" /></div>
    {/if}
  {:else}
    <div class="callout" data-memory="none">
      <h3 class="t-label-sm">No memory of its own</h3>
      <p class="t-body-sm">{config.memory.note}</p>
    </div>
  {/if}
  {#if stores.length}
    <h3 class="t-caption heading">Shared stores</h3>
    <ul class="files" aria-label="Shared stores">{#each stores as item (item.path)}<ConfigFileRow {item} />{/each}</ul>
  {/if}
</section>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .heading {
    margin: var(--space-4) 0 0;
    color: var(--text-metadata);
  }
  p {
    margin: 0;
  }
</style>
