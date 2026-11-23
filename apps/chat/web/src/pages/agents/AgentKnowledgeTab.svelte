<script lang="ts">
  import { reads, view, type AgentFolder, type ConfigFile } from "$lib/api";
  import { Button, EmptyState, LoadingText, ShowAllList } from "$lib/ui";
  import { folderOwner, withFolder, type AgentTabProps } from "./agent-tab";
  import AgentMemory from "./AgentMemory.svelte";
  import ConfigFileRow from "./ConfigFileRow.svelte";
  import FolderNote from "./FolderNote.svelte";
  import PathRow from "./PathRow.svelte";
  import { fileName, loadOrder, scriptSource } from "./knowledge";

  /**
   * The Knowledge tab: what every thread of the agent knows and can use. Its memory, the skills its prompt lists (from the Prompt tab's read,
   * which pi-host's own loader builds), the instruction files it loads, and its scripts.
   */
  let { agentId, agent, config, onconfig }: AgentTabProps = $props();

  const folder = $derived(config.folder);
  const owner = $derived(folderOwner(config, agent, agentId));
  const ownFolder = $derived(owner.own);
  const folderName = $derived(owner.name);
  const name = $derived(folder ? folderName : (agent?.name ?? "this thread"));
  /** The entries, which the config counts but does not send, read while the tab shows and kept for its next open. */
  const memoryFolder = view(() => (folder ? reads.agentFolder(folder.agent) : null));
  /** The skills come with its prompts, which take pi-host a few seconds to build, so they read while the rest of the tab shows. */
  const prompt = view(() => reads.agentPrompt(agentId));
  const skills = $derived(prompt.value?.skills ?? []);
  /** Prime's global store, and a thread's own store when no agent holds it, which load into every thread; the Duties tab lists precheck state. */
  const stores = $derived(config.memory.related.filter((file) => file.loaded !== false));
  const files = $derived(loadOrder(config.instructions.files));
  const scripts = $derived(config.scripts ?? []);
  const fileKey = (file: ConfigFile) => file.path;

  function setFolder(next: AgentFolder) {
    onconfig(withFolder(config, next));
    if (memoryFolder.value?.agent === next.agent) memoryFolder.set(next);
  }
</script>

<section class="block" aria-label="Memory">
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
    <div class="callout" data-memory="none">
      <h3 class="t-label-sm">No memory of its own</h3>
      <p class="t-body-sm">{config.memory.note}</p>
    </div>
  {/if}
  {#if stores.length}
    <ul class="files" aria-label="Shared stores">{#each stores as item (item.path)}<ConfigFileRow {item} />{/each}</ul>
  {/if}
</section>

<section class="block" aria-label="Skills" data-testid="knowledge-skills">
  <h3 class="t-caption heading">Skills{skills.length ? ` · ${skills.length}` : ""}</h3>
  {#if prompt.value?.away}
    <p class="t-caption note">{prompt.value.away}</p>
  {:else if prompt.value}
    <p class="t-caption note">Every thread of {name} lists these in its prompt and reads a skill's SKILL.md when a task calls for it.</p>
    <ShowAllList items={skills} key={(skill) => skill.path} noun="skills" label="Skills" dense>
      {#snippet row(skill)}<PathRow name={skill.name} detail={skill.description} path={skill.path} />{/snippet}
    </ShowAllList>
    {#if !skills.length}<p class="t-caption meta">Its prompt lists no skills.</p>{/if}
  {:else if prompt.error}
    <p class="t-caption warn">The skill list could not load: {prompt.error}</p>
    <Button size="sm" icon="refresh" onclick={() => prompt.refresh()}>Retry</Button>
  {:else}
    <div class="loading"><LoadingText text="Reading the skills its prompt lists…" /></div>
  {/if}
</section>

<section class="block" aria-label="Instruction files" data-testid="knowledge-files">
  <h3 class="t-caption heading">Instruction files{files.length ? ` · ${files.length}` : ""}</h3>
  <p class="t-caption note">{config.instructions.note}</p>
  {#if files.length}
    <ShowAllList items={files} key={fileKey} noun="files" label="Instruction files">
      {#snippet row(item)}<ConfigFileRow {item} />{/snippet}
    </ShowAllList>
  {:else}
    <p class="t-caption meta">No AGENTS.md or CLAUDE.md in its home directory or above it.</p>
  {/if}
</section>

<section class="block" aria-label="Scripts" data-testid="knowledge-scripts">
  <h3 class="t-caption heading">Scripts{scripts.length ? ` · ${scripts.length}` : ""}</h3>
  {#if config.scripts === null}
    <p class="t-caption note">Its folder sits on another box, which this page does not read for scripts.</p>
  {:else if scripts.length}
    <p class="t-caption note">Scripts kept in its folder, named in its brief, or run by its duties.</p>
    <ShowAllList items={scripts} key={(script) => script.path} noun="scripts" label="Scripts" dense>
      {#snippet row(script)}<PathRow name={fileName(script.path)} detail={scriptSource(script.from)} path={script.path} changedAt={script.modifiedAt} />{/snippet}
    </ShowAllList>
  {:else}
    <p class="t-caption meta">None yet. A script kept in its folder, a script path in its brief, or the script a duty runs as its precheck shows here.</p>
  {/if}
</section>

<style>
  section + section {
    margin-top: var(--space-4);
  }
  p {
    margin: 0;
  }
</style>

