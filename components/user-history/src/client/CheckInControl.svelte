<script module lang="ts">
  export { checkInStatus } from "./check-in.ts";
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";
  import { store } from "./store.svelte.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime } from "./format.ts";
  import { tooltip } from "./ui/tooltip.ts";
  import { checkInApi, checkInButton, nextNine, pauseNow, previewCheckIn } from "./check-in.ts";
  import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, CHECK_IN_PRESET_MINUTES, type CheckInPause, type CheckInState } from "../shared/types.ts";

  /**
   * The chat's check-in in the header: a button with the interval or the pause, and a panel to set the interval (presets or 1 to 240 minutes) or
   * pause it for an hour, until 09:00, or until resumed. A change shows at once and rolls back with a toast when the server refuses it.
   */
  let { id }: { id: string } = $props();
  const MINUTE = 60_000;
  const row = $derived(store.session(id));
  let optimistic = $state<CheckInState | null>(null);
  let saving = $state(false);
  let open = $state(false);
  let lastAt = $state<number | null>(null);
  let custom = $state("");
  const current = $derived(optimistic ?? row?.checkIn ?? null);
  const pause = $derived(current ? pauseNow(current, clock.now) : null);
  const paused = $derived(pause !== null);
  const button = $derived(current ? checkInButton(current, clock.now) : { word: "", value: "" });
  const customMinutes = $derived(Number(custom));
  const customValid = $derived(Number.isInteger(customMinutes) && customMinutes >= CHECK_IN_MIN_MINUTES && customMinutes <= CHECK_IN_MAX_MINUTES);

  $effect(() => {
    void row?.checkIn;
    untrack(() => { if (!saving) optimistic = null; });
  });

  function toggle(): void {
    open = !open;
    if (!open) return;
    checkInApi.view(id).then(view => { lastAt = view.lastAt; }, () => {});
  }

  async function change(next: { everyMs?: number; pause?: CheckInPause | null }): Promise<void> {
    if (!current || saving) return;
    const before = optimistic;
    optimistic = previewCheckIn(current, next, Date.now());
    open = false;
    saving = true;
    try {
      const view = await checkInApi.set(id, next);
      const { lastAt: _lastAt, ...state } = view;
      optimistic = state;
      lastAt = view.lastAt;
    } catch (error) {
      optimistic = before;
      store.toast(`Check-in not changed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { saving = false; }
  }

  function setCustom(event: SubmitEvent): void {
    event.preventDefault();
    if (!customValid) return;
    void change({ everyMs: customMinutes * MINUTE });
    custom = "";
  }

  const presetLabel = (minutes: number) => minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  const summary = $derived.by(() => {
    if (!current) return "";
    if (pause !== null) return pause === "forever" ? "Paused until you resume it." : `Paused until ${clockTime(pause)}.`;
    return `Every ${Math.round(current.everyMs / MINUTE)} min${current.nextAt !== null ? `, next at ${clockTime(Math.max(current.nextAt, clock.now))}` : ""}.`;
  });
</script>

{#if current}
  <Popover {open} onclose={() => { open = false; }} align="end" width={320} label="Check-in">
    {#snippet trigger()}
      <button type="button" class="trigger" class:paused aria-haspopup="dialog" aria-expanded={open} use:tooltip={"Check-in: how often the server looks at this chat's jobs and plan"}
        onclick={toggle}>
        <Icon name="bolt" size={12} /><span><span class="word">{button.word}</span>{button.value}</span>
      </button>
    {/snippet}
    <div class="panel">
      <p class="summary">{summary}{#if lastAt !== null}<span class="faint"> Last at {clockTime(lastAt)}.</span>{/if}</p>
      <p class="faint">A check-in reads the jobs and the plan and wakes the chat only when something changed.</p>
      <div class="label">Every</div>
      <div class="chips" role="group" aria-label="Interval">
        {#each CHECK_IN_PRESET_MINUTES as minutes (minutes)}
          <button type="button" class="chip" aria-pressed={current.everyMs === minutes * MINUTE} onclick={() => change({ everyMs: minutes * MINUTE })}>{presetLabel(minutes)}</button>
        {/each}
      </div>
      <form class="custom" onsubmit={setCustom}>
        <input type="number" inputmode="numeric" min={CHECK_IN_MIN_MINUTES} max={CHECK_IN_MAX_MINUTES} step="1" placeholder="Other, {CHECK_IN_MIN_MINUTES} to {CHECK_IN_MAX_MINUTES}"
          aria-label="Minutes between check-ins" bind:value={custom} />
        <span class="unit">min</span>
        <button type="submit" class="button small" disabled={!customValid}>Set</button>
      </form>
      <div class="label">Pause</div>
      {#if paused}
        <button type="button" class="button small primary resume" onclick={() => change({ pause: null })}>Resume check-ins</button>
      {/if}
      <div class="chips" role="group" aria-label="Pause">
        <button type="button" class="chip" onclick={() => change({ pause: "1h" })}>1 hour</button>
        <button type="button" class="chip" onclick={() => change({ pause: "tomorrow" })}>Until {clockTime(nextNine(clock.now))}</button>
        <button type="button" class="chip" aria-pressed={pause === "forever"} onclick={() => change({ pause: "forever" })}>Until I resume</button>
      </div>
    </div>
  </Popover>
{/if}

<style>
  .trigger { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border-radius: var(--radius-small); color: var(--text-muted); font-size: 12px; white-space: nowrap; }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-hover); color: var(--text); }
  .trigger.paused { color: var(--warning); }
  .panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; font-size: 12.5px; }
  .summary { margin: 0; color: var(--text); font-weight: 500; }
  .faint { margin: 0; color: var(--text-faint); font-weight: 400; font-size: 12px; }
  .label { margin-top: 4px; color: var(--text-muted); font-size: 11.5px; font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--border-strong); background: var(--bg-elevated); font-size: 12px; }
  .chip:hover { background: var(--bg-hover); }
  .chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-bold); font-weight: 600; }
  .custom { display: flex; align-items: center; gap: 6px; }
  .custom input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: var(--radius-small); background: var(--bg-elevated); font-size: 12px; }
  .unit { color: var(--text-muted); font-size: 12px; }
  .resume { align-self: flex-start; }
  @container app (max-width: 720px) { .word { display: none; } }
</style>
