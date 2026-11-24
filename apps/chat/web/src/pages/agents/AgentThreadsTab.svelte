<script lang="ts">
  import { Badge, Button, Chip, Disclosure, LoadingText, StatusDot, stampLabel } from "$lib/ui";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import type { AgentWake } from "$lib/api";
  import MemberPicker from "$pages/channel/MemberPicker.svelte";
  import { removeMembership } from "$pages/channel/membership";
  import { STATUS_LABEL } from "./agents-model";
  import { commArchived, commLabel, commNotMember, commThreadsOf, hostLineOf, money, plural, statusDot, type AgentTabProps } from "./agent-tab";
  import { capped, ROWS_SHOWN, usageRows, wakeWhen } from "./threads-tab";
  import AgentJobs from "./AgentJobs.svelte";
  import ConfigFileRow from "./ConfigFileRow.svelte";
  import CopyPath from "./CopyPath.svelte";

  /** The Threads tab: its main thread, comm threads, what they cost over 7 days, their wakes, its rooms, its jobs and where they run. */
  let { agentId, agent, config, reload }: AgentTabProps = $props();

  let addingRoom = $state(false);
  let roomAnchor = $state<HTMLElement>();
  let allComm = $state(false);
  let allWakes = $state(false);
  let whereOpen = $state(false);
  const hostLine = $derived(hostLineOf(config));
  const commThreads = $derived(commThreadsOf(config, agent));
  const wakes = $derived(config.swarm.wakes ?? []);
  const whereDetail = $derived(hostLine.startsWith(config.runs.host) ? hostLine : `${config.runs.host} · ${hostLine}`);
  const wakeHref = (wake: AgentWake) => (wake.kind === "jobs" || wake.id.includes(":") ? hrefFor("agents", [wake.id]) : conversationHref(wake.id));
</script>

{#if agent?.kind === "chat"}
  <section class="block" aria-label="Threads" data-testid="agent-threads">
    <h3 class="t-caption heading">Threads</h3>
    <ul class="list">
      <li><StatusDot status={statusDot(agent.status)} label={STATUS_LABEL[agent.status]} /><a class="grow" href={conversationHref(agent.thread)} data-work-thread={agent.thread}>Main thread</a></li>
      {#each capped(commThreads, allComm) as comm (comm.thread)}
        {@const notMember = commNotMember(config, comm.room)}
        <li data-comm-thread={comm.thread} data-room={comm.room} data-member={notMember ? "no" : undefined}>
          <StatusDot status={statusDot(comm.status)} label={STATUS_LABEL[comm.status]} />
          <a class="grow" href={conversationHref(comm.thread)}>{commLabel(config, comm.room)}</a>
          {#if commArchived(config, comm.room)}<Chip size="sm" label="Archived" />{:else if notMember}<Chip size="sm" label={notMember} />{/if}
        </li>
      {/each}
      {#if commThreads.length > ROWS_SHOWN}
        <li><button type="button" class="more t-caption" onclick={() => (allComm = !allComm)}>{allComm ? "Show fewer" : `Show all ${commThreads.length} comm threads`}</button></li>
      {/if}
    </ul>
  </section>
{/if}
{#if config.usage}
  {@const rows = usageRows(config.usage)}
  <section class="block" aria-label="Last 7 days" data-testid="agent-usage">
    <h3 class="t-caption heading">Last 7 days</h3>
    <p class="t-body-sm total" data-usage-total>{config.usage.turns ? `${money(config.usage.cost)} over ${plural(config.usage.turns, "turn")}` : "No turns in the last 7 days."}</p>
    {#if rows.length > 1}
      <dl class="facts">
        {#each rows as row (row.kind)}
          <dt>{row.label}</dt>
          <dd data-usage={row.kind}>{money(row.cost)} · {plural(row.turns, "turn")}{#if row.kind !== "main"}<span class="t-caption meta">{plural(row.threads, "thread")} ran</span>{/if}</dd>
        {/each}
      </dl>
    {/if}
  </section>
{:else if config.pending}
  <section class="block" aria-label="Last 7 days" data-testid="agent-usage" data-pending>
    <h3 class="t-caption heading">Last 7 days</h3>
    <p class="t-body-sm total"><LoadingText /></p>
  </section>
{/if}
<section class="block" aria-label="Wakes" data-testid="agent-wakes">
  <h3 class="t-caption heading">Wakes</h3>
  {#if wakes.length}
    <ul class="list">
      {#each capped(wakes, allWakes) as wake, i (`${wake.id}-${wake.since}-${i}`)}
        <li data-wake={wake.id} data-wake-kind={wake.on.kind}>
          <span class="grow">
            <span><a href={wakeHref(wake)}>{wake.name}</a> <span class="meta">wakes {wakeWhen(wake.on, stampLabel)}</span></span>
            {#if wake.note}<span class="t-caption meta note-line" title={wake.note}>{wake.note}</span>{/if}
          </span>
        </li>
      {/each}
      {#if wakes.length > ROWS_SHOWN}
        <li><button type="button" class="more t-caption" onclick={() => (allWakes = !allWakes)}>{allWakes ? "Show fewer" : `Show all ${wakes.length} wakes`}</button></li>
      {/if}
    </ul>
  {:else}
    <span class="t-caption meta">No thread of {config.agent.name} has a board.wake set.</span>
  {/if}
</section>
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
{#if config.swarm.parent}
  <section class="block">
    <h3 class="t-caption heading">Coordinator</h3>
    <a href={hrefFor("agents", [config.swarm.parent.id])}>{config.swarm.parent.name}</a>
  </section>
{/if}
<section class="block" aria-label="Jobs list">
  <h3 class="t-caption heading">Jobs</h3>
  {#if config.swarm.jobs.length}
    <AgentJobs jobs={config.swarm.jobs} onchanged={reload} />
  {:else}
    <span class="t-caption meta" data-testid="no-jobs">{config.agent.name} has started no jobs yet.</span>
  {/if}
</section>
<section class="where" aria-label="Where it runs" data-testid="where-it-runs">
  <Disclosure title="Where it runs" detail={whereDetail} bind:open={whereOpen}>
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
      {#if config.identity.wakeAt && agent?.status === "sleeping"}
        <dt>Sleeps until</dt>
        <dd>{stampLabel(config.identity.wakeAt)}</dd>
      {/if}
    </dl>
    <ul class="files">
      {#if config.runs.threadFile}<ConfigFileRow item={config.runs.threadFile} />{:else}<li class="t-caption meta">The fixture host keeps its threads in memory, with no thread file.</li>{/if}
      <ConfigFileRow item={{ label: "Chat server data", path: config.runs.dataDir, exists: true, size: null, modifiedAt: null, note: "Thread kinds, DMs, read marks, channels, duties and check-ins." }} />
    </ul>
  </Disclosure>
</section>

<style>
  .total {
    margin: 0;
    color: var(--text-standard);
  }
  .note-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where :global(.facts) {
    padding: var(--space-2) 0 var(--space-3) var(--space-6, 24px);
  }
  .where :global(.files) {
    padding-left: var(--space-6, 24px);
  }
</style>
