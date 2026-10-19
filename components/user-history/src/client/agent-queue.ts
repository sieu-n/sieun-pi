import type { AgentQueuePool, PoolSetRecord, TurnHour } from "../shared/types.ts";

export const POOL_SILENT = "The pool did not answer. The queue is off until it does.";

const agents = (count: number): string => `${count} ${count === 1 ? "agent" : "agents"}`;

/** The one status line of Settings > This Mac > Agent queue: how many agents work and wait. */
export function statusLine(pool: AgentQueuePool): string {
  if (pool.state === "unread") return POOL_SILENT;
  if (!pool.enabled) return "The queue is off, so every agent starts at once.";
  return `${agents(pool.working.length)} working, ${pool.queued.length} waiting.`;
}

const KST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const kst = (ms: number): string => {
  const part = Object.fromEntries(KST.formatToParts(ms).map(p => [p.type, p.value]));
  return `${part.month}-${part.day} ${part.hour}:${part.minute} KST`;
};

/** Who last set the box's limit and when, from `pi-pool set`'s record; `fallback` is the default the limit holds with no record. */
export function setLine(value: number, record: PoolSetRecord | null, fallback: number): string {
  if (!record) return `The limit holds the default ${fallback}, and nobody has set it.`;
  if (!record.by) return `The limit was set to ${value} at ${kst(record.at)}, the file time of config.json, by a writer pi-pool did not record then.`;
  return `The limit was set to ${value} by ${record.by} at ${kst(record.at)}.`;
}

/** A wait in seconds as the chart's hover reads it. */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** The hours where a new local day starts, for the chart's day labels: index into `hours` and the "10-15" label. */
export function dayTicks(hours: TurnHour[]): Array<{ index: number; label: string }> {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours.flatMap((hour, index) => {
    const date = new Date(hour.at);
    return date.getHours() === 0 ? [{ index, label: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }] : [];
  });
}
