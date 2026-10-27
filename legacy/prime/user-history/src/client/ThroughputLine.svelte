<script lang="ts">
  import { api } from "./api.ts";
  import { clock } from "./clock.svelte.ts";
  import { store } from "./store.svelte.ts";
  import type { UsageFeed } from "../shared/usage.ts";
  import { usageMetric } from "./usage-metric.svelte.ts";
  import { fullTokens, METRIC_LABEL, METRICS, sparkPath, tokens } from "./usage.ts";

  /**
   * One footer row: a live trace of tokens per second of every agent on every box, from the `usage` feed (LGTM), with the current figure, for the
   * token kind picked in Settings > Usage (output unless changed). A failed LGTM query shows "err" in red with the error on hover, never 0.
   * A click opens Settings > Usage. The feed is subscribed only while the tab is visible. The trace has no motion: a 2 s slide per update kept a
   * transform animation running almost all the time, and Chromium ticks the main thread at 60 frames a second for it while the page has an
   * IntersectionObserver.
   */
  const W = 60;
  const H = 18;
  let feed = $state<UsageFeed | null>(null);
  const summary = $derived(feed?.state === "live" ? feed : null);
  const down = $derived(feed?.state === "error" ? feed.error : null);
  let visible = $state(document.visibilityState === "visible");
  /** The server sent a summary this page cannot read (another build); the hover says to reload. */
  let unreadable = $state(false);

  $effect(() => {
    const sync = () => { visible = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  });
  $effect(() => {
    if (!visible) return;
    return api.usageStream(next => { feed = next; unreadable = false; }, () => {}, () => { feed = null; unreadable = true; });
  });

  const metric = $derived(usageMetric.value);
  const name = $derived(METRICS.find(entry => entry.id === metric)?.short ?? "Tokens");
  const stale = $derived(feed !== null && clock.now - feed.at > 15_000);
  const line = $derived(summary ? sparkPath(summary.spark[metric], W, H) : "");
  const area = $derived(line ? line + `L${W} ${H}L0 ${H}Z` : "");
  const other = $derived(metric === "total" ? "output" : "total");
  const title = $derived(summary
    ? [`All agents on every box, right now`, `${METRIC_LABEL[metric]} tokens, over the last 60 s`,
      `${fullTokens(summary.perSecond[metric])} per second (${fullTokens(summary.perSecond[other])} ${other})`,
      `${fullTokens(summary.perMinute[metric])} per minute over the last 60 min`, `${fullTokens(summary.perDay[metric])} over the last 24 h`, "Open usage"].join("\n")
    : down ? `Usage from LGTM failed: ${down}\nOpen usage` : unreadable ? "The chat service runs another build than this page. Reload the page to see usage." : "Usage of all agents on every box\nOpen usage");
</script>

<button type="button" class="line" class:stale class:down={down !== null} title={title} aria-label="{METRIC_LABEL[metric]} tokens per second, all agents" onclick={() => { store.drawer = "usage"; }}>
  <span class="name">{name}</span>
  <span class="trace" aria-hidden="true">
    {#if summary}
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="trace-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.28" /><stop offset="1" stop-color="var(--accent)" stop-opacity="0" /></linearGradient>
        </defs>
        <path class="fill" d={area} />
        <path class="glow" d={line} />
        <path class="ink" d={line} />
      </svg>
    {/if}
  </span>
  <span class="figure">{summary ? tokens(summary.perSecond[metric]) : down ? "err" : "–"}<span class="unit">tok/s</span></span>
</button>

<style>
  .line { display: flex; align-items: center; gap: 10px; width: 100%; padding: 4px 6px; border-radius: var(--radius-small); font-size: 11px; line-height: 1; text-align: left; font-variant-numeric: tabular-nums; }
  .line:hover { background: var(--bg-hover); }
  .name { width: 48px; flex: none; font-weight: 600; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trace { flex: 1; min-width: 0; height: 18px; overflow: hidden; border-bottom: 1px solid var(--border); }
  svg { display: block; width: 100%; height: 100%; overflow: visible; }
  path { vector-effect: non-scaling-stroke; }
  .fill { fill: url(#trace-fill); stroke: none; }
  .glow { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linejoin: round; opacity: 0.22; }
  .ink { fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-linejoin: round; stroke-linecap: round; }
  .stale .trace { opacity: 0.4; }
  .figure { flex: none; min-width: 58px; text-align: right; font-weight: 600; color: var(--text); }
  .stale .figure { color: var(--text-faint); }
  .down .figure { color: var(--danger); }
  .unit { margin-left: 3px; font-weight: 500; color: var(--text-faint); }
</style>
