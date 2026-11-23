<script lang="ts">
  import { api, type ProjectList } from "$lib/api";
  import { Badge, Button, Chip, Markdown, StatusDot, stampLabel, toast } from "$lib/ui";
  import { conversationHref, hrefFor } from "$lib/router.svelte";
  import { STATUS_LABEL } from "./agents-model";
  import { commArchived, commLabel, commThreadsOf, folderOwner, hostLineOf, money, plural, statusDot, withFolder, type AgentTabProps } from "./agent-tab";
  import AgentBrief from "./AgentBrief.svelte";
  import CopyPath from "./CopyPath.svelte";
  import FolderNote from "./FolderNote.svelte";
  import ProjectPicker from "./ProjectPicker.svelte";

  /** The Brief tab: what the agent is for and where it runs, its brief, its first input and its model. */
  let { agentId, agent, config, reload, onconfig, onsection, onmessage }: AgentTabProps = $props();

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
  const ownFolder = $derived(owner.own);
  const folderName = $derived(owner.name);
  const setFolder = (next: Parameters<typeof withFolder>[1]) => onconfig(withFolder(config, next));
  const hostLine = $derived(hostLineOf(config));
  const commThreads = $derived(commThreadsOf(config, agent));
  const boardHref = $derived(config.board ? hrefFor("board", [config.board.chat]) : null);
</script>

<section class="block project" aria-label="Project folder" data-fact="cwd" data-project={config.runs.project ? "yes" : "no"}>
  <div class="project-head">
    <h3 class="t-caption heading">Project folder</h3>
    {#if !config.runs.project}<Badge tone="danger">No project</Badge>{/if}
    {#if !config.runs.cwdExists}<span class="t-caption warn">Not on this box</span>{/if}
    {#if config.runs.canMove && !moving}<button type="button" class="more t-caption" aria-label="Change project folder" onclick={startMove}>Change</button>{/if}
  </div>
  <CopyPath value={config.runs.cwd} label="working directory" />
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
</section>
{#if folder}
  {#if !ownFolder}<FolderNote agent={folder.agent} name={folderName} />{/if}
  <AgentBrief {folder} name={folderName} purpose={config.identity.purpose?.text ?? null} readonly={!ownFolder} onsaved={setFolder} />
{/if}
<section class="block" aria-label="Purpose">
  <h3 class="t-caption heading">First input</h3>
  {#if config.identity.purpose}
    <div class="purpose t-body-sm"><Markdown text={config.identity.purpose.text} /></div>
    <span class="t-caption meta">
      First input from {config.identity.purpose.from.name}{config.identity.purpose.via ? ` via ${config.identity.purpose.via}` : ""}, {stampLabel(config.identity.purpose.at)}
    </span>
  {:else}
    <p class="t-caption meta">No first input yet.</p>
  {/if}
</section>
<dl class="facts">
  <dt>Host</dt>
  <dd data-fact="host">
    <a href={hrefFor("settings", ["hosts"])} title="Open Settings > Hosts">{config.runs.host}</a>
    <span class="t-caption meta">{hostLine} · picked when it was created</span>
  </dd>
  <dt>Model</dt>
  <dd data-fact="model">{agent?.model ? agent.model.label : "No model yet"}{#if agent?.thinkingLevel}<span class="t-caption meta">{agent.thinkingLevel} thinking</span>{/if}</dd>
  {#if agent?.comm?.length}
    <dt>Threads</dt>
    <dd data-fact="threads">
      <span class="comm"><StatusDot status={statusDot(agent.status)} label={STATUS_LABEL[agent.status]} /><a href={conversationHref(agent.thread)} data-work-thread={agent.thread}>Main thread</a></span>
      {#each commThreads as comm (comm.thread)}
        <span class="comm" data-comm-thread={comm.thread} data-room={comm.room}>
          <StatusDot status={statusDot(comm.status)} label={STATUS_LABEL[comm.status]} />
          <a href={conversationHref(comm.thread)}>{commLabel(config, comm.room)}</a>
          {#if commArchived(config, comm.room)}<Chip size="sm" label="Archived" />{/if}
        </span>
      {/each}
    </dd>
  {/if}
  <dt>Board</dt>
  <dd data-fact="board">
    {#if config.board}
      <a href={boardHref}>{config.board.own ? "Its board" : `Board of ${config.board.chatName}`}</a>
      <span class="t-caption meta">{config.board.steps.open} open · {config.board.steps.done} done · {plural(config.board.openTodos.length, "ask")} for you</span>
    {:else}
      <span class="meta">None yet. It writes one when it plans work.</span>
      {#if agent && !agent.archived}<button type="button" class="more t-caption" onclick={() => onmessage(agent)}>Message {agent.name}</button>{/if}
    {/if}
  </dd>
  <dt>Memory</dt>
  <dd data-fact="memory">
    {#if folder}<span>{plural(folder.memory.count, "memory", "memories")}{ownFolder ? "" : ` of ${folderName}`}</span>{:else}<span>None of its own</span>{/if}
    <button type="button" class="more t-caption" onclick={() => onsection("knowledge")}>Details</button>
  </dd>
  <dt>Jobs</dt>
  <dd data-fact="jobs">
    {plural(config.swarm.jobs.filter((j) => !j.archived).length, "job")}{config.swarm.jobs.some((j) => j.status === "working") ? `, ${config.swarm.jobs.filter((j) => j.status === "working").length} working` : ""}
    <button type="button" class="more t-caption" onclick={() => onsection("threads")}>Details</button>
  </dd>
  {#if agent?.kind === "chat"}
    <dt>Duties</dt>
    <dd data-fact="duties">
      {#if config.swarm.duties.length}
        {plural(config.swarm.duties.length, "duty", "duties")}{config.swarm.duties.some((d) => d.paused) ? `, ${config.swarm.duties.filter((d) => d.paused).length} paused` : ""}
        <button type="button" class="more t-caption" onclick={() => onsection("duties")}>Details</button>
      {:else}
        <span class="meta">None yet</span>
        <button type="button" class="more t-caption" onclick={() => onsection("duties")}>Add a duty</button>
      {/if}
    </dd>
  {/if}
  {#if config.usage}
    <dt>Last 7 days</dt>
    <dd data-fact="usage">{money(config.usage.cost)} · {plural(config.usage.turns, "turn")}</dd>
  {/if}
</dl>
