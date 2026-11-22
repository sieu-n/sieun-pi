/**
 * Slack's `/remind me <what> <when>`: reads the text after /remind into the reminder's text and the time it is due, in the browser's local
 * time. The time goes last, as in "/remind me call the bank in 20 min" or "/remind me standup notes tomorrow 9am".
 */

const MINUTE = 60_000;
/** A day or weekday with no hour lands at 9:00 AM, Slack's own hour for Tomorrow. */
const MORNING = 9;
const UNITS: Record<string, number> = { m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE, h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE, d: 1440 * MINUTE, day: 1440 * MINUTE, days: 1440 * MINUTE, w: 10080 * MINUTE, week: 10080 * MINUTE, weeks: 10080 * MINUTE };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`;

export const REMIND_HELP = "Say what and when, such as /remind me call the bank in 20 min or /remind me standup notes tomorrow 9am";

export type RemindParse = { ok: true; text: string; at: number } | { ok: false; error: string };

/** Hours and minutes of a time such as 9am, 9:30 pm, 15:00, noon; null when it is no real time. */
function clock(raw: string): [number, number] | null {
  const t = raw.trim().toLowerCase();
  if (t === "noon") return [12, 0];
  if (t === "midnight") return [0, 0];
  const hit = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!hit) return null;
  let hour = Number(hit[1]);
  const minute = Number(hit[2] ?? 0);
  if (minute > 59 || hour > 23 || (hit[3] && (hour < 1 || hour > 12))) return null;
  if (hit[3] === "pm" && hour < 12) hour += 12;
  if (hit[3] === "am" && hour === 12) hour = 0;
  return [hour, minute];
}

function on(now: number, days: number, [hour, minute]: [number, number]): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** When the end of `args` says, and the text before it. */
function when(args: string, now: number): { rest: string; at: number } | null {
  const tail = (pattern: string) => new RegExp(String.raw`^(.*?)\s*\b${pattern}\s*$`, "i").exec(args);
  let hit = tail(String.raw`in\s+(\d+|an?|one)\s*([a-z]+)`);
  if (hit) {
    const unit = UNITS[hit[3]!.toLowerCase()];
    const count = /^\d+$/.test(hit[2]!) ? Number(hit[2]) : 1;
    return unit && count > 0 ? { rest: hit[1]!, at: now + count * unit } : null;
  }
  hit = tail(String.raw`(today|tonight|tomorrow)(?:\s+(?:at\s+)?${TIME})?`) ?? tail(String.raw`(?:at\s+)?${TIME}\s+(today|tonight|tomorrow)`);
  if (hit) {
    const [day, time] = /^(today|tonight|tomorrow)$/i.test(hit[2]!) ? [hit[2]!, hit[3]] : [hit[3]!, hit[2]];
    const t = time ? clock(time) : day.toLowerCase() === "tonight" ? ([20, 0] as [number, number]) : ([MORNING, 0] as [number, number]);
    return t ? { rest: hit[1]!, at: on(now, day.toLowerCase() === "tomorrow" ? 1 : 0, t) } : null;
  }
  hit = tail(String.raw`(?:on\s+)?(${DAYS.join("|")})(?:\s+(?:at\s+)?${TIME})?`);
  if (hit) {
    const t = hit[3] ? clock(hit[3]) : ([MORNING, 0] as [number, number]);
    const ahead = (DAYS.indexOf(hit[2]!.toLowerCase()) - new Date(now).getDay() + 7) % 7 || 7;
    return t ? { rest: hit[1]!, at: on(now, ahead, t) } : null;
  }
  hit = tail(String.raw`at\s+${TIME}`);
  if (hit) {
    const t = clock(hit[2]!);
    if (!t) return null;
    const today = on(now, 0, t);
    return { rest: hit[1]!, at: today > now ? today : on(now, 1, t) };
  }
  return null;
}

/** Reads `/remind`'s arguments: `me` and `to` up front are dropped, the time goes last, and a time already past is refused. */
export function parseRemind(args: string, now = Date.now()): RemindParse {
  const body = args.trim().replace(/^me\b\s*/i, "");
  const due = when(body, now);
  if (!due) return { ok: false, error: REMIND_HELP };
  const text = due.rest.replace(/^to\b\s*/i, "").replace(/[\s,]+$/, "").trim();
  if (!text) return { ok: false, error: REMIND_HELP };
  if (due.at <= now) return { ok: false, error: "That time has passed. Pick a time ahead, such as in 20 min." };
  return { ok: true, text, at: due.at };
}
