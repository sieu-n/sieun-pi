<script lang="ts">
  import type { HostView } from "$lib/api";
  import { conversationHref } from "$lib/router.svelte";
  import { ageLabel, Avatar, Badge, CardGroup, Disclosure, Meter, NavItem, PageHeader, StatusDot } from "$lib/ui";
  import { gb, glance, hostStatus, piHostText, ramOf, relayText, RUN_LABEL, RUN_TONE, sparkPoints } from "./hosts";

  /** One box: its figures, its machine meters, its services and the threads its pi-host holds. */
  let { host, cpuHistory, historyLength, now }: { host: HostView; cpuHistory: readonly number[]; historyLength: number; now: number } = $props();

  const machine = $derived(host.machine);
  const memPercent = $derived(machine ? (100 * machine.memory.usedBytes) / machine.memory.totalBytes : null);
  const groupTotal = $derived(machine?.memory.groups?.reduce((sum, group) => sum + ramOf(group), 0) ?? 0);
  const working = $derived(host.threads.filter(thread => thread.status === "working").length);
  const line = $derived(sparkPoints(cpuHistory, historyLength));
  const area = $derived(line ? `${line.split(" ")[0]!.split(",")[0]},32 ${line} 100,32` : "");
  const STATE_LABEL: Record<string, string> = { online: "Answering", busy: "pi-host down", offline: "Not answering", away: "Away" };
  const STATE_TONE: Record<string, "accent" | "danger" | "neutral"> = { online: "accent", busy: "danger", offline: "neutral", away: "neutral" };
  const groups = $derived([...(machine?.memory.groups ?? [])].sort((a, b) => ramOf(b) - ramOf(a)));
  const PRESSURE: Record<string, string> = { normal: "Memory pressure is normal.", warn: "Memory pressure is high, so the box reclaims and swaps.", critical: "Memory pressure is critical, so apps may slow down or quit." };
</script>

<section class="host" data-testid="host-{host.name}" aria-label={host.name}>
  <PageHeader title={host.name} size="page" subtitle="{host.address} · {glance(host)}">
    {#snippet actions()}
      {#if host.self}<Badge value="This box" tone="outline" />{/if}
      <Badge value={STATE_LABEL[hostStatus(host)]} tone={STATE_TONE[hostStatus(host)]} />
    {/snippet}
  </PageHeader>
  {#if host.relay.state === "unreachable"}
    <p class="problem" role="status">The box did not answer at {host.address}: {host.relay.error}</p>
  {:else if host.piHost.state === "down"}
    <p class="problem" role="status">pi-host on this box does not answer, so its threads cannot run: {host.piHost.error}</p>
  {/if}

  {#if machine}
    <div class="stats">
      <div class="stat"><span class="caption">CPU</span><span class="figure">{Math.round(machine.cpu.percent)}%</span></div>
      <div class="stat"><span class="caption">Memory</span><span class="figure">{gb(machine.memory.usedBytes)} <small>of {gb(machine.memory.totalBytes)} GB</small></span></div>
      <div class="stat"><span class="caption">Threads</span><span class="figure">{host.piHost.state === "absent" ? "—" : host.threads.length}</span></div>
      <div class="stat"><span class="caption">Working</span><span class="figure">{host.piHost.state === "absent" ? "—" : working}</span></div>
    </div>

    <CardGroup title="Machine" description="Read every 2 seconds while this page is open.">
      <div class="metric">
        <div class="metric-head">
          <span class="metric-name">CPU</span>
          <span class="caption">Load {machine.cpu.load[0].toFixed(1)} over the last minute on {machine.cpu.cores} cores</span>
        </div>
        <svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="CPU use over the last minute">
          {#if line}<polygon points={area} class="fill" /><polyline points={line} class="stroke" vector-effect="non-scaling-stroke" />{/if}
        </svg>
      </div>
      <div class="metric">
        <Meter percent={memPercent} label="Memory" value="{gb(machine.memory.usedBytes)} of {gb(machine.memory.totalBytes)} GB" />
        <span class="caption">
          {#if machine.memory.pressure}{PRESSURE[machine.memory.pressure]}{/if}
          {#if machine.memory.swapUsedBytes !== null} Swap holds {gb(machine.memory.swapUsedBytes)}{machine.memory.swapTotalBytes ? ` of ${gb(machine.memory.swapTotalBytes)}` : ""} GB.{/if}
        </span>
      </div>
      {#each groups as group (group.id)}
        <div class="group">
          <Disclosure title={group.label} detail="{gb(ramOf(group))} GB">
            <ul class="holders">
              {#each group.top as item (item.label)}<li><span class="holder" title={item.label}>{item.label}</span><span class="caption">{gb(ramOf(item))} GB</span></li>
              {:else}<li class="caption">Nothing running</li>{/each}
              {#if group.swapBytes}<li class="caption">{gb(group.swapBytes)} GB more of it sits in swap.</li>{/if}
            </ul>
          </Disclosure>
          <Meter percent={groupTotal ? (100 * ramOf(group)) / groupTotal : 0} value="{groupTotal ? Math.round((100 * ramOf(group)) / groupTotal) : 0}%" warn={101} danger={101} compact />
        </div>
      {/each}
    </CardGroup>
  {/if}

  <CardGroup title="Services">
    <NavItem variant="card" label="pi-host" detail={piHostText(host)}>
      {#snippet leading()}<StatusDot status={host.piHost.state === "answering" ? "online" : host.piHost.state === "down" ? "busy" : "offline"} />{/snippet}
    </NavItem>
    <NavItem variant="card" label="Relay" detail={relayText(host)}>
      {#snippet leading()}<StatusDot status={host.relay.state === "up" ? "online" : "offline"} />{/snippet}
    </NavItem>
  </CardGroup>

  {#if host.piHost.state !== "absent"}
    <CardGroup title="Threads" description={host.threads.length ? `${host.threads.length} root ${host.threads.length === 1 ? "thread" : "threads"} on this pi-host, newest first.` : undefined}>
      {#each [...host.threads].sort((a, b) => b.updatedAt - a.updatedAt) as thread (thread.id)}
        <NavItem
          variant="card"
          label={thread.name}
          detail={[thread.model?.replace(/^[a-z0-9-]+\//i, ""), thread.children ? `${thread.children} ${thread.children === 1 ? "job" : "jobs"}` : null, `updated ${ageLabel(thread.updatedAt, now)}`].filter(Boolean).join(" · ")}
          href={conversationHref(thread.id)}
          data-testid="host-thread-{thread.id}"
        >
          {#snippet leading()}<Avatar name={thread.name} seed={thread.id} kind="agent" size={28} />{/snippet}
          {#snippet trailing()}<Badge value={RUN_LABEL[thread.status]} tone={RUN_TONE[thread.status]} />{/snippet}
        </NavItem>
      {:else}
        <p class="empty caption">No threads on this box yet.</p>
      {/each}
    </CardGroup>
  {/if}
</section>

<style>
  .host { display: flex; flex-direction: column; gap: var(--space-4); }
  .caption { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-4); border-radius: var(--radius-container); box-shadow: inset 0 0 0 1px var(--border-standard); }
  .stat { display: flex; flex-direction: column; gap: var(--space-1); }
  .stat .caption { font: var(--text-body); color: var(--text-subtle); }
  .figure { color: var(--text-standard); font: var(--text-heading); font-weight: 400; letter-spacing: var(--tracking-heading); font-variant-numeric: tabular-nums; }
  .figure small { color: var(--text-subtle); font: var(--text-body); }
  .metric { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); }
  .metric-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); }
  .metric-name { font: var(--text-caption); color: var(--text-subtle); }
  .spark { width: 100%; height: 32px; overflow: visible; }
  .spark .stroke { fill: none; stroke: var(--text-standard); stroke-width: 1.5; stroke-linejoin: round; }
  .spark .fill { fill: var(--text-standard); opacity: 0.08; }
  .group { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 14rem); align-items: start; gap: var(--space-4); padding: var(--space-2) var(--space-4); }
  .group > :global(:last-child) { padding-top: 10px; }
  .holders { display: flex; flex-direction: column; gap: var(--space-1); margin: 0; padding: 0 0 var(--space-2) var(--space-6); list-style: none; }
  .holders li { display: flex; justify-content: space-between; gap: var(--space-4); font: var(--text-body); }
  .holder { overflow: hidden; color: var(--text-subtle); text-overflow: ellipsis; white-space: nowrap; }
  .problem { margin: 0; color: var(--text-danger); font: var(--text-body); }
  .empty { margin: 0; padding: var(--space-4); }
</style>
