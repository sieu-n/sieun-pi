<script lang="ts" generics="T extends string | number">
  import type { Snippet } from "svelte";

  /** One radio row for a single-choice label (priority or progress): arrow keys move, a click or Space sets it. Null means the targets disagree. */
  let { label, values, value, onchange, autofocus = false, fill = false, item }: {
    label: string; values: readonly T[]; value: T | null; onchange: (value: T) => void; autofocus?: boolean; fill?: boolean; item: Snippet<[T, boolean]>;
  } = $props();

  const focusIndex = $derived(Math.max(0, value === null ? 0 : values.indexOf(value)));
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".level")];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
</script>

<div class="levels" class:fill role="radiogroup" aria-label={label} tabindex="-1" onkeydown={onKey}>
  {#each values as entry, index (entry)}
    <button type="button" class="level" class:on={value === entry} role="radio" aria-checked={value === entry} tabindex={index === focusIndex ? 0 : -1}
      data-autofocus={autofocus && index === focusIndex ? true : undefined} onclick={() => onchange(entry)}>{@render item(entry, value === entry)}</button>
  {/each}
</div>

<style>
  .levels { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; margin: 2px 2px 4px; padding: 2px; border-radius: 8px; background: var(--bg-sunken); outline: none; }
  .levels.fill { display: flex; }
  .levels.fill .level { flex: 1 1 auto; padding: 0 6px; }
  .level { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; border-radius: var(--radius-small); font-size: 12px; color: var(--text-muted); white-space: nowrap; transition: background-color 0.12s, color 0.12s; }
  .level:hover:not(.on) { background: var(--bg-hover); color: var(--text); }
  .level.on { background: var(--accent-soft); color: var(--accent-bold); font-weight: 600; }
</style>
