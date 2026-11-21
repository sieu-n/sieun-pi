<script lang="ts">
  import { api, type HostsReport } from "$lib/api";
  import { Button, EmptyState, IconButton, LoadingText, Page, PanelHeader, StatusDot, tooltip } from "$lib/ui";
  import HostDetail from "./HostDetail.svelte";
  import { gb, hostState, sparkPoints } from "./hosts";

  /** Hosts: one row per box in hosts.json with its state, CPU, memory and threads, and the picked box in full below, read every 2 s while open. */
  const POLL_MS = 2000;
  const HISTORY = 30;

  let view = $state<HostsReport | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let cpuHistory = $state<Record<string, number[]>>({});
  let picked = $state<string | null>(null);
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

  const selected = $derived(view ? (view.hosts.find(host => host.name === picked) ?? view.hosts.find(host => host.self) ?? view.hosts[0] ?? null) : null);
  const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const spark = (name: string): string => sparkPoints(cpuHistory[name] ?? [], HISTORY);

  function onKeydown(event: KeyboardEvent): void {
    if (!view || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const at = view.hosts.findIndex(host => host.name === selected?.name);
    const next = view.hosts[(at + (event.key === "ArrowDown" ? 1 : view.hosts.length - 1)) % view.hosts.length];
    if (!next) return;
    event.preventDefault();
    picked = next.name;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-host="${CSS.escape(next.name)}"]`)?.focus();
  }
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Hosts" icon="server" level={1}>
      {#snippet actions()}
        {#if view && error}<span class="stale" role="status" use:tooltip={error}>Last read {clock(view.checkedAt)}</span>{/if}
        <IconButton icon="refresh" label="Refresh hosts" size="sm" loading={loading && !view} onclick={() => void load()} />
      {/snippet}
    </PanelHeader>
  {/snippet}

  {#if !view && error}
    <EmptyState icon="server" title="Hosts didn't load" description={error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void load()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !view}
    <LoadingText text="Reading the hosts…" />
  {:else}
    <div class="hosts" data-testid="hosts-list">
      {#if view.registryError}<p class="note" role="status" use:tooltip={view.registryError}>The hosts list didn't read, so only this box shows.</p>{/if}
      <div class="table">
        <div class="row cols" aria-hidden="true"><span>Host</span><span>CPU</span><span>Memory</span><span class="right">Threads</span></div>
        <div role="tablist" aria-label="Hosts" aria-orientation="vertical" tabindex="-1" onkeydown={onKeydown}>
          {#each view.hosts as host (host.name)}
            {@const state = hostState(host)}
            {@const machine = host.machine}
            {@const real = host.threads.filter(thread => !thread.test)}
            {@const tests = host.threads.length - real.length}
            {@const working = real.filter(thread => thread.status === "working").length}
            {@const line = spark(host.name)}
            <button
              type="button"
              class="row host"
              role="tab"
              aria-selected={host.name === selected?.name}
              tabindex={host.name === selected?.name ? 0 : -1}
              data-host={host.name}
              data-testid="host-row-{host.name}"
              onclick={() => (picked = host.name)}
            >
              <span class="name"><StatusDot status={state.dot} /><span class="label">{host.name}</span>{#if host.self}<span class="tag">This box</span>{/if}</span>
              {#if machine}
                <span class="cpu" use:tooltip={`Load ${machine.cpu.load[0].toFixed(1)} on ${machine.cpu.cores} cores`}>
                  <span class="num">{Math.round(machine.cpu.percent)}%</span>
                  <svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><line class="base" x1="0" y1="31" x2="100" y2="31" vector-effect="non-scaling-stroke" />{#if line}<polyline points={line} vector-effect="non-scaling-stroke" />{/if}</svg>
                </span>
                <span class="mem">
                  <span class="num">{gb(machine.memory.usedBytes)} <span class="of">/ {gb(machine.memory.totalBytes)} GB</span></span>
                  <span class="bar" role="meter" aria-label="Memory" aria-valuenow={Math.round((100 * machine.memory.usedBytes) / machine.memory.totalBytes)} aria-valuemin={0} aria-valuemax={100}><span style:width="{(100 * machine.memory.usedBytes) / machine.memory.totalBytes}%"></span></span>
                </span>
              {:else}
                <span class="state" use:tooltip={state.tip}>{state.text ?? "No machine reading"}</span>
              {/if}
              <span class="count right">
                {#if host.piHost.state === "absent"}<span class="of">No pi-host</span>
                {:else if machine && state.text}<span class="problem" use:tooltip={state.tip}>{state.text}</span>
                {:else}<span class="num" use:tooltip={tests ? `Plus ${tests} test ${tests === 1 ? "thread" : "threads"}` : null}>{real.length}</span>{#if working}<span class="of working">· {working} working</span>{/if}{/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
      {#if selected}
        <div role="tabpanel" aria-label={selected.name}>
          {#key selected.name}<HostDetail host={selected} now={view.checkedAt} onrefresh={() => void load()} />{/key}
        </div>
      {/if}
    </div>
  {/if}
</Page>

<style>
  .hosts { display: flex; flex-direction: column; gap: var(--space-6); container-type: inline-size; }
  .note { margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .stale { color: var(--text-subtle); font: var(--text-caption); margin-right: var(--space-2); }
  .table { padding: var(--space-1); border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border-standard); }
  [role="tablist"] { display: flex; flex-direction: column; outline: none; }
  .row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); align-items: center; gap: var(--space-4); padding: 0 var(--space-3); }
  .cols { min-height: 28px; color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .host { min-height: 40px; border: 0; border-radius: 8px; background: transparent; color: var(--text-standard); text-align: left; cursor: pointer; }
  .host:hover { background: var(--affordance-ghost-hover); }
  .host[aria-selected="true"] { background: var(--interaction-selected); }
  .host:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .right { justify-self: end; text-align: right; }
  .name { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .label { overflow: hidden; font: var(--text-label-sm); text-overflow: ellipsis; white-space: nowrap; }
  .tag { flex: none; color: var(--text-metadata); font: var(--text-caption); }
  .num { font: var(--text-body-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .of { color: var(--text-subtle); font: var(--text-caption); white-space: nowrap; }
  .cpu { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .cpu .num { min-width: 3ch; }
  .spark { flex: 1; min-width: 0; max-width: 96px; height: 18px; }
  .spark .base { stroke: var(--border-standard); stroke-width: 1; }
  .working { margin-left: 4px; }
  .spark polyline { fill: none; stroke: var(--text-subtle); stroke-width: 1.25; stroke-linejoin: round; }
  .mem { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .bar { flex: 1; min-width: 32px; max-width: 120px; height: 4px; border-radius: var(--radius-pill); background: var(--affordance-subtle); overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: inherit; background: var(--text-standard); }
  .state { grid-column: span 2; color: var(--text-subtle); font: var(--text-body-sm); }
  .problem { color: var(--text-danger); font: var(--text-caption); }
  .count { white-space: nowrap; }
  @container (width < 600px) {
    .row { grid-template-columns: minmax(0, 1.3fr) 3.5rem minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--space-3); }
    .spark, .bar { display: none; }
  }
</style>
