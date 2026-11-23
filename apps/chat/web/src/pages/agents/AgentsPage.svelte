<script lang="ts">
  import { onMount } from "svelte";
  import { agents, api, connection, jobs, kept, panelsAhead, reads, view, type AgentSummary, type ThinkingLevel } from "$lib/api";
  import { Button, EmptyState, Menu, PanelHeader, Skeleton, Tabs, renderMarkdown, toast, type Anchor, type MenuEntry } from "$lib/ui";
  import { router, hrefFor } from "$lib/router.svelte";
  import AgentCard from "./AgentCard.svelte";
  import AgentConfigPanel from "./AgentConfigPanel.svelte";
  import CreateAgentDialog from "./CreateAgentDialog.svelte";
  import NewAgentTile from "./NewAgentTile.svelte";
  import { agentFromRoute, agentsFilterFromParams, agentsShown, hasForList, jobCounts, jobsLabel, renamedSection, sectionFromParams, type AgentsFilter, type ConfigSection } from "./agents-model";
  import { agentMenu, messageAgent, onAgentsChanged } from "./agent-actions.svelte";
  import { createAgent } from "./create-agent.svelte";

  /** `#/agents/<id>` opens that agent's page in place of the grid, or a job's, which its agent's Jobs tab links to. */
  const configId = $derived(agentFromRoute(router.route.rest));
  const section = $derived(sectionFromParams(router.route.params));
  const models = view(() => reads.models());
  const catalog = $derived(models.value);
  /**
   * Live and archived agents over HTTP, one read for the Archived tab and its count and for the list while the live socket has not
   * connected, so the page can show an error when it never does. It is read again after an archive, an unarchive or a rename. Two reads,
   * of the live and of the whole list, went at each rename before: in the p155 sweep at a 200 ms round trip the second answer took a
   * second round trip, 406 to 428 ms (~/work/p155-sweep/fix-agents-list/notes.md).
   */
  const listed = view(() => reads.allAgents());
  const fetched = $derived(listed.value?.filter((agent) => !agent.archived) ?? null);
  const loadError = $derived(agents.ready ? "" : (listed.error ?? ""));
  const filter = $derived(agentsFilterFromParams(router.route.params));
  const archived = $derived((listed.value ?? []).filter((agent) => agent.archived));
  onMount(() => onAgentsChanged(() => void listed.refresh()));
  let menu = $state<{ agent: AgentSummary; anchor: Anchor } | null>(null);
  let focused = $state<string | null>(null);
  let now = $state(Date.now());
  let grid = $state<HTMLDivElement>();
  const cards: Record<string, { openModelPicker: () => void }> = {};
  const elements: Record<string, HTMLElement> = $state({});

  const ready = $derived(agents.ready || fetched !== null);
  const all = $derived(agents.ready ? agents.list : (fetched ?? []));
  const configAgent = $derived(configId ? (all.find((agent) => agent.id === configId) ?? archived.find((agent) => agent.id === configId) ?? jobs.byId(configId) ?? null) : null);
  /** One card per registered agent; its jobs show only as the count on its card and in its Jobs tab. */
  const shown = $derived(filter === "archived" ? agentsShown(archived, "archived") : agentsShown(all));
  const filters = $derived([
    { id: "active" as const, label: "Active", badge: agentsShown(all).length },
    { id: "archived" as const, label: "Archived", ...(archived.length ? { badge: archived.length } : {}) },
  ]);
  function setFilter(next: AgentsFilter) {
    router.setParams({ show: next === "archived" ? "archived" : null }, { replace: true });
  }
  const jobsOf = $derived(jobCounts(jobs.list));

  const load = () => listed.refresh();
  /** Each card's page is read ahead while the grid shows, so a card opens with its configuration on the screen. */
  $effect(() => {
    panelsAhead("agents", shown.map((agent) => ({
      id: agent.id, at: agent.updatedAt, working: agent.status === "working",
      reads: [reads.agentConfig(agent.id), ...(hasForList(agent.id) ? [reads.forMe(agent.id)] : [])],
    })));
    return () => panelsAhead("agents", []);
  });
  /**
   * The markdown of each card's page, its first input and its brief, is rendered while the page is idle, so the open finds the HTML in
   * the renderer's cache. On 11-20 that render took 31 to 44 ms of an agent page's 104 to 177 ms open (~/work/p106-panel-open/summary.md).
   */
  $effect(() => {
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : (run: () => void) => setTimeout(run, 0);
    for (const agent of shown) {
      const config = kept(reads.agentConfig(agent.id)).value;
      if (!config) continue;
      idle(() => {
        if (config.identity.purpose) renderMarkdown(config.identity.purpose.text);
        if (config.folder?.brief.text) renderMarkdown(config.folder.brief.text);
      });
    }
  });
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** A card opens the agent's page; Message opens its conversation. */
  function configure(agent: AgentSummary) {
    router.navigate(hrefFor("agents", [agent.id]));
  }
  $effect(() => {
    const renamed = renamedSection(router.route.params);
    if (renamed) router.setParams({ section: renamed }, { replace: true });
  });
  function setSection(next: ConfigSection) {
    router.setParams({ section: next === "overview" ? null : next }, { replace: true });
  }
  async function run(label: string, action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast.success(done);
    } catch (reason) {
      toast.error(`${label} failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  function setModel(agent: AgentSummary, model: string, level: ThinkingLevel | undefined) {
    const label = catalog?.models.find((m) => `${m.provider}/${m.id}` === model)?.label ?? model;
    void run("Change model", () => api.setAgentModel(agent.id, model, level), `${agent.name} now runs ${label}${level ? ` · ${level}` : ""}`);
  }

  const menuItems = $derived.by((): MenuEntry[] => {
    if (!menu) return [];
    const agent = menu.agent;
    return agentMenu(agent, { model: () => requestAnimationFrame(() => cards[agent.id]?.openModelPicker()) });
  });

  /** Arrow keys move between cards in reading order, Up and Down by one row. */
  function onGridKey(event: KeyboardEvent) {
    const cell = event.target;
    if (!(cell instanceof HTMLElement) || cell.getAttribute("role") !== "gridcell") return;
    const index = shown.findIndex((agent) => agent.id === cell.dataset.agentId);
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    let next: number | undefined;
    if (event.key in step) next = index + step[event.key]!;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = shown.length - 1;
    if (next === undefined || next < 0 || next >= shown.length) return;
    event.preventDefault();
    const id = shown[next]!.id;
    focused = id;
    elements[id]?.focus();
  }
  const focusId = $derived(shown.some((agent) => agent.id === focused) ? focused : (shown[0]?.id ?? null));
</script>

{#if configId}
  <AgentConfigPanel
    agentId={configId}
    agent={configAgent}
    {catalog}
    {section}
    onsection={setSection}
    onmessage={messageAgent}
    onmodel={setModel}
  />
{:else}
  <PanelHeader title="Agents" icon="robot" level={1} divider />
  <div class="inventory">
    <div class="content">
      <div class="toolbar">
        <Tabs items={filters} value={filter} size="sm" label="Agents to show" onchange={setFilter} />
        <Button variant="primary" size="sm" icon="plus" onclick={() => createAgent.open()}>New agent</Button>
      </div>
      <div>
        {#if loadError && !ready}
          <EmptyState icon="warning" title="Agents could not load" description={loadError}>
            {#snippet action()}<Button size="sm" icon="refresh" onclick={load}>Retry</Button>{/snippet}
          </EmptyState>
        {:else if !ready}
          <div class="grid" aria-busy="true" aria-label="Loading agents">
            {#each { length: 6 } as _, i (i)}<div class="skeleton"><Skeleton width="100%" height="244px" radius="var(--radius-container)" /></div>{/each}
          </div>
        {:else if shown.length === 0 && filter === "archived"}
          <EmptyState icon="archive" title="No archived agents" description="Archive an agent from its menu to hide it here. Unarchive brings it back.">
            {#snippet action()}<Button size="sm" onclick={() => setFilter("active")}>Show active agents</Button>{/snippet}
          </EmptyState>
        {:else if shown.length === 0}
          <div class="starts">
            <NewAgentTile label="Create your first agent" onclick={() => createAgent.open()} />
          </div>
        {:else}
          <div bind:this={grid} class="grid" role="grid" aria-label={filter === "archived" ? "Archived agents" : "Your agents"} tabindex="-1" onkeydown={onGridKey}>
            <div role="row" class="row">
              {#each shown as agent (agent.id)}
                <AgentCard
                  bind:this={cards[agent.id]}
                  bind:element={elements[agent.id]}
                  {agent}
                  {catalog}
                  {now}
                  focusable={agent.id === focusId}
                  onfocus={() => (focused = agent.id)}
                  onopen={() => configure(agent)}
                  onmenu={(anchor) => (menu = { agent, anchor })}
                  onmodel={(model, level) => setModel(agent, model, level)}
                  jobs={jobsLabel(jobsOf.get(agent.id))}
                />
              {/each}
            </div>
          </div>
        {/if}
      </div>
      {#if !connection.connected && ready}<p class="offline t-caption" role="status">Offline · showing the last list. It updates when the connection comes back.</p>{/if}
    </div>
  </div>
{/if}

<Menu open={!!menu} anchor={menu?.anchor} items={menuItems} label={menu ? `Actions for ${menu.agent.name}` : "Actions"} placement="bottom-end" onclose={() => (menu = null)} />
<CreateAgentDialog
  bind:open={createAgent.isOpen}
  {catalog}
  onclose={() => createAgent.close()}
  oncreated={(agent) => {
    toast.success(`Created ${agent.name}`);
    router.openConversation(agent.room ?? agents.room(agent.id));
  }}
/>

<style>
  .inventory {
    flex: 1;
    min-height: 0;
    overflow: auto;
    container-type: inline-size;
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    width: 100%;
    max-width: 768px;
    margin-inline: auto;
    padding: clamp(var(--space-4), 6vh, calc(var(--space-16) + var(--space-4))) var(--space-6) var(--space-8);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 192px), 1fr));
    gap: var(--space-2);
    outline: none;
  }
  .row {
    display: contents;
  }
  .starts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 256px), 1fr));
    gap: var(--space-2);
  }
  .offline {
    margin: 0;
    color: var(--text-metadata);
    text-align: center;
  }
  @media (max-width: 560px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 360px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
