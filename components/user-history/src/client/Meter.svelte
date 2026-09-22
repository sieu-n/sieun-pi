<script lang="ts">
  let { value, label, size = "normal" }: { value: number | null; label: string; size?: "normal" | "tiny" } = $props();
  const percent = $derived(value === null ? 0 : Math.max(0, Math.min(100, value)));
  const tone = $derived(value === null ? "unknown" : percent >= 90 ? "high" : percent >= 70 ? "mid" : "low");
  const text = $derived(value === null ? "unknown" : Math.round(percent) + "%");
</script>

<div class="meter {size} {tone}" title="{label}: {text}" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
  {#if size === "normal"}<span class="label">{label}</span>{/if}
  <span class="track"><span class="fill" style:width="{percent}%"></span></span>
  {#if size === "normal"}<span class="value">{text}</span>{/if}
</div>

<style>
  .meter { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
  .label { width: 44px; flex: none; }
  .value { width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
  .track { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 3px; background: var(--success); transition: width 0.3s ease; }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .unknown .track { background: repeating-linear-gradient(90deg, var(--bg-sunken) 0 4px, var(--border) 4px 8px); }
  .tiny { gap: 0; }
  .tiny .track { width: 26px; height: 4px; }
</style>
