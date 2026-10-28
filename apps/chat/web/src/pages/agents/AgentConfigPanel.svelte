<script lang="ts">
  import { api, type AgentConfig, type AgentSummary, type ConfigFile, type ModelCatalog, type RunStatus, type ThinkingLevel } from "$lib/api";
  import { Avatar, Badge, Button, Chip, EmptyState, IconButton, LoadingText, Meter, ModelPicker, StatusDot, Tabs, TypingDots, stampLabel, toast } from "$lib/ui";
  import { conversationHref, hrefFor } from "$lib/router.svelte";
  import {
    JOB_KIND_LABEL, SECTIONS, STATUS_LABEL, bytesLabel, canArchive, everyLabel, levelsFor, modelKey, modelOptions, shortPath, type ConfigSection,
  } from "./agents-model";

  type Props = {
    agentId: string;
    /** The live card, so status and model update without a refetch. */
    agent: AgentSummary | null;
    catalog: ModelCatalog | null;
    section: ConfigSection;
    onsection: (section: ConfigSection) => void;
    onmessage: (agent: AgentSummary) => void;
    onmodel: (agent: AgentSummary, model: string, level: ThinkingLevel | undefined) => void;
    onstop: (agent: AgentSummary) => void;
    onarchive: (agent: AgentSummary) => void;
  };
  let { agentId, agent: liveAgent, catalog, section, onsection, onmessage, onmodel, onstop, onarchive }: Props = $props();

  let config = $state<AgentConfig | null>(null);
  let error = $state("");
  let pickerOpen = $state(false);

  async function load(id: string) {
    error = "";
    try {
      const next = await api.agentConfig(id);
      if (id === agentId) config = next;
    } catch (reason) {
      if (id === agentId) error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  $effect(() => {
    const id = agentId;
    config = null;
    void load(id);
  });
  // A new status or model on the live card reads the config again, so jobs, board and usage follow the run.
  let seen = "";
  $effect(() => {
    const key = liveAgent ? `${liveAgent.status}|${liveAgent.model?.id ?? ""}|${liveAgent.thinkingLevel ?? ""}` : "";
    if (seen && key && key !== seen) void load(agentId);
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
  const tabs = SECTIONS.map((item) => ({ ...item }));
  const hostLine = $derived(
    config ? (config.runs.hostVersion && config.runs.hostVersion !== config.runs.hostKind ? `${config.runs.hostKind} ${config.runs.hostVersion}` : config.runs.hostKind) : "",
  );
  const dotOf = (status: RunStatus) => (status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : "offline");

  function copy(path: string) {
    navigator.clipboard?.writeText(path).then(
      () => toast.success("Copied path"),
      () => toast.error("Copy failed"),
    );
  }
  const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
</script>

{#snippet path(value: string, label: string)}
  <span class="path">
    <code class="t-mono" title={value}>{shortPath(value)}</code>
    <IconButton icon="copy" label="Copy {label}" size="xs" onclick={() => copy(value)} />
  </span>
{/snippet}

{#snippet file(item: ConfigFile)}
  <li class="file" data-path={item.path}>
    <div class="file-head">
      <span class="t-label-sm">{item.label}</span>
      {#if item.loaded === false}<Chip size="sm" label="Not loaded" />{:else if item.loaded}<Chip size="sm" label="Loaded" selected />{/if}
      {#if !item.exists}<Chip size="sm" label="Missing" />{/if}
    </div>
    {@render path(item.path, item.label)}
    <span class="t-caption meta">
      {[item.count !== undefined ? plural(item.count, "entry", "entries") : "", bytesLabel(item.size), item.modifiedAt ? `changed ${stampLabel(item.modifiedAt)}` : ""].filter(Boolean).join(" · ")}
    </span>
    {#if item.preview}<pre class="preview t-mono">{item.preview}</pre>{/if}
    {#if item.note}<p class="t-caption note">{item.note}</p>{/if}
  </li>
{/snippet}

<div class="config" data-testid="agent-config" data-agent-id={agentId}>
  {#if agent}
    <section class="identity">
      <Avatar name={agent.name} kind="agent" seed={agent.name} size={48} status={dotOf(agent.status)} />
      <div class="who">
        <h2 class="t-label name">{agent.name}</h2>
        <span class="t-caption line" data-status={agent.status}>
          {#if running}<TypingDots mode={agent.status === "working" ? "working" : "waiting"} size={4} />{/if}
          <span>{STATUS_LABEL[agent.status]}</span>
          <span>·</span>
          <span>{config?.identity.duty ? "duty run" : agent.kind === "chat" ? "agent" : "job"}</span>
          {#if agent.parent}<span>· in</span><a href={hrefFor("agents", [agent.parent.id])}>{agent.parent.name}</a>{/if}
        </span>
        <span class="model">
          {#if agent.model}
            <ModelPicker bind:open={pickerOpen} models={options} value={current} efforts={levelsFor(catalog, current)} effort={agent.thinkingLevel ?? undefined}
              onchange={(next) => onmodel(agent, next.model, next.effort as ThinkingLevel | undefined)} />
          {:else}
            <span class="t-caption">No model yet</span>
          {/if}
        </span>
      </div>
    </section>
    <div class="actions" role="toolbar" aria-label="Agent actions">
      <Button size="sm" variant="primary" icon="chat" onclick={() => onmessage(agent)}>Message</Button>
      {#if boardHref}<Button size="sm" icon="board" href={boardHref}>Open board</Button>{/if}
      <Button size="sm" icon="cpu" onclick={() => (pickerOpen = true)} disabled={!agent.model}>Change model</Button>
      {#if running}<Button size="sm" icon="stop" onclick={() => onstop(agent)}>Stop</Button>{/if}
      {#if canArchive(agent) && !agent.archived}<Button size="sm" variant="ghost" icon="trash" onclick={() => onarchive(agent)}>Archive</Button>{/if}
    </div>
  {/if}

  <div class="tabs">
    <Tabs items={tabs} value={section} variant="underline" size="sm" label="Configuration sections" onchange={onsection} />
  </div>

  <div class="body" role="tabpanel" aria-label={SECTIONS.find((s) => s.id === section)?.label}>
    {#if error && !config}
      <EmptyState icon="warning" title="The configuration could not load" description={error} size="sm">
        {#snippet action()}<Button size="sm" icon="refresh" onclick={() => load(agentId)}>Retry</Button>{/snippet}
      </EmptyState>
    {:else if !config}
      <div class="loading"><LoadingText text="Reading its configuration…" /></div>
    {:else if section === "overview"}
      <section class="block" aria-label="Purpose">
        <h3 class="t-caption heading">Responsibility</h3>
        {#if config.identity.purpose}
          <p class="purpose t-body-sm">{config.identity.purpose.text}</p>
          <span class="t-caption meta">
            First input from {config.identity.purpose.from.name}{config.identity.purpose.via ? ` via ${config.identity.purpose.via}` : ""}, {stampLabel(config.identity.purpose.at)}
          </span>
        {:else}
          <p class="t-caption meta">No first input yet.</p>
        {/if}
      </section>
      <dl class="facts">
        <dt>Host</dt>
        <dd data-fact="host">{config.runs.host} <span class="t-caption meta">{hostLine}</span></dd>
        <dt>Home directory</dt>
        <dd data-fact="cwd">{@render path(config.runs.cwd, "working directory")}{#if !config.runs.cwdExists}<span class="t-caption warn">Not on this box</span>{/if}</dd>
        <dt>Board</dt>
        <dd data-fact="board">
          {#if config.board}
            <a href={boardHref}>{config.board.own ? "Its board" : `Board of ${config.board.chatName}`}</a>
            <span class="t-caption meta">{config.board.steps.open} open · {config.board.steps.done} done · {plural(config.board.openTodos.length, "ask")} for you</span>
          {:else}
            <span class="meta">No board</span>
          {/if}
        </dd>
        <dt>Memory</dt>
        <dd data-fact="memory">
          {#if config.memory.kind === "none"}<span>None of its own</span>{:else}<span>{plural(config.memory.files.length, "file")}</span>{/if}
          <button type="button" class="more t-caption" onclick={() => onsection("memory")}>Details</button>
        </dd>
        <dt>Swarm</dt>
        <dd data-fact="swarm">
          {plural(config.swarm.jobs.length, "job")}{config.swarm.jobs.some((j) => j.status === "working") ? `, ${config.swarm.jobs.filter((j) => j.status === "working").length} working` : ""}
          · {plural(config.swarm.channels.length, "channel")} · {plural(config.swarm.duties.length, "duty", "duties")}
        </dd>
        {#if config.usage}
          <dt>Last 7 days</dt>
          <dd data-fact="usage">{money(config.usage.cost)} · {plural(config.usage.turns, "turn")}</dd>
        {/if}
      </dl>
    {:else if section === "runs"}
      <h3 class="t-caption heading">Where it runs</h3>
      <dl class="facts">
        <dt>Host</dt>
        <dd>{config.runs.host}</dd>
        <dt>Through</dt>
        <dd>{hostLine}{config.runs.hostVersion ? "" : " (not answering)"}</dd>
        <dt>pi-host socket</dt>
        <dd>{@render path(config.runs.socket, "pi-host socket")}</dd>
        <dt>Home directory</dt>
        <dd>{@render path(config.runs.cwd, "working directory")}{#if !config.runs.cwdExists}<span class="t-caption warn">Not on this box: its tools fail there until the thread moves</span>{/if}</dd>
        <dt>Thread</dt>
        <dd>{@render path(config.runs.thread, "thread id")}</dd>
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
        {#if config.runs.threadFile}{@render file(config.runs.threadFile)}{:else}<li class="t-caption meta">The fixture host keeps its threads in memory, with no thread file.</li>{/if}
        {@render file({ label: "Chat server data", path: config.runs.dataDir, exists: true, size: null, modifiedAt: null, note: "Thread kinds, DMs, read marks, channels, duties and check-ins." })}
      </ul>
      <section class="block" aria-label="System text">
        <h3 class="t-caption heading">System text its model runs with</h3>
        {#if config.identity.system.text}<pre class="preview t-mono">{config.identity.system.text}</pre>{/if}
        <span class="t-caption meta">{config.identity.system.source}</span>
      </section>
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
        <EmptyState icon="board" title="No board yet" description="Its chat has not written a chat.board document." size="sm" />
      {/if}
    {:else if section === "memory"}
      {#if config.memory.kind === "none"}
        <section class="block callout" data-memory="none">
          <h3 class="t-label-sm">No memory of its own</h3>
          <p class="t-body-sm">{config.memory.note}</p>
        </section>
        {#if config.memory.related.length}
          <h3 class="t-caption heading">Stores near it</h3>
          <ul class="files">{#each config.memory.related as item (item.path)}{@render file(item)}{/each}</ul>
        {/if}
      {:else}
        {#if config.memory.note}<p class="t-body-sm">{config.memory.note}</p>{/if}
        <ul class="files">{#each config.memory.files as item (item.path)}{@render file(item)}{/each}</ul>
      {/if}
    {:else if section === "instructions"}
      <section class="block callout"><p class="t-body-sm">{config.instructions.note}</p></section>
      {#if config.identity.system.text}
        <section class="block" aria-label="System text">
          <h3 class="t-caption heading">System text</h3>
          <pre class="preview t-mono">{config.identity.system.text}</pre>
          <span class="t-caption meta">{config.identity.system.source}</span>
        </section>
      {/if}
      <h3 class="t-caption heading">Files that apply to its home directory</h3>
      <ul class="files">
        {#each config.instructions.files as item (item.path)}{@render file(item)}{:else}<li class="t-caption meta">No AGENTS.md or CLAUDE.md in its home directory or above it.</li>{/each}
      </ul>
    {:else if section === "swarm"}
      {#if config.swarm.parent}
        <section class="block">
          <h3 class="t-caption heading">Coordinator</h3>
          <a href={hrefFor("agents", [config.swarm.parent.id])}>{config.swarm.parent.name}</a>
        </section>
      {/if}
      <section class="block" aria-label="Jobs">
        <h3 class="t-caption heading">Jobs and sub-agents</h3>
        <ul class="list">
          {#each config.swarm.jobs as job (job.id)}
            <li data-job-id={job.id} style:padding-left="{Math.max(0, job.depth - 1) * 12}px">
              <StatusDot status={dotOf(job.status)} label={STATUS_LABEL[job.status]} />
              <a class="grow" href={hrefFor("agents", [job.id])}>{job.name}</a>
              <Chip size="sm" label={JOB_KIND_LABEL[job.kind]} />
              <span class="t-caption meta">{job.createdAt ? stampLabel(job.createdAt) : ""}</span>
            </li>
          {:else}
            <li class="t-caption meta">No jobs yet.</li>
          {/each}
        </ul>
      </section>
      <section class="block" aria-label="Channels">
        <h3 class="t-caption heading">Channels</h3>
        <div class="chips">
          {#each config.swarm.channels as channel (channel.id)}
            <a class="channel" href={conversationHref(channel.id)}><Chip size="sm" icon="hash" label={channel.name} /></a>
          {:else}
            <span class="t-caption meta">In no channel.</span>
          {/each}
        </div>
      </section>
      <section class="block" aria-label="Duties">
        <h3 class="t-caption heading">Duties</h3>
        <ul class="list">
          {#each config.swarm.duties as duty (duty.id)}
            <li data-duty-id={duty.id}>
              <span class="t-mono id">{duty.id}</span>
              <span class="grow"><span>{duty.name}</span><span class="t-caption meta block-line">{duty.schedule}{duty.paused ? " · paused" : duty.nextAt ? ` · next ${stampLabel(duty.nextAt)}` : ""} · {plural(duty.runs, "run")}</span></span>
              {#if duty.lastVerdict}<Badge value={duty.lastVerdict} tone={duty.lastVerdict === "met" ? "neutral" : "danger"} />{/if}
            </li>
          {:else}
            <li class="t-caption meta">{agent?.kind === "chat" ? "No duties." : "Duties belong to its chat."}</li>
          {/each}
        </ul>
        {#if config.swarm.checkIn}
          <span class="t-caption meta">Check-in {everyLabel(config.swarm.checkIn.everyMs)}{config.swarm.checkIn.paused ? ", paused" : config.swarm.checkIn.nextAt ? `, next ${stampLabel(config.swarm.checkIn.nextAt)}` : ""}</span>
        {/if}
        {#if config.swarm.dutiesFile}<ul class="files">{@render file(config.swarm.dutiesFile)}</ul>{/if}
      </section>
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
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4) 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .name {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-subtle);
  }
  .line[data-status="failed"] {
    color: var(--text-danger);
  }
  .line a,
  .facts a,
  .block a {
    color: var(--text-standard);
    text-decoration: underline;
    text-decoration-color: var(--border-standard);
    text-underline-offset: 2px;
  }
  .model {
    display: flex;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
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
    padding: var(--space-4);
  }
  .loading {
    padding: var(--space-4) 0;
    color: var(--text-metadata);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }
  .callout {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
  }
  .callout p,
  .callout h3 {
    margin: 0;
  }
  .heading {
    margin: 0;
    color: var(--text-metadata);
  }
  .purpose {
    margin: 0;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .meta {
    color: var(--text-metadata);
  }
  .warn {
    color: var(--text-danger);
  }
  .note {
    margin: 0;
    color: var(--text-subtle);
  }
  .facts {
    display: grid;
    grid-template-columns: minmax(96px, max-content) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0;
    font: var(--text-body-sm);
  }
  .facts dt {
    color: var(--text-subtle);
  }
  .facts dd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
    margin: 0;
    color: var(--text-standard);
  }
  .path {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    max-width: 100%;
  }
  .path code {
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .more {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-decoration: underline;
    cursor: pointer;
  }
  .files,
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
  }
  .file-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .preview {
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
  .list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    font: var(--text-body-sm);
  }
  .grow {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .block-line {
    display: block;
  }
  .id {
    flex: none;
    color: var(--text-subtle);
  }
  .row-between {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row-between h3 {
    margin: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .channel {
    text-decoration: none;
  }
</style>
