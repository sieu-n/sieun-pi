<script lang="ts">
  import { api, type CheckInPause, type CheckInView } from "$lib/api";
  import { CHECK_IN_PRESET_MINUTES } from "$lib/api/shared/types";
  import { Button, Menu, toast, type MenuEntry } from "$lib/ui";
  import { checkInButton, checkInChoices, checkInStatus, everyLabel, nextLabel, pauseNow } from "./schedule";

  let { chatId, view = $bindable(), now }: { chatId: string; view: CheckInView | null; now: number } = $props();

  let open = $state(false);
  let anchor = $state<HTMLElement>();
  let busy = $state(false);

  const status = $derived(checkInStatus(view, now));
  const paused = $derived(view ? pauseNow(view, now) !== null : false);

  async function set(change: { everyMs?: number; pause?: CheckInPause | null }) {
    busy = true;
    try {
      view = await api.setCheckIn(chatId, change);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The check-in did not change.");
    } finally {
      busy = false;
    }
  }

  const items = $derived<MenuEntry[]>(view ? [
    { type: "label", label: "Check in every" },
    ...checkInChoices(CHECK_IN_PRESET_MINUTES, view.planEveryMs ?? view.everyMs).map(ms => ({
      type: "radio" as const, id: `every-${ms}`, group: "every", label: everyLabel(ms), checked: (view!.planEveryMs ?? view!.everyMs) === ms,
      onselect: () => void set({ everyMs: ms }),
    })),
    { type: "separator" },
    ...(paused
      ? [{ id: "resume", label: "Resume check-ins", icon: "play", onselect: () => void set({ pause: null }) }]
      : [
          { id: "pause-1h", label: "Pause for 1 hour", icon: "pause", onselect: () => void set({ pause: "1h" }) },
          { id: "pause-tomorrow", label: "Pause until 09:00", icon: "pause", onselect: () => void set({ pause: "tomorrow" }) },
          { id: "pause-forever", label: "Pause until I resume", icon: "pause", onselect: () => void set({ pause: "forever" }) },
        ]),
  ] : []);
</script>

<div class="checkin" data-on={status.on}>
  <div class="words">
    <span class="t-body-sm">{status.text}</span>
    {#if view && status.on}<span class="t-caption next">{nextLabel({ running: false, nextAt: view.nextAt }, now)}</span>{/if}
  </div>
  <Button size="sm" variant="outline" icon={paused ? "pause" : "clock"} trailingIcon="chevron-down" loading={busy} disabled={!view} bind:element={anchor}
    aria-label="Check-in settings" onclick={() => { open = !open; }}>{view ? checkInButton(view, now) : "Check-in"}</Button>
  <Menu bind:open {anchor} {items} placement="bottom-end" label="Check-in" />
</div>

<style>
  .checkin { display: flex; align-items: center; gap: var(--space-3); justify-content: space-between; min-width: 0; }
  .words { display: grid; gap: 2px; min-width: 0; }
  .next { color: var(--text-subtle); }
  [data-on="false"] .words { color: var(--text-subtle); }
</style>
