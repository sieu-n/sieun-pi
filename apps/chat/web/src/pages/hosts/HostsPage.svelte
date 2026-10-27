<script lang="ts">
  import { api, type HostsReport } from "$lib/api";
  import { Button, EmptyState, IconButton, LoadingText, Page, PanelHeader } from "$lib/ui";
  import HostCard from "./HostCard.svelte";

  /** Hosts: every box in hosts.json with its machine, its pi-host and relay, and the threads on it, read every 2 s while open. */
  const POLL_MS = 2000;
  const HISTORY = 30;

  let view = $state<HostsReport | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let cpuHistory = $state<Record<string, number[]>>({});
  /** When the shown reading was asked for: a slow poll that answers after a later one is dropped. */
  let readAt = 0;

  async function load(): Promise<void> {
    const asked = Date.now();
    loading = true;
    try {
      const next = await api.hosts();
      if (asked < readAt) return;
      readAt = asked;
      view = next;
      const history: Record<string, number[]> = {};
      for (const host of next.hosts) if (host.machine) history[host.name] = [...(cpuHistory[host.name] ?? []), host.machine.cpu.percent].slice(-HISTORY);
      cpuHistory = history;
      error = null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  });

  const answering = $derived(view?.hosts.filter(host => host.relay.state === "up").length ?? 0);
  const threads = $derived(view?.hosts.reduce((sum, host) => sum + host.threads.length, 0) ?? 0);
  const working = $derived(view?.hosts.reduce((sum, host) => sum + host.threads.filter(thread => thread.status === "working").length, 0) ?? 0);
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Hosts" icon="server" level={1}>
      {#snippet actions()}<IconButton icon="refresh" label="Refresh hosts" size="sm" loading={loading && !view} onclick={() => void load()} />{/snippet}
    </PanelHeader>
  {/snippet}

  {#if !view && error}
    <EmptyState icon="server" title="Hosts aren't available" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void load()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !view}
    <LoadingText text="Reading the hosts…" />
  {:else}
    <p class="summary" data-testid="hosts-summary">
      <b>{view.hosts.length} {view.hosts.length === 1 ? "host" : "hosts"}</b>, {answering === view.hosts.length ? (view.hosts.length === 1 ? "answering" : "all answering") : `${answering} answering`}.
      <b>{threads} {threads === 1 ? "thread" : "threads"}</b> on pi-host, <b>{working} working</b> now.
    </p>
    {#if view.registryError}<p class="notice" role="status">The hosts list did not read, so only this box shows: {view.registryError}</p>{/if}
    {#if error}<p class="notice" role="status">The last reading failed: {error}</p>{/if}
    {#each view.hosts as host (host.name)}
      <HostCard {host} cpuHistory={cpuHistory[host.name] ?? []} historyLength={HISTORY} now={view.checkedAt} />
    {/each}
  {/if}
</Page>

<style>
  .summary { max-width: 44rem; margin: 0; color: var(--text-subtle); font: var(--text-body-lg); letter-spacing: var(--tracking-body-lg); }
  .summary b { color: var(--text-standard); font-weight: 500; }
  .notice { margin: 0; color: var(--text-danger); font: var(--text-body); }
</style>
