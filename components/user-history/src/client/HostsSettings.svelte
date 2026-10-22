<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import AgentQueueSettings from "./AgentQueueSettings.svelte";
  import MachineMeters from "./MachineMeters.svelte";
  import { hostGlance, hostRoles, hostSessions } from "./hosts.ts";
  import type { HostsView } from "../shared/types.ts";

  const POLL_MS = 2000;
  const HISTORY = 30;

  let view = $state<HostsView | null>(null);
  let error = $state<string | null>(null);
  let cpuHistory = $state<Record<string, number[]>>({});
  /** Which cards the owner opened; every card starts closed on its one-line state, so five boxes fit on one screen. */
  let open = $state<Record<string, boolean>>({});
  /** When the shown reading was asked for. A poll can answer after a later one (api/hosts took up to 2 s on 10-22), and its older reading is dropped. */
  let readAt = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load(): Promise<void> {
    const asked = Date.now();
    try {
      const next = await api.hosts();
      if (asked < readAt) return;
      readAt = asked;
      view = next;
      const history: Record<string, number[]> = {};
      for (const host of next.hosts) if (host.state === "up") history[host.name] = [...cpuHistory[host.name] ?? [], host.machine.cpu.percent].slice(-HISTORY);
      cpuHistory = history;
      error = null;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  onMount(() => { void load(); timer = setInterval(() => { void load(); }, POLL_MS); });
  onDestroy(() => clearInterval(timer));
</script>

<section class="pane" aria-label="Hosts">
  {#if !view}
    <p class="note">{error ? `The hosts are unavailable. ${error}` : "Reading the hosts"}</p>
  {:else}
    {#if view.registryError}<p class="note problem">The hosts list did not read, so only this box shows. {view.registryError}</p>{/if}
    {#each view.hosts as host (host.name)}
      <details class="host" open={open[host.name] ?? false} ontoggle={event => { open[host.name] = event.currentTarget.open; }}>
        <summary>
          <span class="dot {host.state === 'up' ? host.daemon : 'away'}" aria-hidden="true"></span>
          <span class="host-name">{host.name}</span>
          {#if host.self}<span class="badge">This box</span>{/if}
          <span class="glance" title={hostSessions(host)}>{hostGlance(host)}</span>
        </summary>
        <div class="body">
          <p class="note">{hostRoles(host)}</p>
          {#if host.state === "up"}
            {#if host.daemon === "down"}<p class="note problem">The Prime daemon on this box does not answer, so its chats cannot run.</p>{/if}
            <MachineMeters machine={host.machine} cpuHistory={cpuHistory[host.name] ?? []} historyLength={HISTORY} />
            {#if host.self}
              <AgentQueueSettings />
            {:else}
              <AgentQueueSettings remote={{ name: host.name, pool: host.queue, readAt }} />
            {/if}
          {:else}
            <p class="note problem">The box did not answer at {host.address}. {host.error}</p>
          {/if}
        </div>
      </details>
    {/each}
    {#if error}<p class="note problem">The last reading failed. {error}</p>{/if}
  {/if}
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px 18px; font-size: 13px; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .note.problem { color: var(--danger); }
  .host { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .host summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; list-style: none; }
  .host summary::-webkit-details-marker { display: none; }
  .host summary:hover { background: var(--bg-hover); border-radius: var(--radius); }
  .host[open] summary { border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--success); }
  .dot.down { background: var(--warning); }
  .dot.away { background: var(--text-faint); }
  .host-name { font-weight: 600; }
  .badge { padding: 1px 6px; border-radius: 999px; background: var(--bg-hover); color: var(--text-muted); font-size: 11.5px; }
  .glance { margin-left: auto; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .body { display: flex; flex-direction: column; gap: 18px; padding: 12px 14px 14px; }
</style>
