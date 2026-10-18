<script lang="ts">
  import type { MachineView, MemoryPressure } from "../shared/types.ts";

  /** One box's CPU line with its last minute, its memory bar and its memory groups; the Hosts card draws one per box. */
  let { machine, cpuHistory, historyLength }: { machine: MachineView; cpuHistory: number[]; historyLength: number } = $props();

  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const memPercent = $derived((100 * machine.memory.usedBytes) / machine.memory.totalBytes);
  const groupTotal = $derived(machine.memory.groups?.reduce((sum, group) => sum + group.bytes, 0) ?? 0);
  const PRESSURE_TEXT: Record<MemoryPressure, string> = {
    normal: "Memory pressure is normal.",
    warn: "Memory pressure is high, so the box is reclaiming and swapping.",
    critical: "Memory pressure is critical, so apps may slow down or quit.",
  };
  const line = $derived.by(() => {
    if (cpuHistory.length < 2) return "";
    const step = 100 / (historyLength - 1);
    const start = 100 - step * (cpuHistory.length - 1);
    return cpuHistory.map((value, index) => `${(start + step * index).toFixed(2)},${(36 - (value / 100) * 34).toFixed(2)}`).join(" ");
  });
  const area = $derived(line ? `${line.split(" ")[0]!.split(",")[0]},36 ${line} 100,36` : "");
</script>

<div class="metric">
  <span class="name">CPU</span>
  <div class="reading">
    <span class="value">{Math.round(machine.cpu.percent)}<small>%</small></span>
    <span class="note">Load {machine.cpu.load[0].toFixed(1)} over the last minute on {machine.cpu.cores} cores.</span>
  </div>
  <svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" aria-label="CPU use over the last minute">
    <line x1="0" x2="100" y1="19" y2="19" class="mid" />
    {#if line}
      <polygon points={area} class="fill" />
      <polyline points={line} class="stroke" vector-effect="non-scaling-stroke" />
    {/if}
  </svg>
</div>

<div class="metric">
  <span class="name">Memory</span>
  <div class="reading">
    <span class="value">{gb(machine.memory.usedBytes)}<small>{" of "}{gb(machine.memory.totalBytes)} GB</small></span>
    <span class="note">
      {#if machine.memory.pressure}<span class="pressure {machine.memory.pressure}">{PRESSURE_TEXT[machine.memory.pressure]}</span>{/if}
      {#if machine.memory.swapUsedBytes !== null} Swap holds {gb(machine.memory.swapUsedBytes)}{machine.memory.swapTotalBytes ? ` of ${gb(machine.memory.swapTotalBytes)}` : ""} GB.{/if}
    </span>
  </div>
  <div class="bar {machine.memory.pressure ?? 'normal'}" role="meter" aria-label="Memory used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(memPercent)}>
    <span style:width="{memPercent}%"></span>
  </div>
</div>
{#if machine.memory.groups}
  <div class="groups" aria-label="Memory by group">
    {#each machine.memory.groups as group (group.id)}
      <details class="group">
        <summary>
          <span class="group-name">{group.label}</span>
          <span class="group-size">{gb(group.bytes)} GB</span>
          <span class="share" role="meter" aria-label="{group.label} share" aria-valuemin="0" aria-valuemax="100" aria-valuenow={groupTotal ? Math.round((100 * group.bytes) / groupTotal) : 0}>
            <span style:width="{groupTotal ? (100 * group.bytes) / groupTotal : 0}%"></span>
          </span>
        </summary>
        <ul>
          {#each group.top as item (item.label)}<li><span class="item-name" title={item.label}>{item.label}</span><span class="group-size">{gb(item.bytes)} GB</span></li>
          {:else}<li class="none">Nothing running</li>{/each}
        </ul>
      </details>
    {/each}
    {#if machine.platform === "darwin"}
      <p class="note">The groups add up to {gb(groupTotal)} GB of memory footprint, the number Activity Monitor shows. It can pass the {gb(machine.memory.usedBytes)} GB in RAM, because footprint also counts{machine.memory.swapUsedBytes ? ` the ${gb(machine.memory.swapUsedBytes)} GB in swap and` : ""} compressed pages at full size.</p>
    {:else}
      <p class="note">The groups add up to {gb(groupTotal)} GB, each service's memory as Linux counts it. That includes file cache the box can take back, so it can pass the {gb(machine.memory.usedBytes)} GB in use.</p>
    {/if}
  </div>
{/if}

<style>
  .metric { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(140px, 220px); align-items: center; gap: 4px 16px; }
  .name { font-weight: 500; align-self: start; padding-top: 4px; }
  .reading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .value { font-size: 22px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .value small { font-size: 13px; font-weight: 500; color: var(--text-muted); letter-spacing: 0; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .pressure.critical { color: var(--danger); }
  .pressure.warn { color: var(--warning); }
  .spark { width: 100%; height: 36px; overflow: visible; }
  .spark .mid { stroke: var(--border); stroke-width: 0.5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
  .spark .stroke { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
  .spark .fill { fill: var(--accent); opacity: 0.12; }
  .bar { height: 6px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.4s ease; }
  .bar.warn span { background: var(--warning); }
  .bar.critical span { background: var(--danger); }
  .groups { display: flex; flex-direction: column; margin: -8px 0 0 136px; }
  .group summary { display: grid; grid-template-columns: minmax(0, 1fr) 64px minmax(140px, 220px); align-items: center; gap: 16px; padding: 4px 0; cursor: pointer; list-style: none; }
  .group summary::-webkit-details-marker { display: none; }
  .group summary::before { content: "▸"; position: absolute; margin-left: -14px; color: var(--text-faint); font-size: 10px; }
  .group[open] summary::before { content: "▾"; }
  .group-name { font-weight: 500; }
  .group-size { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .share { height: 6px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .share span { display: block; height: 100%; border-radius: inherit; background: var(--text-muted); }
  .group ul { margin: 0 0 6px; padding: 0; list-style: none; font-size: 12px; }
  .group li { display: grid; grid-template-columns: minmax(0, 1fr) 64px minmax(140px, 220px); gap: 16px; padding: 2px 0 2px 12px; color: var(--text-muted); }
  .item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group li.none { display: block; color: var(--text-faint); }
  .groups .note { margin-top: 6px; font-size: 12px; }
</style>
