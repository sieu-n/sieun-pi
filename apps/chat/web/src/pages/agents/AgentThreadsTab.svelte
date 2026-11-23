<script lang="ts">
  import { Badge, Button, Chip, StatusDot, stampLabel } from "$lib/ui";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import MemberPicker from "$pages/channel/MemberPicker.svelte";
  import { removeMembership } from "$pages/channel/membership";
  import { STATUS_LABEL } from "./agents-model";
  import { commArchived, commLabel, commThreadsOf, hostLineOf, statusDot, type AgentTabProps } from "./agent-tab";
  import AgentJobs from "./AgentJobs.svelte";
  import ConfigFileRow from "./ConfigFileRow.svelte";
  import CopyPath from "./CopyPath.svelte";

  /** The Threads tab: its main thread, comm threads, rooms, jobs and where they run. */
  let { agentId, agent, config, reload }: AgentTabProps = $props();

  let addingRoom = $state(false);
  let roomAnchor = $state<HTMLElement>();
  const hostLine = $derived(hostLineOf(config));
  const commThreads = $derived(commThreadsOf(config, agent));
</script>

{#if agent?.kind === "chat"}
  <section class="block" aria-label="Threads">
    <h3 class="t-caption heading">Threads</h3>
    <ul class="list">
      <li><StatusDot status={statusDot(agent.status)} label={STATUS_LABEL[agent.status]} /><a class="grow" href={conversationHref(agent.thread)} data-work-thread={agent.thread}>Main thread</a></li>
      {#each commThreads as comm (comm.thread)}
        <li data-comm-thread={comm.thread} data-room={comm.room}>
          <StatusDot status={statusDot(comm.status)} label={STATUS_LABEL[comm.status]} />
          <a class="grow" href={conversationHref(comm.thread)}>{commLabel(config, comm.room)}</a>
          {#if commArchived(config, comm.room)}<Chip size="sm" label="Archived" />{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
<section class="block" aria-label="Rooms">
  <h3 class="t-caption heading">Channels and Solo rooms</h3>
  <div class="chips">
    {#each config.swarm.rooms as room (room.id)}
      {@const place = room.kind === "solo" ? room.name : `#${room.name}`}
      <Chip
        size="sm"
        icon={room.kind === "solo" ? "users" : "hash"}
        label={room.name}
        onclick={() => router.openConversation(room.id)}
        removeLabel="Remove {config.agent.name} from {place}"
        onremove={() => void removeMembership({ room: room.id, roomName: room.name, agent: agentId, agentName: config.agent.name }, { wakeOn: room.wakeOn, refresh: reload })}
      />
    {:else}
      <span class="t-caption meta">In no channel or Solo room.</span>
    {/each}
    {#if agentId.startsWith("ag_")}
      <Button variant="ghost" size="sm" icon="plus" bind:element={roomAnchor} onclick={() => (addingRoom = true)} data-testid="add-to-channel">Add to channel or Solo room</Button>
    {/if}
  </div>
  <MemberPicker
    bind:open={addingRoom}
    anchor={roomAnchor}
    target={{ kind: "agent", agent: agentId, name: config.agent.name, rooms: config.swarm.rooms.map((room) => room.id), test: config.agent.test === true }}
    refresh={reload}
    placement="bottom-start"
  />
</section>
<h3 class="t-caption heading">Where it runs</h3>
<dl class="facts">
  <dt>Host</dt>
  <dd>{config.runs.host}</dd>
  <dt>Through</dt>
  <dd>{hostLine}{config.runs.hostVersion ? "" : " (not answering)"}</dd>
  <dt>pi-host socket</dt>
  <dd><CopyPath value={config.runs.socket} label="pi-host socket" /></dd>
  <dt>Project folder</dt>
  <dd><CopyPath value={config.runs.cwd} label="working directory" />{#if !config.runs.project}<Badge tone="danger">No project</Badge>{/if}{#if !config.runs.cwdExists}<span class="t-caption warn">Not on this box: its tools fail there until the thread moves</span>{/if}</dd>
  <dt>Thread</dt>
  <dd><CopyPath value={config.runs.thread} label="thread id" /></dd>
  <dt>Conversation</dt>
  <dd>{config.runs.conversation === 1 ? "1, the root" : `${config.runs.conversation}, a job inside the thread`}</dd>
  <dt>Created</dt>
  <dd>{agent ? stampLabel(agent.createdAt) : ""}</dd>
  <dt>Last activity</dt>
  <dd>{agent ? stampLabel(agent.updatedAt) : ""}</dd>
  {#if config.identity.wakeAt}
    <dt>Wakes</dt>
    <dd>{stampLabel(config.identity.wakeAt)}</dd>
  {/if}
</dl>
<ul class="files">
  {#if config.runs.threadFile}<ConfigFileRow item={config.runs.threadFile} />{:else}<li class="t-caption meta">The fixture host keeps its threads in memory, with no thread file.</li>{/if}
  <ConfigFileRow item={{ label: "Chat server data", path: config.runs.dataDir, exists: true, size: null, modifiedAt: null, note: "Thread kinds, DMs, read marks, channels, duties and check-ins." }} />
</ul>
{#if config.swarm.parent}
  <section class="block">
    <h3 class="t-caption heading">Coordinator</h3>
    <a href={hrefFor("agents", [config.swarm.parent.id])}>{config.swarm.parent.name}</a>
  </section>
{/if}
<AgentJobs jobs={config.swarm.jobs} onchanged={reload} />
