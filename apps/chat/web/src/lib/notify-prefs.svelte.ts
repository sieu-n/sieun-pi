/**
 * The owner's notification setting on this device, kept in localStorage `chat.notify` as Slack keeps its per-device desktop setting. A
 * settings page reads `notifyPrefs` and writes with `setNotifyPrefs`; the profile menu pauses with `pauseNotifications`.
 *
 * `level` picks which new posts raise a system notification (lib/notices.svelte.ts): `direct` for DMs, Solo rooms, mentions and replies to
 * him (Slack's default), `all` for every post in his rooms, `off` for none. `badge` puts the unread count on the Dock icon and in the window
 * title. `pausedUntil` holds notifications until that time; reminders still notify, as Slack's pause lets reminders through.
 */
import type { Ms } from "./api/types";

export type NotifyLevel = "all" | "direct" | "off";
export interface NotifyPrefs { level: NotifyLevel; badge: boolean; pausedUntil?: Ms }

const KEY = "chat.notify";
const DEFAULTS: NotifyPrefs = { level: "direct", badge: true };
const LEVELS: readonly NotifyLevel[] = ["all", "direct", "off"];

function read(): NotifyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotifyPrefs> | null;
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      level: LEVELS.includes(raw.level as NotifyLevel) ? (raw.level as NotifyLevel) : DEFAULTS.level,
      badge: typeof raw.badge === "boolean" ? raw.badge : DEFAULTS.badge,
      ...(typeof raw.pausedUntil === "number" && raw.pausedUntil > Date.now() ? { pausedUntil: raw.pausedUntil } : {}),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const notifyPrefs: NotifyPrefs = $state(read());

/** Whether this browser or the Mac app may show system notifications; `askNotifyPermission` (remind-notify.ts) asks and updates it. */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";
export const notifyPermission: { value: NotifyPermission } = $state({ value: "default" });

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  Object.assign(notifyPrefs, patch);
  if (notifyPrefs.pausedUntil === undefined) delete notifyPrefs.pausedUntil;
  try {
    localStorage.setItem(KEY, JSON.stringify($state.snapshot(notifyPrefs)));
  } catch {
    // A full or blocked localStorage keeps the setting for this page only.
  }
}

/** Pauses message notifications until `until`, or resumes them with null. */
export function pauseNotifications(until: Ms | null): void {
  setNotifyPrefs({ pausedUntil: until ?? undefined });
}

export function notificationsPaused(now: Ms = Date.now()): boolean {
  return notifyPrefs.pausedUntil !== undefined && notifyPrefs.pausedUntil > now;
}

if (typeof window !== "undefined") {
  // Another tab's change applies here too.
  window.addEventListener("storage", event => {
    if (event.key === KEY) Object.assign(notifyPrefs, { pausedUntil: undefined }, read());
  });
}
