/**
 * The owner's status and away flag on this device, kept in localStorage `chat.presence` as Slack keeps a custom status: an emoji, a short
 * text and an optional time it clears itself. The profile menu in lib/shell/TopBar.svelte sets both, and a settings page can import them.
 * Pausing notifications lives in lib/notify-prefs.svelte.ts.
 */
import type { Ms } from "./api/types";

export type OwnerStatus = { emoji: string; text: string; until?: Ms };
export type Presence = { status?: OwnerStatus; away: boolean };

const KEY = "chat.presence";

function parseStatus(raw: unknown): OwnerStatus | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { emoji, text, until } = raw as Record<string, unknown>;
  if (typeof emoji !== "string" || typeof text !== "string" || (!emoji && !text)) return undefined;
  if (until !== undefined && (typeof until !== "number" || until <= Date.now())) return undefined;
  return { emoji, text, ...(typeof until === "number" ? { until } : {}) };
}

function read(): Presence {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    const status = parseStatus(raw?.status);
    return { away: raw?.away === true, ...(status ? { status } : {}) };
  } catch {
    return { away: false };
  }
}

export const presence: Presence = $state(read());

let clearTimer: ReturnType<typeof setTimeout> | undefined;

function save(): void {
  clearTimeout(clearTimer);
  const until = presence.status?.until;
  // setTimeout fires at once past 2^31 - 1 ms, so a status set for longer than 24 days waits for the next load to clear.
  if (until !== undefined && until - Date.now() < 2 ** 31 - 1) clearTimer = setTimeout(() => setStatus(null), Math.max(0, until - Date.now()));
  try {
    localStorage.setItem(KEY, JSON.stringify($state.snapshot(presence)));
  } catch {
    // A full or blocked localStorage keeps the status for this page only.
  }
}

/** Sets the status, or clears it with null. */
export function setStatus(status: OwnerStatus | null): void {
  if (status) presence.status = status;
  else delete presence.status;
  save();
}

export function setAway(away: boolean): void {
  presence.away = away;
  save();
}

if (typeof window !== "undefined") {
  save();
  // Another tab's change applies here too.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    const next = read();
    presence.away = next.away;
    if (next.status) presence.status = next.status;
    else delete presence.status;
  });
}
