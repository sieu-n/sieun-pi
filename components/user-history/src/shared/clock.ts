/** "15:42" in the browser's own time zone, or "Oct 14 15:42" when the time is not today. */
export function clockText(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
