<script lang="ts">
  import { api, type ProjectList } from "$lib/api";
  import { Badge, Button, Markdown, stampLabel, toast } from "$lib/ui";
  import { hrefFor } from "$lib/router.svelte";
  import { folderOwner, money, plural, withFolder, type AgentTabProps } from "./agent-tab";
  import AgentFolderText from "./AgentFolderText.svelte";
  import CopyPath from "./CopyPath.svelte";
  import FolderNote from "./FolderNote.svelte";
  import ProjectPicker from "./ProjectPicker.svelte";

  /**
   * The Brief tab: what the agent is for and what it is on, its brief and its working memory, and what it runs on, its model, host and
   * project folder, with its first input. Its threads, duties, memory and board have their own tabs.
   */
  let { agentId, agent, config, reload, onconfig, onsection }: AgentTabProps = $props();

  /** What runs on its model: the main thread and each comm thread, which a model change moves too (app.ts `patch`), and the jobs it starts. */
  const modelLine = $derived.by(() => {
    if (agent?.kind !== "chat") return "This job runs on it.";
    const comms = agent.comm?.length ?? 0;
    return `Its main thread${comms ? ` and its ${plural(comms, "comm thread")}` : ""} run on it, and so do the jobs it starts.`;
  });

  let moving = $state(false);
  let projects = $state<ProjectList | null>(null);
  let nextCwd = $state("");
  let saving = $state(false);
  let moveError = $state("");
  $effect(() => {
    void agentId;
    moving = false;
  });
  async function startMove() {
    moveError = "";
    moving = true;
    projects ??= await api.projects().catch(() => ({ projects: [], default: null, home: "" }));
    nextCwd = config.runs.project ? config.runs.cwd : (projects.default ?? "");
  }
  async function saveMove() {
    if (saving) return;
    saving = true;
    moveError = "";
    try {
      await api.setAgentCwd(agentId, nextCwd.trim());
      moving = false;
      toast.success("Its next turn runs in the new folder");
      await reload();
    } catch (reason) {
      moveError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      saving = false;
    }
  }
  const folder = $derived(config.folder);
  const owner = $derived(folderOwner(config, agent, agentId));
  const setFolder = (next: Parameters<typeof withFolder>[1]) => onconfig(withFolder(config, next));
  /** A job's first input is the task it was given, so its page opens on it; a chat's sits last, under what it runs on. */
  const job = $derived(agent?.kind !== "chat");
</script>

{#snippet firstInput()}
  {#if config.identity.purpose}
    <section class="block" aria-label="First input">
      <h3 class="t-caption heading">First input</h3>
      <div class="purpose t-body-sm"><Markdown text={config.identity.purpose.text} /></div>
      <span class="t-caption meta">
        From {config.identity.purpose.from.name}{config.identity.purpose.via ? ` via ${config.identity.purpose.via}` : ""}, {stampLabel(config.identity.purpose.at)}
      </span>
    </section>
  {/if}
{/snippet}

{#if job}{@render firstInput()}{/if}
{#if folder}
  {#if !owner.own}<FolderNote agent={folder.agent} name={owner.name} />{/if}
  <AgentFolderText doc="brief" {folder} name={owner.name} purpose={config.identity.purpose?.text ?? null} readonly={!owner.own} onsaved={setFolder} />
  <AgentFolderText doc="workingMemory" {folder} name={owner.name} readonly={!owner.own} onsaved={setFolder} />
{/if}
<dl class="facts">
  <dt>Model</dt>
  <dd data-fact="model">
    {#if agent?.model}
      <span>{agent.model.label}{agent.thinkingLevel ? ` · ${agent.thinkingLevel} thinking` : ""}</span>
      <span class="t-caption meta">{modelLine}</span>
    {:else}
      No model yet
    {/if}
  </dd>
  <dt>Host</dt>
  <dd data-fact="host">
    <a href={hrefFor("settings", ["hosts"])} title="Open Settings > Hosts">{config.runs.host}</a>
    <span class="t-caption meta">Picked when it was created</span>
  </dd>
  <dt>Project folder</dt>
  <dd class="folder" data-fact="cwd" data-project={config.runs.project ? "yes" : "no"}>
    <span class="cwd">
      <CopyPath value={config.runs.cwd} label="working directory" />
      {#if !config.runs.project}<Badge tone="danger">No project</Badge>{/if}
      {#if !config.runs.cwdExists}<span class="t-caption warn">Not on this box</span>{/if}
      {#if config.runs.canMove && !moving}<button type="button" class="more t-caption" aria-label="Change project folder" onclick={startMove}>Change</button>{/if}
    </span>
    {#if !config.runs.project}
      <p class="t-caption warn">It runs in the home folder, so it reads no project's AGENTS.md, skills or rules.</p>
    {/if}
    {#if moving}
      <div class="move">
        <ProjectPicker {projects} bind:value={nextCwd} disabled={saving || !projects} id="agent-project" />
        <div class="move-actions">
          <Button size="sm" variant="ghost" onclick={() => (moving = false)} disabled={saving}>Cancel</Button>
          <Button size="sm" variant="primary" onclick={saveMove} loading={saving} disabled={saving || !nextCwd.trim() || nextCwd.trim() === config.runs.cwd}>Move</Button>
        </div>
        <p class="t-caption meta">Its next turn runs its tools, prompt and Python kernel in this folder.</p>
        {#if moveError}<p class="t-caption warn" role="alert">{moveError}</p>{/if}
      </div>
    {/if}
  </dd>
  {#if config.usage}
    <dt>Last 7 days</dt>
    <dd data-fact="usage">
      {money(config.usage.cost)} over {plural(config.usage.turns, "turn")}
      <button type="button" class="more t-caption" onclick={() => onsection("threads")}>By thread</button>
    </dd>
  {/if}
</dl>
{#if !job}{@render firstInput()}{/if}

<style>
  .cwd {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .facts > dd.folder {
    flex-direction: column;
    align-items: flex-start;
  }
</style>
