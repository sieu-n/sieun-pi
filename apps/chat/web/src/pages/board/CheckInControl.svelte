<script lang="ts">
  import { api, type CheckInPatch, type CheckInView } from "$lib/api";
  import { CHECK_IN_PRESET_MINUTES } from "$lib/api/shared/types";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { Button, Dialog, Input, Menu, Select, toast, type MenuEntry } from "$lib/ui";
  import { hrefFor } from "$lib/router.svelte";
  import { INTERVAL_UNITS, checkInButton, checkInChoices, checkInStatus, everyLabel, intervalParts, nextLabel, pauseNow, whenLabel, type IntervalUnit } from "./schedule";

  let { chatId, view, onchange, now }: { chatId: string; view: CheckInView | null; onchange: (view: CheckInView) => void; now: number } = $props();

  let open = $state(false);
  let anchor = $state<HTMLElement>();
  let busy = $state(false);
  /** Slack's menus end in a custom choice: an interval of any length, or a pause until a date and time. */
  let custom = $state<"every" | "pause" | null>(null);
  let amount = $state("");
  let unit = $state<IntervalUnit>("minutes");

  const status = $derived(checkInStatus(view, now));
  const paused = $derived(view ? pauseNow(view, now) !== null : false);
  const current = $derived(view ? (view.planEveryMs ?? view.everyMs) : 0);
  const amountBad = $derived(!(Number.isInteger(Number(amount)) && Number(amount) >= 1));

  async function set(change: CheckInPatch): Promise<boolean> {
    busy = true;
    try {
      onchange(await api.setCheckIn(chatId, change));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The check-in did not change.");
      return false;
    } finally {
      busy = false;
    }
  }

  function customEvery() {
    const parts = intervalParts(current);
    amount = String(parts.amount);
    unit = parts.unit;
    custom = "every";
  }

  async function saveEvery(event?: Event) {
    event?.preventDefault();
    if (amountBad) return;
    if (await set({ everyMs: Number(amount) * INTERVAL_UNITS[unit] })) custom = null;
  }

  const units: { value: IntervalUnit; label: string }[] = [
    { value: "minutes", label: "minutes" },
    { value: "hours", label: "hours" },
    { value: "days", label: "days" },
  ];

  const items = $derived<MenuEntry[]>(view ? [
    { type: "label", label: "Check in every" },
    ...checkInChoices(CHECK_IN_PRESET_MINUTES, current).map(ms => ({
      type: "radio" as const, id: `every-${ms}`, group: "every", label: everyLabel(ms), checked: current === ms,
      onselect: () => void set({ everyMs: ms }),
    })),
    { id: "every-custom", label: "Custom…", icon: "edit", onselect: customEvery },
    { type: "separator" },
    ...(paused
      ? [{ id: "resume", label: "Resume check-ins", icon: "play", onselect: () => void set({ pause: null }) }]
      : [
          { id: "pause-1h", label: "Pause for 1 hour", icon: "pause", onselect: () => void set({ pause: "1h" }) },
          { id: "pause-tomorrow", label: "Pause until 09:00", icon: "pause", onselect: () => void set({ pause: "tomorrow" }) },
          { id: "pause-forever", label: "Pause until I resume", icon: "pause", onselect: () => void set({ pause: "forever" }) },
        ]),
    { id: "pause-custom", label: paused ? "Change pause end…" : "Pause until…", icon: "clock", onselect: () => { custom = "pause"; } },
  ] : []);
</script>

<div class="checkin" data-on={status.on}>
  <div class="words">
    <span class="t-body-sm">{status.text}</span>
    {#if view && status.on}<span class="t-caption next">{nextLabel({ running: false, nextAt: view.nextAt }, now)}</span>{/if}
    {#if view?.lastAt}
      <span class="t-caption next" data-checkin-last>Last ran at {whenLabel(view.lastAt, now)}{#if view.job}{" in job "}<a href={hrefFor("agents", [view.job.id])}>{view.job.name}</a>{/if}.</span>
    {/if}
  </div>
  <Button size="sm" variant="outline" icon={paused ? "pause" : "clock"} trailingIcon="chevron-down" loading={busy} disabled={!view} bind:element={anchor}
    aria-label="Check-in settings" onclick={() => { open = !open; }}>{view ? checkInButton(view, now) : "Check-in"}</Button>
  <Menu bind:open {anchor} {items} placement="bottom-end" label="Check-in" />
</div>

<Dialog open={custom === "every"} title="Check in every" width={400} onclose={() => { custom = null; }}>
  <form id="checkin-every-form" class="every" onsubmit={saveEvery} aria-label="Custom check-in interval">
    <Input type="number" min="1" step="1" aria-label="How many" bind:value={amount} invalid={amountBad} data-autofocus />
    <Select label="Unit" bind:value={unit} options={units} />
  </form>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => { custom = null; }}>Cancel</Button>
    <Button variant="primary" type="submit" form="checkin-every-form" loading={busy} disabled={amountBad}>Save</Button>
  {/snippet}
</Dialog>

{#if custom === "pause"}
  <RemindDialog title="Pause check-ins until" at={view && typeof view.pausedUntil === "number" ? view.pausedUntil : undefined}
    onpick={async at => { await set({ pause: { until: at } }); }} onclose={() => { custom = null; }} />
{/if}

<style>
  .checkin { display: flex; align-items: center; gap: var(--space-3); justify-content: space-between; min-width: 0; }
  .words { display: grid; gap: 2px; min-width: 0; }
  .next { color: var(--text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-on="false"] .words { color: var(--text-subtle); }
  .every { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-items: center; }
</style>
