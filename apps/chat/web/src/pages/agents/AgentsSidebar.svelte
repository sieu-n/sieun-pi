<script lang="ts">
  import { agents, connection, jobs, me, type AgentSummary } from "$lib/api";
  import { Avatar, IconButton, Menu, type Anchor, type MenuEntry } from "$lib/ui";
  import { hrefFor, router } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import { folds } from "$lib/shell/folds.svelte";
  import { agentFromRoute, agentGroups, agentOfRoute, agentsFilterFromParams, dotOf } from "./agents-model";
  import { agentMenu } from "./agent-actions.svelte";
  import { createAgent } from "./create-agent.svelte";
  import HostBadge from "./HostBadge.svelte";

  /** The agent whose page is open, also while one of its jobs is open. */
  const selected = $derived(router.route.page === "agents" ? agentOfRoute(agentFromRoute(router.route.rest), jobs.list) : null);
  const groups = $derived(agentGroups(agents.list));
  const frame = $derived(!agents.ready ? "loading" : connection.connected ? "ready" : "offline");
  const onGrid = $derived(router.route.page === "agents" && !router.route.rest.length);
  const archivedView = $derived(onGrid && agentsFilterFromParams(router.route.params) === "archived");

  /** The one open row menu, the same menu as the agent's card, opened by its "..." or a right-click, as a Slack sidebar row does. */
  let menu = $state<{ id: string; anchor: Anchor; items: MenuEntry[] } | null>(null);
  function openMenu(agent: AgentSummary, anchor: Anchor): void {
    menu = { id: agent.id, anchor, items: agentMenu(agent) };
  }
  function contextMenu(e: MouseEvent, agent: AgentSummary): void {
    e.preventDefault();
    openMenu(agent, { x: e.clientX, y: e.clientY });
  }
</script>

<SidebarFrame title="Agents" root="agents" state={frame} loadingText="Loading agents…">
  {#snippet actions()}
    <IconButton icon="plus" label="New agent" size="sm" onclick={() => createAgent.open()} />
  {/snippet}

  <div class="top">
    <SidebarRow href={hrefFor("agents")} label="All agents" icon="robot" selected={onGrid && !archivedView} />
    <SidebarRow href={hrefFor("agents", [], { show: "archived" })} label="Archived" icon="archive" selected={archivedView} />
  </div>

  {#if agents.ready}
    {#each groups as group (group.id)}
      {@const key = `agents:${group.id}`}
      {@const folded = folds.isFolded(key)}
      <SidebarSection
        id={group.id}
        label={group.label}
        count={group.agents.length}
        {folded}
        ontoggle={() => folds.toggle(key)}
        empty={group.id === "working" ? "Nobody is working." : "No idle agents."}
        isEmpty={!group.agents.length}
      >
        {#each folded ? group.agents.filter((agent) => agent.id === selected) : group.agents as agent (agent.id)}
          <SidebarRow
            href={hrefFor("agents", [agent.id])}
            label={agent.name}
            title={agent.preview ? `${agent.name}: ${agent.preview}` : agent.name}
            selected={agent.id === selected}
            working={agent.status === "working" ? [agent.name] : []}
            oncontextmenu={(e) => contextMenu(e, agent)}
          >
            {#snippet leading()}
              <Avatar name={agent.name} kind="agent" seed={agent.id} size={20} status={dotOf(agent.status)} />
            {/snippet}
            {#snippet tag()}<HostBadge {agent} self={me.value?.host} />{/snippet}
            {#snippet actions()}
              <IconButton icon="more" label="{agent.name} options" size="xs" aria-haspopup="menu" aria-expanded={menu?.id === agent.id} onclick={(e) => openMenu(agent, e.currentTarget)} />
            {/snippet}
          </SidebarRow>
        {/each}
      </SidebarSection>
    {/each}
  {/if}
</SidebarFrame>

<Menu open={!!menu} anchor={menu?.anchor} items={menu?.items ?? []} label="Agent options" placement="bottom-start" onclose={() => (menu = null)} />

<style>
  .top {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
