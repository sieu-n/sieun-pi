<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import AgentQueueSettings from "./AgentQueueSettings.svelte";
  import type { MachineView, MemoryPressure } from "../shared/types.ts";

  const POLL_MS = 2000;
  const HISTORY = 30;

  let view = $state<MachineView | null>(null);
  let error = $state<string | null>(null);
  let cpuHistory = $state<number[]>([]);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load(): Promise<void> {
    try {
      const next = await api.machine();
      view = next;
      cpuHistory = [...cpuHistory, next.cpu.percent].slice(-HISTORY);
      error = null;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  onMount(() => { void load(); timer = setInterval(() => { void load(); }, POLL_MS); });
  onDestroy(() => clearInterval(timer));

  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const memPercent = $derived(view ? (100 * view.memory.usedBytes) / view.memory.totalBytes : 0);
  const PRESSURE_TEXT: Record<MemoryPressure, string> = {
    normal: "Memory pressure is normal.",
    warn: "Memory pressure is high, so macOS is compressing and swapping.",
    critical: "Memory pressure is critical, so apps may slow down or quit.",
  };
  const line = $derived.by(() => {
    if (cpuHistory.length < 2) return "";
    const step = 100 / (HISTORY - 1);
    const start = 100 - step * (cpuHistory.length - 1);
    return cpuHistory.map((value, index) => `${(start + step * index).toFixed(2)},${(36 - (value / 100) * 34).toFixed(2)}`).join(" ");
  });
  const area = $derived(line ? `${line.split(" ")[0]!.split(",")[0]},36 ${line} 100,36` : "");
</script>

<section class="pane" aria-label="This Mac">
  {#if !view}
    <p class="note">{error ? `CPU and memory are unavailable. ${error}` : "Reading CPU and memory"}</p>
  {:else}
    <div class="metric">
      <span class="name">CPU</span>
      <div class="reading">
        <span class="value">{Math.round(view.cpu.percent)}<small>%</small></span>
        <span class="note">Load {view.cpu.load[0].toFixed(1)} over the last minute on {view.cpu.cores} cores.</span>
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
        <span class="value">{gb(view.memory.usedBytes)}<small>{" of "}{gb(view.memory.totalBytes)} GB</small></span>
        <span class="note">
          {#if view.memory.pressure}<span class="pressure {view.memory.pressure}">{PRESSURE_TEXT[view.memory.pressure]}</span>{/if}
          {#if view.memory.swapUsedBytes !== null} Swap holds {gb(view.memory.swapUsedBytes)} GB.{/if}
        </span>
      </div>
      <div class="bar {view.memory.pressure ?? 'normal'}" role="meter" aria-label="Memory used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(memPercent)}>
        <span style:width="{memPercent}%"></span>
      </div>
    </div>
    {#if error}<p class="note problem">The last reading failed. {error}</p>{/if}
  {/if}
  <AgentQueueSettings />
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 18px; padding: 14px 18px 18px; font-size: 13px; }
  .metric { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(140px, 220px); align-items: center; gap: 4px 16px; }
  .name { font-weight: 500; align-self: start; padding-top: 4px; }
  .reading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .value { font-size: 22px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .value small { font-size: 13px; font-weight: 500; color: var(--text-muted); letter-spacing: 0; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .note.problem, .pressure.critical { color: var(--danger); }
  .pressure.warn { color: var(--warning); }
  .spark { width: 100%; height: 36px; overflow: visible; }
  .spark .mid { stroke: var(--border); stroke-width: 0.5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
  .spark .stroke { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
  .spark .fill { fill: var(--accent); opacity: 0.12; }
  .bar { height: 6px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.4s ease; }
  .bar.warn span { background: var(--warning); }
  .bar.critical span { background: var(--danger); }
</style>
