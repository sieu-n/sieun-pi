/**
 * Mark unread as the owner uses it: a post he cannot deal with yet stays on him until he handles it (#sw-factory-build p87 to p90, 11-20).
 * The room reads unread from the post as Slack's Mark unread leaves it (store.ts `readMark`), and the post sits in a Keep unread item in
 * Later (later.ts `keepUnread`) whose Remind me timer (later-due.ts) is set to the next 9:00 in Seoul. If he has not handled it by then,
 * the reminder marks the room unread from the post again, so the room goes bold, the New line comes back and Later's due badge counts it.
 * He handles it by replying to it, reacting to it, or checking it off in Later, and each one clears both.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Seoul is UTC+9 all year, with no daylight saving. */
const SEOUL = 9 * HOUR;
/** The owner's morning, 9:00 in Seoul. */
const MORNING = 9 * HOUR;

/** The next 9:00 in Seoul after `now`. */
export function nextMorning(now: number): number {
  const day = Math.floor((now + SEOUL) / DAY) * DAY - SEOUL;
  const today = day + MORNING;
  return today > now ? today : today + DAY;
}

interface Placed { id: string; seq: number; threadRoot?: string }

/**
 * Whether the owner's post `reply` answers the post he marked unread: a reply in its thread, or in the thread it sits in, or for a
 * top-level post any top-level post of his after it, as a DM answer is.
 */
export function answers(marked: Placed, reply: Placed): boolean {
  if (reply.threadRoot) return reply.threadRoot === (marked.threadRoot ?? marked.id);
  return !marked.threadRoot && reply.seq > marked.seq;
}
