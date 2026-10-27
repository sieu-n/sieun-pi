import { ownerPause } from "./chat-recovery.ts";
import { activePause, type CheckInSetting, DEFAULT_CHECK_IN, planCheckIn } from "./checkin-settings.ts";

/**
 * A check-in reads late once this many of its intervals passed since its last run. The owner asked "check in system working normally?" on 10-28
 * (msg mvqzy9rn), and his audit brief named 1.5 intervals as overdue; one scheduler tick past an interval is on time.
 */
export const LATE_INTERVALS = 1.5;

/**
 * Where one chat's check-in stands: on time, late with no reason the files give, paused by the owner or by the chat itself, or stopped
 * because the thread is no longer a chat this service schedules. `lastAt` is its newest check-in on record, null when it has none.
 */
export type CheckInStanding =
  | { chat: string; state: "on_time" | "late"; everyMs: number; lastAt: number | null }
  | { chat: string; state: "paused"; by: "owner" | "chat"; until: number | "forever"; lastAt: number | null }
  | { chat: string; state: "stopped"; why: string; lastAt: number | null };

/** What `checkInStandings` reads: the chat list, the archived and clean-room lists, and per thread with a duties file its newest check-in. */
export interface CheckInScheduleInput {
  now: number;
  chats: ReadonlySet<string>;
  archived: ReadonlySet<string>;
  cleanRoom: ReadonlySet<string>;
  /** Every thread with a check-in state in its duties file, and that state's newest run, the later of `checkIn.lastRunAt` and its newest record. */
  recorded: ReadonlyMap<string, number | null>;
  settings: Readonly<Record<string, CheckInSetting>>;
  /** Whether each chat's plan has an open step; a chat missing here counts as open, as the scheduler counts a board it cannot read. */
  planOpen: ReadonlyMap<string, boolean>;
}

/**
 * Each check-in's standing, as the scheduler runs it (`Chats.tick`): only a chat in chats.json gets one, at `planCheckIn`'s interval. A thread
 * that left the chat list keeps its duties file, and its check-in stops on purpose: on 10-27 a reading of the duties files alone counted the
 * clean-room chat 01a14d38 (archived by its teardown on 10-18) and the 10-12 chat 01a12dfd (gone from the daemon) as daily check-ins 9.6 and
 * 15.6 days late. An archived chat stops by design and is left out.
 */
export function checkInStandings(input: CheckInScheduleInput): CheckInStanding[] {
  const standings: CheckInStanding[] = [];
  for (const chat of input.chats) {
    const own = input.settings[chat] ?? DEFAULT_CHECK_IN;
    const lastAt = input.recorded.get(chat) ?? null;
    const until = activePause(own, input.now);
    if (until !== null) { standings.push({ chat, state: "paused", by: ownerPause(own) ? "owner" : "chat", until, lastAt }); continue; }
    const { everyMs, startAt } = planCheckIn(own, input.planOpen.get(chat) ?? true);
    const from = Math.max(lastAt ?? -Infinity, startAt ?? -Infinity);
    standings.push({ chat, state: input.now - from > LATE_INTERVALS * everyMs ? "late" : "on_time", everyMs, lastAt });
  }
  for (const [chat, lastAt] of input.recorded) {
    if (input.chats.has(chat) || input.archived.has(chat)) continue;
    const why = input.cleanRoom.has(chat) ? "it is a clean-room test chat, which its run's teardown took out of the chat list"
      : "it is no longer in the chat list (chats.json), which drops a chat whose session the daemon no longer lists";
    standings.push({ chat, state: "stopped", why, lastAt });
  }
  return standings;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;
const when = (at: number | null, now: number): string => at === null ? "no check-in on record" : `last check-in ${new Date(at).toISOString().slice(0, 16)}Z, ${minutes(now - at)} ago`;

/** One standing as the Chat system duty's detail lists it, with the chat's title from `name`. */
export function checkInStandingLine(standing: CheckInStanding, name: string, now: number): string {
  switch (standing.state) {
    case "on_time": return `${name}: every ${minutes(standing.everyMs)}, ${when(standing.lastAt, now)}, on time`;
    case "late": return `${name}: every ${minutes(standing.everyMs)}, ${when(standing.lastAt, now)}, more than ${LATE_INTERVALS} intervals late with no pause or stop on record`;
    case "paused": return `${name}: paused by the ${standing.by} ${standing.until === "forever" ? "until resumed" : `until ${new Date(standing.until).toISOString().slice(0, 16)}Z`}, ${when(standing.lastAt, now)}`;
    case "stopped": return `${name} (${standing.chat}): stopped on purpose, ${when(standing.lastAt, now)}, since ${standing.why}`;
  }
}
