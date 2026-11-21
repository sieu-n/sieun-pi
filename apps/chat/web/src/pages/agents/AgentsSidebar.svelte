<script lang="ts">
  import { agents, connection, jobs, me } from "$lib/api";
  import { Avatar, IconButton } from "$lib/ui";
  import { hrefFor, router } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import { folds } from "$lib/shell/folds.svelte";
  import { agentFromRoute, agentGroups, agentOfRoute, dotOf } from "./agents-model";
  import { createAgent } from "./create-agent.svelte";
  import HostBadge from "./HostBadge.svelte";

  /** The agent whose page is open, also while one of its jobs is open. */
  const selected = $derived(router.route.page === "agents" ? agentOfRoute(agentFromRoute(router.route.rest), jobs.list) : null);
  const groups = $derived(agentGroups(agents.list));
  const state = $derived(!agents.ready ? "loading" : connection.connected ? "ready" : "offline");
</script>

<SidebarFrame title="Agents" root="agents" {state} loadingText="Loading agents…">
  {#snippet actions()}
    <IconButton icon="plus" label="New agent" size="sm" onclick={() => createAgent.open()} />
  {/snippet}

  <div class="top">
    <SidebarRow href={hrefFor("agents")} label="All agents" icon="robot" selected={router.route.page === "agents" && !router.route.rest.length} />
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
          >
            {#snippet leading()}
              <Avatar name={agent.name} kind="agent" seed={agent.id} size={20} status={dotOf(agent.status)} />
            {/snippet}
            {#snippet tag()}<HostBadge {agent} self={me.value?.host} />{/snippet}
          </SidebarRow>
        {/each}
      </SidebarSection>
    {/each}
  {/if}
</SidebarFrame>

<style>
  .top {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
