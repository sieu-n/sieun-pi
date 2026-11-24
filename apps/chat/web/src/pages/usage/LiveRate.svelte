<script lang="ts">
  import { untrack } from "svelte";
  import { api, type UsageLive } from "$lib/api";
  import { count, full } from "./format";
  import type { Metric } from "./stats";

  /**
   * Tokens per second now, as Prime's chat usage card reads it (user-history UsageSettings.svelte): the rate over the last 60 s, the other
   * token kind beside it and a spark of that rate every 10 s over 10 min, in one line for the chart's header row. It opens with the rate
   * its report brought (`initial`), then reads api/usage/live every 5 s, the cadence of Prime's usage feed.
   */
  let { initial, metric, thread, host, client }: { initial: UsageLive | null; metric: Metric; thread?: string; host?: string; client?: string } = $props();

  const POLL_MS = 5_000;
  const SPARK = { width: 96, height: 20 };

  let live = $state<UsageLive | null>(null);
  let error = $state<string | null>(null);
  let request = 0;

  async function poll(): Promise<void> {
    const id = ++request;
    try {
      const shown = untrack(() => live !== null);
      const next = await api.usageLive({ ...(thread ? { thread } : {}), ...(host ? { host } : {}), ...(client ? { client } : {}) }, shown ? { background: "shown" } : {});
      if (id !== request) return;
      live = next;
      error = null;
    } catch (reason) {
      if (id === request) error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  /** The rate the report brought shows until the first poll; a new chat, host or client filter waits for its own. */
  let mounted = false;
  $effect(() => {
    void thread;
    void host;
    void client;
    live = mounted ? null : untrack(() => initial);
    mounted = true;
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  const other = $derived<Metric>(metric === "total" ? "output" : "total");
  const label = $derived(metric === "total" ? "Tokens / s" : "Output / s");
  const otherLabel = $derived(metric === "total" ? "out" : "total");
  /** A rate as Prime's card writes it: 42.3 under 100, else 128 or 1.2K. */
  const rate = (value: number): string => (value < 100 ? value.toFixed(1) : count(value));
  const exactRate = (value: number): string => `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })} tokens/s`;
  const liveClock = $derived(live ? new Date(live.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");
  const liveTitle = (value: number, kind: Metric) => `${full(value * 60)} ${kind === "total" ? "tokens" : "output tokens"} in the 60 s before ${liveClock}, ${exactRate(value)}`;

  /** An SVG path through `values` scaled into the spark, oldest left; one flat line when every value is zero (Prime's sparkPath). */
  function sparkPath(values: readonly number[]): string {
    const max = Math.max(0, ...values);
    const step = values.length > 1 ? SPARK.width / (values.length - 1) : 0;
    const y = (value: number) => (max > 0 ? SPARK.height - 1 - (value / max) * (SPARK.height - 2) : SPARK.height - 1);
    return values.map((value, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${y(value).toFixed(1)}`).join("");
  }
</script>

<div class="live" role="group" aria-label="{label} now" data-testid="usage-tps">
  <span class="label">{label}</span>
  {#if live}
    <span class="value" data-testid="usage-tps-value" title={liveTitle(live.perSecond[metric], metric)}>{rate(live.perSecond[metric])}</span>
    <svg class="spark" viewBox="0 0 {SPARK.width} {SPARK.height}" preserveAspectRatio="none" role="img" aria-label="{label} every 10 s over the last 10 minutes" data-testid="usage-tps-spark">
      <path d={sparkPath(live.spark[metric])} />
    </svg>
    <span class="sub" data-testid="usage-tps-other" title={liveTitle(live.perSecond[other], other)}>{otherLabel} {rate(live.perSecond[other])}</span>
    <span class="sub">last 60 s</span>
  {:else if error}
    <span class="sub" role="status">Couldn't read the live rate: {error.replace(/\.$/, "")}.</span>
  {:else}
    <span class="value muted">–</span>
    <span class="sub">last 60 s</span>
  {/if}
</div>

<style>
  .live { display: inline-flex; align-items: center; gap: var(--space-2); min-width: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .label, .sub { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .sub { color: var(--text-metadata); }
  .value { color: var(--text-standard); font: var(--text-body); font-weight: 600; }
  .value.muted { color: var(--text-metadata); }
  .spark { flex: none; width: 96px; height: 20px; }
  .spark path { fill: none; stroke: var(--accent-9); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
</style>
