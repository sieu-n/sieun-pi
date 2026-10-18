import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";
import { CHAT_CHECK_IN_LINE } from "./shared/chat-feed.ts";
import { CHECK_IN_MIN_MINUTES, type CheckInPause } from "./shared/types.ts";

/** A chat's check-in setting: its interval, its pause and who set them, read and written through `<data dir>/check-in-settings.json`, and the clock words its lines use. */

/**
 * How often a chat's check-in runs unless the owner set another interval (CheckInSetting), and the shortest interval an agent may set
 * (`changeCheckIn`). On 10-15 seven of 11 chats ran their check-in every 10 to 60 min, and the owner, on Crawler VP's 15 min check-ins, said
 * "the threads behaved nicer back in the day".
 */
export const CHECK_IN_MS = 120 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A chat's check-in choices: its interval, and a pause until a time or until resumed, with who paused it (`pausedBy`) and which one (`setter`).
 * An `owner` pause with no setter stays the owner's.
 */
export type CheckInPausedUntil = number | "forever";
export type CheckInBy = "owner" | "agent";
export interface CheckInSetting { everyMs: number; pausedUntil?: CheckInPausedUntil; pausedBy?: CheckInBy; setter?: string; startAt?: number }
/**
 * Who changes a check-in. Only the owner's own page is the owner (`setter` "ui"); the chat through chat_board `check_in` and any other caller of
 * the chat server's API are agents, with their session id as `setter` ("unknown" when the caller did not name itself).
 */
export type CheckInActor = { by: "owner"; setter: "ui" } | { by: "agent"; setter: string };
export const OWNER_UI: CheckInActor = { by: "owner", setter: "ui" };
export const UNKNOWN_AGENT = "unknown";
/** A change the rules refuse; the chat server answers it with 409. */
export class CheckInRefused extends Error {
  readonly status = 409;
}
export const DEFAULT_CHECK_IN: CheckInSetting = { everyMs: CHECK_IN_MS };

/** An interval the owner may set: whole minutes, 1 or more. */
export const validCheckInEvery = (ms: unknown): ms is number =>
  typeof ms === "number" && Number.isSafeInteger(ms) && ms % 60_000 === 0 && ms >= CHECK_IN_MIN_MINUTES * 60_000;

/** When a pause the owner picks at `now` ends: in an hour, at the next 09:00 local time, or never. */
export function pauseEnd(pause: CheckInPause, now: number): CheckInPausedUntil {
  if (pause === "forever") return "forever";
  if (pause === "1h") return now + 60 * 60_000;
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= now) nine.setDate(nine.getDate() + 1);
  return nine.getTime();
}

/** The pause still in force at `now`; an expired one is no pause. */
export const activePause = (setting: CheckInSetting, now: number): CheckInPausedUntil | null =>
  setting.pausedUntil === "forever" || (setting.pausedUntil !== undefined && setting.pausedUntil > now) ? setting.pausedUntil : null;

/** When the chat's next check-in runs, given its last one: never while paused until resumed, not before a pause ends. Due when it is not after `now`. */
export function nextCheckIn(setting: CheckInSetting, lastAt: number, now: number): number | null {
  const pause = activePause(setting, now);
  if (pause === "forever") return null;
  return Math.max(lastAt + setting.everyMs, pause ?? 0, setting.startAt ?? 0);
}

/** A time as the owner's local "YYYY-MM-DD HH:MM". */
export const localTime = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** A time as the owner's local "HH:MM", for a notice about one event today. */
export const clockTime = (at: number): string => localTime(at).slice(11);
/** The line the chat_board tool shows the chat about its own check-in. */
export function checkInLine(setting: CheckInSetting, now: number): string {
  const pause = activePause(setting, now);
  if (pause === "forever") {
    if (setting.pausedBy === "agent") return `Check-in: paused by agent ${setting.setter ?? UNKNOWN_AGENT} until resumed; check_in {pause: null} resumes it`;
    return "Check-in: paused until the owner resumes it";
  }
  if (pause !== null) return `Check-in: paused until ${localTime(pause)}`;
  return `Check-in: every ${setting.everyMs / 60_000} min`;
}

/** What the owner's page or an agent (the chat server's API, or the chat through chat_board `check_in`) changes: the interval, and a pause (null resumes). */
export interface CheckInChange { everyMs?: number; pause?: CheckInPause | null }

/**
 * A change applied to a chat's setting at `now`. Whoever writes later wins, with one limit: an agent cannot pause or resume over a pause in
 * force that the owner made (the refusal says why). An agent keeps the interval at CHECK_IN_MS or more by its brief and
 * the chat_board tool text, not by a refusal here (c81). A pause with no author counts as the owner's. An agent's pause, the chat's own or another session's, any agent may change.
 */
export function changeCheckIn(current: CheckInSetting, change: CheckInChange, now: number, actor: CheckInActor): { setting: CheckInSetting } | { refused: string } {
  const pause = activePause(current, now);
  if (actor.by === "agent" && change.pause !== undefined && pause !== null && current.pausedBy !== "agent") {
    return { refused: `the owner paused check-ins ${pause === "forever" ? "until they resume them" : `until ${localTime(pause)}`}; that stays` };
  }
  const everyMs = change.everyMs ?? current.everyMs;
  if (change.pause === undefined) {
    return { setting: { everyMs, ...(pause !== null ? { pausedUntil: pause, ...(current.pausedBy ? { pausedBy: current.pausedBy } : {}), ...(current.setter ? { setter: current.setter } : {}) } : {}),
      ...(current.startAt !== undefined ? { startAt: current.startAt } : {}) } };
  }
  if (change.pause === null) return { setting: { everyMs } };
  return { setting: { everyMs, pausedUntil: pauseEnd(change.pause, now), pausedBy: actor.by, setter: actor.setter } };
}

/** The chat_board `check_in` argument, parsed: `pause` "1h", "tomorrow" or null (resume), `every_minutes` a whole number, 1 or more. Throws on anything else. */
export function parseChatCheckIn(value: unknown): CheckInChange {
  if (!isRecord(value)) throw new Error("check_in: give {pause} and/or {every_minutes}");
  const change: CheckInChange = {};
  if ("pause" in value) {
    if (value.pause !== null && value.pause !== "1h" && value.pause !== "tomorrow") throw new Error('check_in.pause: "1h", "tomorrow" (09:00) or null to resume');
    change.pause = value.pause;
  }
  if ("every_minutes" in value) {
    const everyMs = typeof value.every_minutes === "number" ? value.every_minutes * 60_000 : NaN;
    if (!validCheckInEvery(everyMs)) throw new Error(`check_in.every_minutes: a whole number, ${CHECK_IN_MIN_MINUTES} or more`);
    change.everyMs = everyMs;
  }
  if (change.pause === undefined && change.everyMs === undefined) throw new Error("check_in: give {pause} and/or {every_minutes}");
  return change;
}

/**
 * The chat's own change to its check-in, written to the owner's setting store under its lock: the line the tool returns first (the feed
 * shows it as a quiet line), or an error with the refusal.
 */
export async function chatCheckIn(settings: CheckInSettings, id: string, change: CheckInChange, now: number): Promise<string> {
  let refused: string | undefined;
  const setting = await settings.update(id, current => {
    const result = changeCheckIn(current, change, now, { by: "agent", setter: id });
    if ("refused" in result) { refused = result.refused; return current; }
    return result.setting;
  });
  if (refused) throw new Error(`check_in refused: ${refused}`);
  const pause = activePause(setting, now);
  const what = change.pause === undefined ? `every ${setting.everyMs / 60_000} min` : pause === null ? `resumed, every ${setting.everyMs / 60_000} min`
    : `paused until ${pause === "forever" ? "the owner resumes it" : localTime(pause)}${change.everyMs !== undefined ? `, then every ${setting.everyMs / 60_000} min` : ""}`;
  return CHAT_CHECK_IN_LINE + what;
}

/**
 * `<data dir>/check-in-settings.json`: `{ [chatId]: CheckInSetting }` through locked-json. The owner's page and other agents write it through the
 * chat server, the chat through chat_board `check_in`.
 */
export interface CheckInSettings {
  all(): Promise<Record<string, CheckInSetting>>;
  get(id: string): Promise<CheckInSetting>;
  update(id: string, change: (setting: CheckInSetting) => CheckInSetting): Promise<CheckInSetting>;
}
function parseSetting(value: unknown): CheckInSetting | undefined {
  if (!isRecord(value) || !validCheckInEvery(value.everyMs)) return undefined;
  const until = value.pausedUntil;
  const pausedUntil = until === "forever" || (typeof until === "number" && Number.isFinite(until)) ? until : undefined;
  const pausedBy = value.pausedBy === "owner" || value.pausedBy === "agent" ? value.pausedBy : undefined;
  const setter = typeof value.setter === "string" && value.setter !== "" ? value.setter : undefined;
  const startAt = typeof value.startAt === "number" && Number.isFinite(value.startAt) ? value.startAt : undefined;
  return { everyMs: value.everyMs, ...(pausedUntil !== undefined ? { pausedUntil, ...(pausedBy ? { pausedBy } : {}), ...(setter ? { setter } : {}) } : {}),
    ...(startAt !== undefined ? { startAt } : {}) };
}
export function checkInSettings(path: string): CheckInSettings {
  const file: JsonFile<Record<string, CheckInSetting>> = { path, label: "Check-in settings", initial: () => ({}), parse(value: unknown) {
    return Object.fromEntries(Object.entries(isRecord(value) ? value : {}).flatMap(([id, entry]) => { const parsed = parseSetting(entry); return parsed ? [[id, parsed]] : []; }));
  } };
  return {
    all: () => snapshotJsonFile(file),
    async get(id) { return (await snapshotJsonFile(file))[id] ?? DEFAULT_CHECK_IN; },
    async update(id, change) {
      const { result } = await transactJsonFile(file, state => (state[id] = change(state[id] ?? DEFAULT_CHECK_IN)));
      return result;
    },
  };
}
