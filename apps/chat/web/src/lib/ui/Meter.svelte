<script lang="ts">
  type Props = {
    /** 0 to 100. Values above 100 draw a full bar in the danger color. */
    percent: number | null;
    label?: string;
    /** Text after the label, for example "62%" or "3.1 / 8 GB". Defaults to the rounded percent. */
    value?: string;
    /** Warn and danger thresholds in percent. */
    warn?: number;
    danger?: number;
    /** Lower is worse, for example remaining quota. */
    inverted?: boolean;
    compact?: boolean;
    title?: string;
  };
  let { percent, label, value, warn = 70, danger = 90, inverted = false, compact = false, title }: Props = $props();
  const p = $derived(percent == null || !Number.isFinite(percent) ? null : Math.max(0, percent));
  const level = $derived.by(() => {
    if (p == null) return "unknown";
    const v = inverted ? 100 - p : p;
    return v >= danger ? "danger" : v >= warn ? "warn" : "ok";
  });
</script>

<div class="meter {level}" class:compact {title} role="meter" aria-label={label} aria-valuenow={p ?? undefined} aria-valuemin={0} aria-valuemax={100}>
  {#if label || !compact}
    <div class="head">
      {#if label}<span class="label">{label}</span>{/if}
      <span class="value">{value ?? (p == null ? "–" : `${Math.round(p)}%`)}</span>
    </div>
  {/if}
  <div class="track"><div class="fill" style:width="{Math.min(100, p ?? 0)}%"></div></div>
</div>

<style>
  .meter {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .label {
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    color: var(--text-standard);
    font-variant-numeric: tabular-nums;
  }
  .track {
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--affordance-subtle);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: inherit;
    background: var(--text-standard);
    transition: width var(--duration-slow) var(--ease-enter);
  }
  .warn .fill {
    background: var(--status-away);
  }
  .danger .fill {
    background: var(--border-danger);
  }
  .unknown .fill {
    background: transparent;
  }
</style>
