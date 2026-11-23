<script lang="ts">
  import { reads, view } from "$lib/api";
  import { Button, EmptyState, LoadingText } from "$lib/ui";
  import { folderOwner, withFolder, type AgentTabProps } from "./agent-tab";
  import AgentMemory from "./AgentMemory.svelte";
  import ConfigFileRow from "./ConfigFileRow.svelte";
  import FolderNote from "./FolderNote.svelte";

  /** The Knowledge tab: the agent's memory, the files and skills it loads, and its scripts. */
  let { agentId, agent, config, onconfig }: AgentTabProps = $props();

  const folder = $derived(config.folder);
  const owner = $derived(folderOwner(config, agent, agentId));
  const ownFolder = $derived(owner.own);
  const folderName = $derived(owner.name);
  /** The entries, which the config counts but does not send, read while the tab shows and kept for its next open. */
  const memoryFolder = view(() => (folder ? reads.agentFolder(folder.agent) : null));
  function setFolder(next: Parameters<typeof withFolder>[1]) {
    onconfig(withFolder(config, next));
    if (memoryFolder.value?.agent === next.agent) memoryFolder.set(next);
  }
</script>

{#if folder}
  {#if !ownFolder}<FolderNote agent={folder.agent} name={folderName} />{/if}
  {#if memoryFolder.value}
    <AgentMemory folder={memoryFolder.value} name={folderName} readonly={!ownFolder} onsaved={setFolder} />
  {:else if memoryFolder.error}
    <EmptyState icon="warning" title="The memory could not load" description={memoryFolder.error} size="sm">
      {#snippet action()}<Button size="sm" icon="refresh" onclick={() => memoryFolder.refresh()}>Retry</Button>{/snippet}
    </EmptyState>
  {:else}
    <div class="loading"><LoadingText text="Reading its memory…" /></div>
  {/if}
{:else}
  <section class="block callout" data-memory="none">
    <h3 class="t-label-sm">No memory of its own</h3>
    <p class="t-body-sm">{config.memory.note}</p>
  </section>
{/if}
{#if config.memory.related.length}
  <section class="block" aria-label="Prime's global store">
    <h3 class="t-caption heading">Prime's global store</h3>
    {#if folder && config.memory.note}<p class="t-caption note">{config.memory.note}</p>{/if}
    <ul class="files">{#each config.memory.related as item (item.path)}<ConfigFileRow item={item} />{/each}</ul>
  </section>
{/if}
<section class="block callout"><p class="t-body-sm">{config.instructions.note}</p></section>
<h3 class="t-caption heading">Files that apply to its home directory</h3>
<ul class="files">
  {#each config.instructions.files as item (item.path)}<ConfigFileRow item={item} />{:else}<li class="t-caption meta">No AGENTS.md or CLAUDE.md in its home directory or above it.</li>{/each}
</ul>
