/**
 * The owner's notification setting, kept on the server so every browser and the Mac app follow the same one (lib/owner-settings.svelte.ts).
 * A settings page reads `notifyPrefs` and writes with `setNotifyPrefs`; the profile menu pauses with `pauseNotifications`.
 *
 * `level` picks which new posts raise a system notification (lib/notices.svelte.ts): `direct` for DMs, Solo rooms, mentions and replies to
 * him (Slack's default), `all` for every post in his rooms, `off` for none. `badge` puts the unread count on the Dock icon and in the window
 * title. `pausedUntil` holds notifications until that time; reminders still notify, as Slack's pause lets reminders through.
 */
import type { Ms } from "./api/types";
import type { NotifyLevel, NotifyPrefs } from "./api/shared/owner-settings";
import { ownerSettings } from "./owner-settings.svelte";

export type { NotifyLevel, NotifyPrefs };

export const notifyPrefs: Readonly<NotifyPrefs> = {
  get level() {
    return ownerSettings.value.notify.level;
  },
  get badge() {
    return ownerSettings.value.notify.badge;
  },
  get pausedUntil() {
    return ownerSettings.value.notify.pausedUntil;
  },
};

/** Whether this browser or the Mac app may show system notifications; `askNotifyPermission` (remind-notify.ts) asks and updates it. */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";
export const notifyPermission: { value: NotifyPermission } = $state({ value: "default" });

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  const { pausedUntil, ...rest } = { ...ownerSettings.value.notify, ...patch };
  ownerSettings.set({ notify: { ...rest, ...(pausedUntil !== undefined ? { pausedUntil } : {}) } });
}

/** Pauses message notifications until `until`, or resumes them with null. */
export function pauseNotifications(until: Ms | null): void {
  setNotifyPrefs({ pausedUntil: until ?? undefined });
}

export function notificationsPaused(now: Ms = Date.now()): boolean {
  return notifyPrefs.pausedUntil !== undefined && notifyPrefs.pausedUntil > now;
}
