<script lang="ts" module>
  const pad = (value: number) => String(value).padStart(2, "0");
  export const isoDay = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const parseDay = (value: string): Date | null => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null; };
  const addDays = (date: Date, days: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
</script>

<script lang="ts">
  import Floating from "./Floating.svelte";
  import Icon from "../Icon.svelte";

  /** A date range chip with presets and a month grid. Values are local YYYY-MM-DD days; an empty string leaves that side open. */
  let { label, from, to, onchange }: { label: string; from: string; to: string; onchange: (from: string, to: string) => void } = $props();

  let open = $state(false);
  let trigger: HTMLButtonElement | undefined = $state();
  let grid: HTMLElement | undefined = $state();
  let month = $state(new Date());
  let focusDay = $state(new Date());
  let picking = $state<string | null>(null);
  let hover = $state<string | null>(null);

  const today = new Date();
  const PRESETS: readonly { label: string; days: number | null }[] = [
    { label: "Today", days: 0 }, { label: "7 days", days: 6 }, { label: "30 days", days: 29 }, { label: "90 days", days: 89 }, { label: "Any time", days: null },
  ];
  const short = (value: string): string => {
    const date = parseDay(value);
    if (!date) return "";
    return date.toLocaleDateString("en-US", date.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  };
  const summary = $derived(from && to ? (from === to ? short(from) : `${short(from)} to ${short(to)}`) : from ? "since " + short(from) : to ? "until " + short(to) : "");
  const presetOn = (days: number | null): boolean => days === null ? !from && !to : to === isoDay(today) && from === isoDay(addDays(today, -days));

  const cells = $derived.by(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = addDays(first, -((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  });
  const monthLabel = $derived(month.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
  const span = $derived.by((): [string, string] | null => {
    if (picking) { const other = hover ?? picking; return picking <= other ? [picking, other] : [other, picking]; }
    return from || to ? [from || "0000-00-00", to || "9999-99-99"] : null;
  });

  function show(): void {
    const start = parseDay(from) ?? parseDay(to) ?? today;
    month = new Date(start.getFullYear(), start.getMonth(), 1);
    focusDay = start;
    picking = null;
    hover = null;
    open = true;
  }
  function preset(days: number | null): void {
    open = false;
    if (days === null) onchange("", "");
    else onchange(isoDay(addDays(today, -days)), isoDay(today));
  }
  function pick(day: Date): void {
    const value = isoDay(day);
    focusDay = day;
    if (!picking) { picking = value; hover = value; return; }
    const [start, end] = picking <= value ? [picking, value] : [value, picking];
    picking = null;
    open = false;
    onchange(start, end);
  }
  function moveFocus(day: Date): void {
    focusDay = day;
    if (day.getMonth() !== month.getMonth() || day.getFullYear() !== month.getFullYear()) month = new Date(day.getFullYear(), day.getMonth(), 1);
    if (picking) hover = isoDay(day);
    requestAnimationFrame(() => grid?.querySelector<HTMLElement>(`[data-day="${isoDay(day)}"]`)?.focus());
  }
  function onGridKey(event: KeyboardEvent): void {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) { event.preventDefault(); moveFocus(addDays(focusDay, steps[event.key]!)); }
    else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      moveFocus(new Date(focusDay.getFullYear(), focusDay.getMonth() + (event.key === "PageUp" ? -1 : 1), Math.min(focusDay.getDate(), 28)));
    } else if (event.key === "Home") { event.preventDefault(); moveFocus(addDays(focusDay, -((focusDay.getDay() + 6) % 7))); }
    else if (event.key === "End") { event.preventDefault(); moveFocus(addDays(focusDay, 6 - ((focusDay.getDay() + 6) % 7))); }
  }
  function shiftMonth(delta: number): void { month = new Date(month.getFullYear(), month.getMonth() + delta, 1); }
</script>

<button bind:this={trigger} type="button" class="select" class:set={Boolean(summary)} aria-haspopup="dialog" aria-expanded={open}
  onclick={() => { if (open) open = false; else show(); }}>
  <Icon name="calendar" size={13} />
  <span class="text">{label}{#if summary} <span class="value">{summary}</span>{/if}</span>
  <Icon name="chevronDown" size={12} />
</button>

{#if open && trigger}
  <Floating anchor={trigger} width={272} maxHeight={420} label="{label} range" onclose={() => { open = false; }}>
    <div class="presets" role="group" aria-label="Presets">
      {#each PRESETS as entry (entry.label)}
        <button type="button" class="preset" class:on={presetOn(entry.days)} aria-pressed={presetOn(entry.days)} onclick={() => preset(entry.days)}>{entry.label}</button>
      {/each}
    </div>
    <div class="month">
      <button type="button" class="icon-button small" aria-label="Previous month" onclick={() => shiftMonth(-1)}><Icon name="chevronLeft" /></button>
      <span class="month-label" aria-live="polite">{monthLabel}</span>
      <button type="button" class="icon-button small" aria-label="Next month" onclick={() => shiftMonth(1)}><Icon name="chevronRight" /></button>
    </div>
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="grid" role="grid" aria-label={monthLabel} bind:this={grid} onkeydown={onGridKey}>
      <div class="week" role="row">{#each WEEKDAYS as day (day)}<span class="weekday" role="columnheader">{day}</span>{/each}</div>
      {#each [0, 1, 2, 3, 4, 5] as row (row)}
        <div class="week" role="row">
          {#each cells.slice(row * 7, row * 7 + 7) as day (isoDay(day))}
            {@const value = isoDay(day)}
            {@const inside = span !== null && value >= span[0] && value <= span[1]}
            {@const edge = span !== null && (value === span[0] || value === span[1])}
            <span role="gridcell" aria-selected={inside}>
              <button type="button" class="day" class:outside={day.getMonth() !== month.getMonth()} class:inside class:edge class:today={value === isoDay(today)}
                data-day={value} tabindex={value === isoDay(focusDay) ? 0 : -1} data-autofocus={value === isoDay(focusDay) ? true : undefined}
                aria-label={day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                onpointerenter={() => { if (picking) hover = value; }} onclick={() => pick(day)}>{day.getDate()}</button>
            </span>
          {/each}
        </div>
      {/each}
    </div>
    {#if picking}<div class="foot" aria-live="polite">Pick the last day</div>{/if}
  </Floating>
{/if}

<style>
  .select { display: inline-flex; align-items: center; gap: 5px; height: 28px; max-width: 280px; padding: 0 8px 0 9px; border-radius: var(--radius-small); border: 1px solid var(--border-strong);
    background: var(--bg-elevated); font-size: 12.5px; color: var(--text-muted); }
  .select:hover, .select[aria-expanded="true"] { color: var(--text); }
  .select.set { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent-bold); }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .value { font-variant-numeric: tabular-nums; }
  .presets { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 4px 8px; border-bottom: 1px solid var(--border); }
  .preset { height: 24px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12px; color: var(--text-muted); background: var(--bg-sunken); }
  .preset:hover { color: var(--text); }
  .preset.on { background: var(--accent-soft); color: var(--accent-bold); font-weight: 600; }
  .month { display: flex; align-items: center; justify-content: space-between; padding: 6px 2px 2px; }
  .month-label { font-size: 12.5px; font-weight: 600; }
  .grid { padding: 0 4px; }
  .week { display: grid; grid-template-columns: repeat(7, 1fr); }
  .weekday { padding: 4px 0; text-align: center; font-size: 11px; color: var(--text-faint); }
  .day { width: 100%; height: 30px; border-radius: var(--radius-small); font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--text); }
  .day:hover { background: var(--bg-hover); }
  .day.outside { color: var(--text-faint); }
  .day.today { font-weight: 700; color: var(--accent-bold); }
  .day.inside { background: var(--accent-soft); border-radius: 0; }
  .day.edge { background: var(--accent-fill); color: #fff; border-radius: var(--radius-small); }
  .foot { padding: 6px 6px 2px; font-size: 11.5px; color: var(--text-faint); }
</style>
