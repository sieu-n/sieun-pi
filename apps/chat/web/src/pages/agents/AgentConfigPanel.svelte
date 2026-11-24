<script lang="ts">
  import { kept, reads, view, type AgentConfig, type AgentSummary, type ModelCatalog, type RunStatus, type ThinkingLevel } from "$lib/api";
  import { get } from "$lib/api/client";
  import { Avatar, Badge, Button, EmptyState, IconButton, LoadingText, Menu, Meter, ModelPicker, PanelHeader, Tabs, TypingDots, stampLabel, type MenuEntry } from "$lib/ui";
  import { hrefFor, router } from "$lib/router.svelte";
  import { SECTIONS, STATUS_LABEL, canRename, forLabel, hasForList, levelsFor, modelKey, modelOptions, type ConfigSection } from "./agents-model";
  import type { AgentTabProps } from "./agent-tab";
  import AccountChip from "$pages/accounts/AccountChip.svelte";
  import AgentBriefTab from "./AgentBriefTab.svelte";
  import AgentDutiesTab from "./AgentDutiesTab.svelte";
  import AgentForMe from "./AgentForMe.svelte";
  import AgentKnowledgeTab from "./AgentKnowledgeTab.svelte";
  import AgentPromptTab from "./AgentPromptTab.svelte";
  import AgentThreadsTab from "./AgentThreadsTab.svelte";
  import { agentMenu, changeModel, onAgentsChanged, renameAgent, unarchiveAgent } from "./agent-actions.svelte";

  type Props = {
    agentId: string;
    /** The live card, so status and model update without a refetch. */
    agent: AgentSummary | null;
    catalog: ModelCatalog | null;
    section: ConfigSection;
    onsection: (section: ConfigSection) => void;
    onmessage: (agent: AgentSummary) => void;
  };
  let { agentId, agent: liveAgent, catalog, section, onsection, onmessage }: Props = $props();

  /** The agent's configuration, from the page's kept answer when it holds one and read again behind it. */
  const answer = view(() => reads.agentConfig(agentId));
  const config = $derived(answer.value);
  const error = $derived(answer.error ?? "");
  /**
   * The Prompt and Knowledge tabs draw the prompt's outline, 3.9 KB as brotli, and the Prompt tab shows each section's text from the whole
   * answer, 63 to 94 KB on 11-24; both are read ahead once the config came, so a click on either finds them kept.
   */
  const configShown = $derived(config !== null);
  $effect(() => {
    if (configShown) void kept(reads.agentPromptOutline(agentId)).ahead().then(() => kept(reads.agentPrompt(agentId)).ahead());
  });

  /** A new server's first answer comes before its usage sums, marked pending; the read that waits for them takes its place. */
  $effect(() => {
    const first = answer.value;
    if (!first?.pending) return;
    void get<AgentConfig>({ path: `${reads.agentConfig(agentId).path}?wait=1` }, { background: "ahead" }).then(fresh => {
      if (answer.value === first) answer.set(fresh);
    }, () => undefined);
  });

  const load = () => answer.refresh();
  /** A rename, archive or unarchive reads the page again, since an archived agent's card is not in the live list that updates the header. */
  $effect(() => onAgentsChanged(() => void load()));
  // A new status or model on the live card reads the config again, so jobs, board and usage follow the run.
  let seen = "";
  $effect(() => {
    const key = liveAgent ? `${liveAgent.status}|${liveAgent.model?.id ?? ""}|${liveAgent.thinkingLevel ?? ""}` : "";
    if (seen && key && key !== seen) void load();
    seen = key;
  });

  const agent = $derived(liveAgent ?? config?.agent ?? null);
  const current = $derived(agent?.model ? modelKey(agent.model) : "");
  const options = $derived.by(() => {
    const list = modelOptions(catalog);
    if (agent?.model && !list.some((option) => option.id === current)) list.push({ id: current, label: agent.model.label, family: "Other" });
    return list;
  });
  const running = $derived(agent?.status === "working" || agent?.status === "sleeping");
  const boardHref = $derived(config?.board ? hrefFor("board", [config.board.chat]) : null);
  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLButtonElement>();
  /** The header's "..." menu, the agent's one menu (`agentMenu`) after Open board; Message and the model sit in the header itself. */
  const menuItems = $derived.by((): MenuEntry[] => {
    if (!agent) return [];
    const board: MenuEntry[] = boardHref ? [{ id: "board", label: "Open board", icon: "board", onselect: () => router.navigate(boardHref) }] : [];
    return [...board, ...agentMenu(agent, { message: false })];
  });
  const forList = $derived(hasForList(agentId));
  const forName = $derived(agent?.name ?? config?.agent.name ?? "");
  const tabs = $derived(
    SECTIONS.filter((item) => item.id !== "for" || forList).map((item) => (item.id === "for" ? { ...item, label: forLabel(forName) } : { ...item })),
  );
  const dotOf = (status: RunStatus) => (status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : "offline");
  const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  /** What every tab gets from the page: the card, its configuration and the calls that read it again or keep a new answer. */
  const tabProps = $derived(config ? ({ agentId, agent, config, reload: load, onconfig: (next) => answer.set(next), onsection, onmessage } satisfies AgentTabProps) : null);
</script>

<div class="config" data-testid="agent-config" data-agent-id={agentId}>
  {#if agent}
    <PanelHeader>
      {#snippet titleContent()}
        <span class="identity">
          <Avatar name={agent.name} kind="agent" seed={agent.id} size={24} status={agent.status === "idle" ? null : dotOf(agent.status)} />
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <h1 class="t-label-sm name" title={canRename(agent) ? `${agent.name} · double-click to rename` : agent.name} ondblclick={() => canRename(agent) && renameAgent(agent)}>{agent.name}</h1>
          {#if agent.archived}<Badge>Archived</Badge>{/if}
          <span class="t-caption line" data-status={agent.status}>
            {#if running}<TypingDots mode={agent.status === "working" ? "working" : "waiting"} size={4} />{/if}
            <span>{STATUS_LABEL[agent.status]}</span>
            {#if agent.kind !== "chat"}<span>·</span><span>{config?.identity.duty ? "duty run" : "job"}</span>{/if}
            {#if agent.parent}<span>· in</span><a href={hrefFor("agents", [agent.parent.id])}>{agent.parent.name}</a>{/if}
          </span>
        </span>
      {/snippet}
      {#snippet actions()}
        <span class="actions" role="toolbar" aria-label="Agent actions">
          <span class="model">
            {#if agent.model}
              <ModelPicker models={options} value={current} efforts={levelsFor(catalog, current)} effort={agent.thinkingLevel ?? undefined}
                onchange={(next) => void changeModel(agent, next.model, next.effort as ThinkingLevel | undefined, catalog).then((ok) => { if (ok) void load(); })} />
              <AccountChip thread={agent.id} model={agent.model} />
            {:else}
              <span class="t-caption">No model yet</span>
            {/if}
          </span>
          {#if agent.archived}
            <Button size="sm" variant="primary" icon="unarchive" onclick={() => void unarchiveAgent(agent)}>Unarchive</Button>
          {:else}
            <Button size="sm" variant="primary" icon="chat" onclick={() => onmessage(agent)}>Message</Button>
          {/if}
          {#if menuItems.length}<IconButton icon="more" label="Actions for {agent.name}" size="sm" bind:element={menuAnchor} onclick={() => (menuOpen = !menuOpen)} />{/if}
        </span>
      {/snippet}
    </PanelHeader>
    <Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} label="Actions for {agent.name}" placement="bottom-end" />
  {/if}

  <div class="tabs">
    <Tabs items={tabs} value={section} variant="underline" size="sm" label="Configuration sections" onchange={onsection} />
  </div>

  <div class="body" role="tabpanel" aria-label={tabs.find((s) => s.id === section)?.label}>
    {#if section === "for" && forList}
      <AgentForMe {agentId} name={forName || agentId} />
    {:else if section === "prompt"}
      <AgentPromptTab {agentId} />
    {:else if error && !config}
      <EmptyState icon="warning" title="The configuration could not load" description={error} size="sm">
        {#snippet action()}<Button size="sm" icon="refresh" onclick={load}>Retry</Button>{/snippet}
      </EmptyState>
    {:else if !config}
      <div class="loading"><LoadingText text="Reading its configuration…" /></div>
    {:else if (section === "brief" || section === "for") && tabProps}
      <AgentBriefTab {...tabProps} />
    {:else if section === "threads" && tabProps}
      <AgentThreadsTab {...tabProps} />
    {:else if section === "board"}
      {#if config.board}
        {@const board = config.board}
        <section class="block">
          <div class="row-between">
            <h3 class="t-label-sm">{board.own ? "Its board" : `Board of ${board.chatName}`}</h3>
            <Button size="sm" icon="board" href={boardHref ?? undefined}>Open board</Button>
          </div>
          <span class="t-caption meta">{board.doc} rev {board.rev} · updated {stampLabel(Date.parse(board.updatedAt))}{board.own ? "" : " · shared with its chat"}</span>
          <Meter percent={board.steps.total ? (board.steps.done / board.steps.total) * 100 : 0} label="Steps done" value="{board.steps.done} / {board.steps.total}" warn={101} danger={101} />
          {#if board.awaitingGo}<span class="t-caption">{plural(board.awaitingGo, "step")} wait for your go</span>{/if}
        </section>
        <section class="block" aria-label="Goals">
          <h3 class="t-caption heading">Goals</h3>
          <ul class="list">
            {#each board.goals as goal (goal.id)}
              <li><a class="t-mono id" href={hrefFor("board", [board.chat], { focus: goal.id })}>{goal.id}</a><span class="grow">{goal.text}</span><span class="t-caption meta">{goal.status}{goal.open + goal.done ? ` · ${goal.done}/${goal.open + goal.done}` : ""}</span></li>
            {:else}
              <li class="t-caption meta">No goals yet.</li>
            {/each}
          </ul>
        </section>
        <section class="block" aria-label="Open asks">
          <h3 class="t-caption heading">Open asks for you</h3>
          <ul class="list">
            {#each board.openTodos as todo (todo.id)}
              <li><a class="t-mono id" href={hrefFor("board", [board.chat], { focus: todo.id })}>{todo.id}</a><span class="grow">{todo.text}</span></li>
            {:else}
              <li class="t-caption meta">Nothing waits for you.</li>
            {/each}
          </ul>
        </section>
      {:else}
        <EmptyState icon="board" title="No board yet" description="It writes its plan, its asks for you and its duties on a board once it plans work." size="sm">
          {#snippet action()}{#if agent && !agent.archived}<Button size="sm" icon="chat" onclick={() => onmessage(agent)}>Message {agent.name}</Button>{/if}{/snippet}
        </EmptyState>
      {/if}
    {:else if section === "knowledge" && tabProps}
      <AgentKnowledgeTab {...tabProps} />
    {:else if section === "duties" && tabProps}
      <AgentDutiesTab {...tabProps} />
    {/if}
  </div>
</div>

<style>
  .config {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .identity :global(.avatar) {
    flex: none;
  }
  .name {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-standard);
  }
  .line {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .line[data-status="failed"] {
    color: var(--text-danger);
  }
  .line a,
  .body :global(.facts a),
  .body :global(.block a) {
    color: var(--text-standard);
    text-decoration: underline;
    text-decoration-color: var(--border-standard);
    text-underline-offset: 2px;
  }
  .model {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .tabs {
    padding: 0 var(--space-4);
    --tab-gap: var(--space-3);
    overflow-x: auto;
    border-bottom: 1px solid var(--border-standard);
    scrollbar-width: none;
  }
  .tabs :global(.underline) {
    gap: var(--tab-gap);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-6) max(var(--space-6), calc((100% - 768px) / 2)) var(--space-8);
  }
  .body :global(.loading) {
    padding: var(--space-4) 0;
    color: var(--text-metadata);
  }
  .body :global(.block) {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }
  .body :global(.callout) {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
  }
  .body :global(.callout p),
  .body :global(.callout h3) {
    margin: 0;
  }
  .body :global(.heading) {
    margin: 0;
    color: var(--text-metadata);
  }
  .body :global(.meta) {
    color: var(--text-metadata);
  }
  .body :global(.warn) {
    color: var(--text-danger);
  }
  .body :global(.move) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
    gap: var(--space-2);
    padding-top: var(--space-2);
  }
  .body :global(.move [data-testid="project-picker"]) {
    align-items: flex-start;
  }
  .body :global(.move-actions) {
    display: flex;
    justify-content: flex-start;
    gap: var(--space-2);
  }
  .body :global(.move .meta) {
    margin: 0;
  }
  .body :global(.belongs) {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    color: var(--text-subtle);
  }
  .body :global(.belongs a) {
    color: var(--text-standard);
    text-decoration: underline;
    text-decoration-color: var(--border-standard);
    text-underline-offset: 2px;
  }
  .body :global(.note) {
    margin: 0;
    color: var(--text-subtle);
  }
  .body :global(.facts) {
    display: grid;
    grid-template-columns: minmax(96px, max-content) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0;
    font: var(--text-body-sm);
  }
  .body :global(.facts dt) {
    color: var(--text-subtle);
  }
  .body :global(.facts dd) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
    margin: 0;
    color: var(--text-standard);
  }
  .body :global(.path) {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    max-width: 100%;
  }
  .body :global(.path code) {
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .body :global(.more) {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-decoration: underline;
    cursor: pointer;
  }
  .body :global(.files),
  .body :global(.list) {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .body :global(.file) {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
  }
  .body :global(.file-head) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .body :global(.preview) {
    margin: 0;
    max-height: 160px;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-chip);
    background: var(--surface-panel);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-subtle);
  }
  .body :global(.list li) {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    font: var(--text-body-sm);
  }
  .body :global(.grow) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .body :global(.id) {
    flex: none;
    color: var(--text-subtle);
  }
  .body :global(.row-between) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .body :global(.row-between h3) {
    margin: 0;
  }
  .body :global(.chips) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .body :global(.comm) {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
</style>
