/**
 * The owner's own settings that follow him across browsers and the Mac app: his status and away flag, his notification setting and his
 * recent searches. The server keeps them in state.json under `ownerSettings` (server/owner-settings.ts), and every page reads and writes
 * them through lib/owner-settings.svelte.ts. Both sides parse with the functions here.
 */
import type { Ms } from "../types.ts";

/** A custom status as Slack keeps one: an emoji, a short text and an optional time it clears itself. */
export type OwnerStatus = { emoji: string; text: string; until?: Ms };
export type Presence = { status?: OwnerStatus; away: boolean };

/**
 * Which new posts raise a system notification (lib/notices.svelte.ts): `direct` for DMs, Solo rooms, mentions and replies to him (Slack's
 * default), `all` for every post in his rooms, `off` for none.
 */
export type NotifyLevel = "all" | "direct" | "off";
/** `badge` puts the unread count on the Dock icon and in the title; `pausedUntil` holds notifications until then, reminders aside. */
export interface NotifyPrefs { level: NotifyLevel; badge: boolean; pausedUntil?: Ms }

/** One recent search as its words and its filters in URL form (pages/search/filters.ts `filterParams`). */
export type RecentSearchEntry = { q: string; filters: Partial<Record<string, string>> };

export interface OwnerSettings {
  presence: Presence;
  notify: NotifyPrefs;
  /** Newest first. */
  recentSearches: RecentSearchEntry[];
}
export type SettingsPart = keyof OwnerSettings;

/** The settings as the server keeps and sends them; `rev` counts its saves, and `edited` says when each part was last set by hand. */
export type SavedSettings = OwnerSettings & { rev: number; edited: Partial<Record<SettingsPart, Ms>> };

export const NOTIFY_DEFAULTS: NotifyPrefs = { level: "direct", badge: true };
const LEVELS: readonly NotifyLevel[] = ["all", "direct", "off"];
/** The Cmd K dialog lists 5; a few more are kept so removing some still leaves a full list. */
export const RECENT_KEPT = 10;

export const defaultSettings = (): SavedSettings => ({ presence: { away: false }, notify: { ...NOTIFY_DEFAULTS }, recentSearches: [], rev: 0, edited: {} });

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseStatus(raw: unknown, now: Ms = Date.now()): OwnerStatus | undefined {
  const r = record(raw);
  if (!r) return undefined;
  const { emoji, text, until } = r;
  if (typeof emoji !== "string" || typeof text !== "string" || (!emoji && !text)) return undefined;
  if (until !== undefined && (typeof until !== "number" || until <= now)) return undefined;
  return { emoji, text, ...(typeof until === "number" ? { until } : {}) };
}

export function parsePresence(raw: unknown, now: Ms = Date.now()): Presence {
  const r = record(raw);
  const status = parseStatus(r?.status, now);
  return { away: r?.away === true, ...(status ? { status } : {}) };
}

export function parseNotify(raw: unknown, now: Ms = Date.now()): NotifyPrefs {
  const r = record(raw);
  if (!r) return { ...NOTIFY_DEFAULTS };
  return {
    level: LEVELS.includes(r.level as NotifyLevel) ? (r.level as NotifyLevel) : NOTIFY_DEFAULTS.level,
    badge: typeof r.badge === "boolean" ? r.badge : NOTIFY_DEFAULTS.badge,
    ...(typeof r.pausedUntil === "number" && r.pausedUntil > now ? { pausedUntil: r.pausedUntil } : {}),
  };
}

/** One key per distinct search: its words in lower case and its filters in a fixed order. */
export const recentEntryKey = (entry: RecentSearchEntry): string =>
  JSON.stringify([entry.q.trim().toLowerCase(), Object.entries(entry.filters).sort(([a], [b]) => a.localeCompare(b))]);

export function parseRecent(raw: unknown): RecentSearchEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentSearchEntry[] = [];
  for (const item of raw) {
    const r = record(item);
    if (!r || typeof r.q !== "string") continue;
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(r.filters) ?? {})) if (typeof value === "string" && value) filters[key] = value;
    const entry = { q: r.q.trim(), filters };
    const key = recentEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === RECENT_KEPT) break;
  }
  return out;
}

const PARTS: readonly SettingsPart[] = ["presence", "notify", "recentSearches"];

/** Reads a PATCH body or a browser's old copies: only the parts it names, each parsed whole. */
export function parseParts(raw: unknown, now: Ms = Date.now()): Partial<OwnerSettings> {
  const r = record(raw) ?? {};
  const out: Partial<OwnerSettings> = {};
  for (const part of PARTS) {
    if (!(part in r)) continue;
    if (part === "presence") out.presence = parsePresence(r.presence, now);
    else if (part === "notify") out.notify = parseNotify(r.notify, now);
    else out.recentSearches = parseRecent(r.recentSearches);
  }
  return out;
}

/** Reads state.json's copy, dropping a status or pause that ran out while the server was down. */
export function parseSaved(raw: unknown, now: Ms = Date.now()): SavedSettings {
  const r = record(raw);
  if (!r) return defaultSettings();
  const edited: Partial<Record<SettingsPart, Ms>> = {};
  for (const part of PARTS) {
    const at = record(r.edited)?.[part];
    if (typeof at === "number") edited[part] = at;
  }
  return {
    presence: parsePresence(r.presence, now),
    notify: parseNotify(r.notify, now),
    recentSearches: parseRecent(r.recentSearches),
    rev: typeof r.rev === "number" ? r.rev : 0,
    edited,
  };
}

/**
 * Merges what one browser kept in localStorage before the server held these settings. The old copies carry no time, so a part the owner
 * set by hand since the move (`edited`) is newer and stays. Otherwise a value he set wins over a default: a status or away from either side,
 * a level or badge off its default, the later pause. Recent searches always merge, the server's first, so no search is lost.
 */
export function mergeOld(saved: OwnerSettings & { edited: Partial<Record<SettingsPart, Ms>> }, old: Partial<OwnerSettings>): OwnerSettings {
  let { presence, notify } = saved;
  if (old.presence && saved.edited.presence === undefined) {
    const status = presence.status ?? old.presence.status;
    presence = { away: presence.away || old.presence.away, ...(status ? { status } : {}) };
  }
  if (old.notify && saved.edited.notify === undefined) {
    const pausedUntil = Math.max(notify.pausedUntil ?? 0, old.notify.pausedUntil ?? 0) || undefined;
    notify = {
      level: notify.level !== NOTIFY_DEFAULTS.level ? notify.level : old.notify.level,
      badge: notify.badge !== NOTIFY_DEFAULTS.badge ? notify.badge : old.notify.badge,
      ...(pausedUntil ? { pausedUntil } : {}),
    };
  }
  const recentSearches = parseRecent([...saved.recentSearches, ...(old.recentSearches ?? [])]);
  return { presence, notify, recentSearches };
}
