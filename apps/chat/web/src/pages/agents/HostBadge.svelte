<script lang="ts">
  import type { AgentHostState } from "$lib/api";
  import { hostBadge } from "./host-badge";

  type Props = {
    /** The agent's box and, while the chat server has no live link to it, `hostState` "away". */
    agent: { host: string; hostState?: AgentHostState };
    /** The chat's own box (`me.host`); an agent on it shows no badge. */
    self: string | null | undefined;
  };
  let { agent, self }: Props = $props();

  const view = $derived(hostBadge(agent, self));
</script>

{#if view}
  <span class="host-badge" class:away={view.away} title={view.title} data-testid="host-badge" data-host={agent.host} data-away={view.away || undefined}>
    {view.away ? `${view.label} · away` : view.label}
  </span>
{/if}

<style>
  .host-badge {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 18px;
    padding: 0 6px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-pill);
    font: 500 11px/1 var(--font-sans);
    letter-spacing: 0.01em;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .away {
    opacity: 0.55;
    border-style: dashed;
  }
</style>
