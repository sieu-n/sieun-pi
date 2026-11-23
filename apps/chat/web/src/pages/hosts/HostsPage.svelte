<script lang="ts">
  import { reads, view, type HostsReport, type HostThreadFilter } from "$lib/api";
  import { Button, EmptyState, IconButton, LoadingText, Page, PanelHeader, StatusDot, tooltip } from "$lib/ui";
  import HostDetail from "./HostDetail.svelte";
  import { gb, hostState, sparkPoints, totalOf } from "./hosts";

  /**
   * Hosts: one row per box in hosts.json with its state, CPU, memory and thread counts, and the picked box in full below, read every 2 s
   * while open. The report is kept (kept.svelte.ts), so the page draws the last one at once, also after a reload, and says how old it is.
   */
  const POLL_MS = 2000;
  const HISTORY = 30;
  /** A shown report older than this many polls says when it was read, as a kept one from an earlier visit or a poll that keeps failing. */
  const STALE_POLLS = 3;

  let picked = $state<string | null>(null);
  let filter = $state<HostThreadFilter>("working");
  let showTests = $state(false);
  /** The chat server's own box, which the read leaves out since the server lists its threads by default. */
  let selfName = $state<string | null>(null);
  const hosts = view(() => reads.hosts({ box: picked && picked !== selfName ? picked : undefined, threads: filter, tests: showTests }));
  /** The report shown while the read of a new pick has no answer yet: its figures and counts stay, and its thread list waits. */
  let last = $state.raw<HostsReport | null>(null);
  $effect(() => {
    if (hosts.value) last = hosts.value;
  });
  const shown = $derived(hosts.value ?? last);
  let cpuHistory = $state<Record<string, number[]>>({});
  let historyAt = 0;
  let now = $state(Date.now());

  $effect(() => {
    const next = hosts.value;
    if (!next) return;
    selfName = next.hosts.find(host => host.self)?.name ?? null;
    if (next.checkedAt <= historyAt) return;
    historyAt = next.checkedAt;
    const history: Record<string, number[]> = {};
    for (const host of next.hosts) if (host.machine) history[host.name] = [...(cpuHistory[host.name] ?? []), host.machine.cpu.percent].slice(-HISTORY);
    cpuHistory = history;
  });
  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
      void hosts.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  function pick(name: string): void {
    if (name === selected?.name) return;
    picked = name;
    filter = "working";
    showTests = false;
  }

  const selected = $derived(shown ? (shown.hosts.find(host => host.name === picked) ?? shown.hosts.find(host => host.self) ?? shown.hosts[0] ?? null) : null);
  const stale = $derived(shown !== null && now - shown.checkedAt > STALE_POLLS * POLL_MS);
  const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const spark = (name: string): string => sparkPoints(cpuHistory[name] ?? [], HISTORY);

  function onKeydown(event: KeyboardEvent): void {
    if (!shown || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const at = shown.hosts.findIndex(host => host.name === selected?.name);
    const next = shown.hosts[(at + (event.key === "ArrowDown" ? 1 : shown.hosts.length - 1)) % shown.hosts.length];
    if (!next) return;
    event.preventDefault();
    pick(next.name);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-host="${CSS.escape(next.name)}"]`)?.focus();
  }
</script>

<Page measure="wide">
  {#snippet header()}
    <PanelHeader title="Hosts" icon="server" level={1}>
      {#snippet actions()}
        {#if shown && stale}<span class="stale" role="status">Last read {clock(shown.checkedAt)}</span>{/if}
        <IconButton icon="refresh" label="Refresh hosts" size="sm" loading={hosts.loading} onclick={() => void hosts.refresh()} />
      {/snippet}
    </PanelHeader>
  {/snippet}

  {#if !shown && hosts.error}
    <EmptyState icon="server" title="Hosts didn't load" description={hosts.error}>
      {#snippet action()}<Button variant="outline" size="sm" onclick={() => void hosts.refresh()}>Try again</Button>{/snippet}
    </EmptyState>
  {:else if !shown}
    <LoadingText text="Reading the hosts…" />
  {:else}
    <div class="hosts" data-testid="hosts-list">
      {#if shown.registryError}<p class="note" role="status" use:tooltip={shown.registryError}>The hosts list didn't read, so only this box shows.</p>{/if}
      <div class="table">
        <div class="row cols" aria-hidden="true"><span>Host</span><span>CPU</span><span>Memory</span><span class="right">Threads</span></div>
        <div role="tablist" aria-label="Hosts" aria-orientation="vertical" tabindex="-1" onkeydown={onKeydown}>
          {#each shown.hosts as host (host.name)}
            {@const state = hostState(host)}
            {@const machine = host.machine}
            {@const real = totalOf(host.counts.real)}
            {@const tests = totalOf(host.counts.test)}
            {@const working = host.counts.real.working}
            {@const line = spark(host.name)}
            <button
              type="button"
              class="row host"
              role="tab"
              aria-selected={host.name === selected?.name}
              tabindex={host.name === selected?.name ? 0 : -1}
              data-host={host.name}
              data-testid="host-row-{host.name}"
              onclick={() => pick(host.name)}
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
                {:else}<span class="num" use:tooltip={tests ? `Plus ${tests} test ${tests === 1 ? "thread" : "threads"}` : null}>{real}</span>{#if working}<span class="of working">· {working} working</span>{/if}{/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
      {#if selected}
        <div role="tabpanel" aria-label={selected.name}>
          {#key selected.name}<HostDetail host={selected} now={shown.checkedAt} onrefresh={() => void hosts.refresh()} bind:filter bind:showTests listing={hosts.value !== null} />{/key}
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
