<script lang="ts">
  import { api } from "./api.ts";
  import { compactNumber } from "./format.ts";
  import { cacheHealth } from "../shared/cache-health.ts";
  import type { ContextUsage, SessionUsage, ThreadMessage, ThreadStats } from "../shared/types.ts";

  let { threadId, context, usage, messages, live }: {
    threadId: string; context: ContextUsage; usage: SessionUsage | null; messages: readonly ThreadMessage[]; live: boolean;
  } = $props();

  const RING = 2 * Math.PI * 8;
  const percent = $derived(Math.max(0, Math.min(100, Math.round(context.percent))));
  const health = $derived(cacheHealth(messages));
  let open = $state(false);
  let stats = $state<ThreadStats | null>(null);
  let fetchedAt = 0;

  function show(): void {
    open = true;
    if (!live || Date.now() - fetchedAt < 5000) return;
    fetchedAt = Date.now();
    api.stats(threadId).then(result => { stats = result; }, () => { fetchedAt = 0; });
  }
  const cost = $derived(stats?.cost ?? usage?.cost ?? health.totals.cost);
  const tokens = $derived(stats?.tokens ?? { ...health.totals, total: 0 });
  const money = (value: number) => "$" + value.toFixed(value < 10 ? 2 : 0);
  const rate = (value: number) => (value * 100).toFixed(value > 0.99 && value < 1 ? 1 : 0) + "%";
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="meter" tabindex="0" role="group" aria-label="Context {percent}% used" aria-describedby={open ? "context-details" : undefined}
  onmouseenter={show} onmouseleave={() => { open = false; }} onfocusin={show} onfocusout={() => { open = false; }}>
  <svg width="16" height="16" viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="11" cy="11" r="8" fill="none" stroke="var(--border-strong)" stroke-width="3" />
    <circle cx="11" cy="11" r="8" fill="none" stroke={percent >= 85 ? "var(--danger)" : percent >= 65 ? "var(--warning)" : "var(--text-muted)"} stroke-width="3"
      stroke-linecap="round" stroke-dasharray="{RING * percent / 100} {RING}" transform="rotate(-90 11 11)" />
  </svg>
  <span>{percent}%</span>
  {#if health.level !== "ok"}<span class="flag {health.level}" role="img" aria-label="Cache problem"></span>{/if}
  {#if open}
    <div class="details fade-in" id="context-details" role="tooltip">
      <div class="line"><span>Context</span><span>{compactNumber(context.tokens)} of {compactNumber(context.contextWindow)}</span></div>
      <div class="line"><span>Session cost</span><span>{money(cost)}</span></div>
      <div class="rule"></div>
      <div class="line"><span>Input</span><span>{tokens.input.toLocaleString()}</span></div>
      <div class="line"><span>Output</span><span>{tokens.output.toLocaleString()}</span></div>
      <div class="line"><span>Cache read</span><span>{tokens.cacheRead.toLocaleString()}</span></div>
      <div class="line"><span>Cache write</span><span>{tokens.cacheWrite.toLocaleString()}</span></div>
      <div class="rule"></div>
      {#if health.last}
        <div class="line" class:warn={health.level === "warn"} class:bad={health.level === "bad"}>
          <span>Last call cache hit</span><span>{health.last.warm ? rate(health.last.hit) : "cold start"}</span>
        </div>
        {#if health.usualHit !== null}<div class="line faint"><span>Usual for this thread</span><span>{rate(health.usualHit)}</span></div>{/if}
      {:else}
        <div class="line faint"><span>No model calls yet</span></div>
      {/if}
      {#each health.reasons as reason (reason)}<div class="reason {health.level}">{reason}</div>{/each}
      {#if !stats}<div class="source">{live ? "Loading session totals" : "Totals from the loaded messages"}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .meter { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px; border-radius: var(--radius-small); font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; cursor: default; }
  .meter:hover, .meter:focus-visible { background: var(--bg-hover); color: var(--text); }
  .meter svg { display: block; }
  .flag { width: 7px; height: 7px; border-radius: 50%; }
  .flag.warn { background: var(--warning); }
  .flag.bad { background: var(--danger); }
  .details { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 30; width: 260px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg-elevated); box-shadow: var(--shadow); color: var(--text); white-space: normal; }
  .line { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .line span:first-child { color: var(--text-muted); }
  .line.warn span { color: var(--warning); }
  .line.bad span { color: var(--danger); }
  .rule { height: 1px; margin: 6px 0; background: var(--border); }
  .reason { margin-top: 6px; padding: 6px 8px; border-radius: var(--radius-small); font-size: 12px; line-height: 1.4; }
  .reason.warn { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--text); }
  .reason.bad { background: var(--danger-soft); color: var(--text); }
  .source { margin-top: 6px; font-size: 11px; color: var(--text-faint); }
</style>
