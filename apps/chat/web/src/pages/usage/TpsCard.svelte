<script lang="ts">
  import { api, type UsageLive, type UsageReport } from "$lib/api";
  import { BUCKET_MS } from "$lib/api/shared/usage-range";
  import { CardGroup } from "$lib/ui";
  import UsageChart from "./UsageChart.svelte";
  import { count, full, type ChartFormat, type TipRow } from "./format";
  import { cellsOf, type Metric, type Series } from "./stats";

  /**
   * Tokens per second, as Prime's chat usage card reads it (user-history UsageSettings.svelte): the live rate over the last 60 s with the
   * other token kind under it and a spark of that rate every 10 s over 10 min, then the rate per minute, hour or day over the page's range.
   * The live rate comes from api/usage/live every 5 s, the cadence of Prime's usage feed. A bucket's rate is its tokens over its seconds,
   * and the bucket that holds now counts only the seconds gone by, so it reads as fast as the others while it fills.
   */
  let { report, series, metric, thread, host }: { report: UsageReport; series: readonly Series[]; metric: Metric; thread?: string; host?: string } = $props();

  const POLL_MS = 5_000;
  const SPARK = { width: 120, height: 28 };

  let live = $state<UsageLive | null>(null);
  let error = $state<string | null>(null);
  let request = 0;

  async function poll(): Promise<void> {
    const id = ++request;
    try {
      const next = await api.usageLive({ ...(thread ? { thread } : {}), ...(host ? { host } : {}) });
      if (id !== request) return;
      live = next;
      error = null;
    } catch (reason) {
      if (id === request) error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  $effect(() => {
    void thread;
    void host;
    live = null;
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
  const tick = (value: number): string => (value < 1000 ? String(Number(value.toPrecision(3))) : count(value));
  const format = $derived<ChartFormat>({ label, short: rate, exact: exactRate, tick });
  const liveClock = $derived(live ? new Date(live.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");
  const liveTitle = (value: number, kind: Metric) => `${full(value * 60)} ${kind === "total" ? "tokens" : "output tokens"} in the 60 s before ${liveClock}, ${exactRate(value)}`;

  /** An SVG path through `values` scaled into the spark, oldest left; one flat line when every value is zero (Prime's sparkPath). */
  function sparkPath(values: readonly number[]): string {
    const max = Math.max(0, ...values);
    const step = values.length > 1 ? SPARK.width / (values.length - 1) : 0;
    const y = (value: number) => (max > 0 ? SPARK.height - 1 - (value / max) * (SPARK.height - 2) : SPARK.height - 1);
    return values.map((value, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${y(value).toFixed(1)}`).join("");
  }

  /** Each bucket's seconds: to the next bucket's start, and for the bucket that holds now only to the report's moment. */
  const seconds = $derived(report.buckets.map((entry, index) => {
    const end = Math.min(report.buckets[index + 1]?.start ?? entry.start + BUCKET_MS[report.bucket], report.at);
    return Math.max(1, (end - entry.start) / 1000);
  }));
  const tokenCells = $derived(cellsOf(report.buckets, series, { unit: "tokens", metric }));
  const cells = $derived(tokenCells.map((row, index) => row.map(value => value / seconds[index]!)));
  function tipRows(index: number): TipRow[] {
    const tokens = (tokenCells[index] ?? []).reduce((sum, value) => sum + value, 0);
    const span = seconds[index]!;
    const filling = report.buckets[index]!.start + BUCKET_MS[report.bucket] > report.at;
    return [{ label: metric === "total" ? "Tokens" : "Output tokens", value: full(tokens) }, { label: filling ? "Seconds so far" : "Seconds", value: span.toLocaleString("en-US", { maximumFractionDigits: 3 }) }];
  }
</script>

<CardGroup title={metric === "total" ? "Tokens per second" : "Output tokens per second"} description="Live over the last 60 s, then per {report.bucket} over the range, every kind of token or output only as the toggle says.">
  <div class="tps" data-testid="usage-tps">
    <div class="stat" aria-live="off">
      <span class="stat-label">{label}</span>
      {#if live}
        <span class="stat-value" data-testid="usage-tps-value" title={liveTitle(live.perSecond[metric], metric)}>{rate(live.perSecond[metric])}</span>
        <span class="stat-sub" data-testid="usage-tps-other" title={liveTitle(live.perSecond[other], other)}>{otherLabel} {rate(live.perSecond[other])}</span>
        <span class="stat-sub">last 60 s</span>
        <svg class="spark" viewBox="0 0 {SPARK.width} {SPARK.height}" preserveAspectRatio="none" role="img" aria-label="{label} every 10 s over the last 10 minutes" data-testid="usage-tps-spark">
          <path d={sparkPath(live.spark[metric])} />
        </svg>
      {:else if error}
        <span class="stat-sub" role="status">Couldn't read the live rate: {error.replace(/\.$/, "")}.</span>
      {:else}
        <span class="stat-value muted">–</span>
        <span class="stat-sub">last 60 s</span>
      {/if}
    </div>
    <div class="range">
      <UsageChart buckets={report.buckets} {series} bucket={report.bucket} {cells} {format} total={null} tip={tipRows} />
    </div>
  </div>
</CardGroup>

<style>
  .tps { display: flex; flex-wrap: wrap; gap: var(--space-6); padding: var(--space-4); }
  .stat { display: flex; min-width: 9rem; flex: 0 1 12rem; flex-direction: column; gap: var(--space-1); }
  .stat-label { color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .stat-value { color: var(--text-standard); font-size: 24px; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat-value.muted { color: var(--text-metadata); }
  .stat-sub { color: var(--text-metadata); font: var(--text-caption); letter-spacing: var(--tracking-caption); font-variant-numeric: tabular-nums; }
  .spark { width: 100%; height: 28px; margin-top: var(--space-2); }
  .spark path { fill: none; stroke: var(--chart-series-1); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .range { min-width: 0; flex: 1 1 24rem; }
</style>
