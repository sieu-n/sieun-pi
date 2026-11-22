/**
 * The owner's status and away flag, kept on the server so every browser and the Mac app show the same (lib/owner-settings.svelte.ts), as
 * Slack keeps a custom status: an emoji, a short text and an optional time it clears itself. The profile menu in lib/shell/TopBar.svelte
 * sets both, and a settings page can import them. Pausing notifications lives in lib/notify-prefs.svelte.ts.
 */
import type { OwnerStatus, Presence } from "./api/shared/owner-settings";
import { ownerSettings } from "./owner-settings.svelte";

export type { OwnerStatus, Presence };

/** Moves when a status's clear time comes, so a status that ran out stops showing without anyone writing. */
const clock = $state({ now: Date.now() });
let armed: number | undefined;

/** Moves the clock at `until`; setTimeout fires at once past 2^31 - 1 ms, so a status set for longer than 24 days clears on a later load. */
function arm(until: number): void {
  if (armed === until || until - Date.now() >= 2 ** 31 - 1) return;
  armed = until;
  setTimeout(() => (clock.now = Date.now()), Math.max(0, until - Date.now()));
}

/** The status and away flag as this page shows them; a status past its `until` reads as none. */
export const presence: Readonly<Presence> = {
  get status() {
    const status = ownerSettings.value.presence.status;
    if (status?.until !== undefined && status.until > clock.now) arm(status.until);
    return status && (status.until === undefined || status.until > clock.now) ? status : undefined;
  },
  get away() {
    return ownerSettings.value.presence.away;
  },
};

/** Sets the status, or clears it with null. */
export function setStatus(status: OwnerStatus | null): void {
  const { away } = ownerSettings.value.presence;
  ownerSettings.set({ presence: { away, ...(status ? { status } : {}) } });
}

export function setAway(away: boolean): void {
  const { status } = ownerSettings.value.presence;
  ownerSettings.set({ presence: { away, ...(status ? { status } : {}) } });
}
