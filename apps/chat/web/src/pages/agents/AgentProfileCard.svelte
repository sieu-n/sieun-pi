<script lang="ts">
  import { agents, me, reads, view } from "$lib/api";
  import { hrefFor, router } from "$lib/router.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import { ageLabel } from "$lib/ui/datetime";
  import type { Anchor } from "$lib/ui/floating";
  import type { Status } from "$lib/ui/types";
  import HostBadge from "./HostBadge.svelte";
  import { STATUS_LABEL, jobFilterCounts } from "./agents-model";

  type Props = {
    agent: string;
    /** The name the post or header showed, for an agent the live list has not loaded. */
    name: string;
    anchor: Anchor;
    onclose: () => void;
  };
  let { agent: agentId, name, anchor, onclose }: Props = $props();

  let open = $state(true);
  /** The agent's config, the one its page reads: it names a test agent the live list leaves out, and the jobs its Jobs tab lists. */
  const config = view(() => reads.agentConfig(agentId));
  const agent = $derived(agents.byId(agentId) ?? config.value?.agent ?? null);
  const shownName = $derived(agent?.name ?? name);
  const dot = $derived<Status | null>(agent?.status === "working" ? "online" : agent?.status === "sleeping" ? "away" : agent?.status === "failed" ? "busy" : null);
  const statusText = $derived(!agent ? "" : agent.archived ? "Archived" : agent.status === "idle" ? `Idle · ${ageLabel(agent.updatedAt)}` : STATUS_LABEL[agent.status]);
  /** The counts its Jobs tab shows on its Active and Finished filters, which the line links to. */
  const jobCount = $derived(config.value ? jobFilterCounts(config.value.swarm.jobs, "") : null);
  const jobsText = $derived(
    !jobCount ? "…" : [jobCount.active && `${jobCount.active} active`, jobCount.finished && `${jobCount.finished} finished`].filter(Boolean).join(", ") || "No jobs yet",
  );
  const model = $derived(agent?.model ? `${agent.model.label}${agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ""}` : null);

  function go(href: string) {
    onclose();
    router.navigate(href);
  }
</script>

<Popover bind:open {anchor} placement="bottom-start" surface="solid" width={300} padding={0} label="{shownName}, agent profile" {onclose}>
  <div class="card" data-testid="profile-card" data-agent={agentId}>
    <div class="top">
      <Avatar name={shownName} kind="agent" seed={agentId} size={64} status={dot} />
      <div class="who">
        <h2 class="name t-label" data-testid="profile-name">{shownName}</h2>
        {#if agent}
          <p class="status t-caption">
            <span data-testid="profile-status">{statusText}</span>
            <HostBadge {agent} self={me.value?.host} />
          </p>
        {/if}
      </div>
    </div>
    {#if agent}
      <dl class="facts t-body-sm">
        {#if model}<dt>Model</dt><dd>{model}</dd>{/if}
        <dt>Jobs</dt>
        <dd><a href={hrefFor("agents", [agentId], { section: "threads" })} onclick={(e) => (e.preventDefault(), go(hrefFor("agents", [agentId], { section: "threads" })))} data-testid="profile-jobs">{jobsText}</a></dd>
      </dl>
    {/if}
    <div class="actions">
      <Button variant="primary" size="sm" icon="chat" onclick={() => go(hrefFor("messages", [agents.room(agentId)]))} data-testid="profile-message">Message</Button>
      <Button variant="outline" size="sm" icon="robot" onclick={() => go(hrefFor("agents", [agentId]))} data-testid="profile-view">Open agent</Button>
    </div>
  </div>
</Popover>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .name {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--text-subtle);
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  .facts dt {
    color: var(--text-subtle);
  }
  .facts dd {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facts a {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--border-standard);
    text-underline-offset: 2px;
  }
  .facts a:hover {
    text-decoration-color: currentColor;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions :global(> *) {
    flex: 1;
  }
</style>
