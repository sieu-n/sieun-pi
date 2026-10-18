import type { AgentQueuePool, AgentQueueView, PoolSetRecord, TurnHour } from "../shared/types.ts";
import { POOL_DEFAULTS } from "./pool-config.ts";

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

/** Who last set a pool limit and when, from `pi-pool set`'s record; `fallback` is the default the limit holds with no record. */
export function setLine(value: number, record: PoolSetRecord | null, fallback: number): string {
  if (!record) return `The Mac limit holds the default ${fallback}, and nobody has set it.`;
  if (!record.by) return `The Mac limit was set to ${value} at ${kst(record.at)}, the file time of config.json, by a writer pi-pool did not record then.`;
  return `The Mac limit was set to ${value} by ${record.by} at ${kst(record.at)}.`;
}

/** Everything behind "Why these numbers": the live reading, who set the limit, and the measurements behind each default. */
export function whyLines(view: AgentQueueView): string[] {
  const pool = view.pool.state === "read" ? view.pool : null;
  return [
    ...pool ? [setLine(pool.workingMax, pool.workingMaxSet, POOL_DEFAULTS.working_max)] : [],
    "Your own messages and prod work never wait in the queue.",
    `The default Mac limit of ${POOL_DEFAULTS.working_max} comes from 10-14 07:38 KST, when 6.9 GB was free and a p90 working session used 426 MB.`,
    `The default of ${POOL_DEFAULTS.tree_working_max} per chat is half of ${POOL_DEFAULTS.working_max}, so two chats at full fan-out fit. VP of CI held 7 working sessions at once on 10-14.`,
    `The median turn ran 18.1 s over 27,578 turns in the 4 days to 10-14 08 KST, so with a ${POOL_DEFAULTS.queue_aging_s} s step a low turn passes a fresh normal one after about one turn.`,
    "Inside one turn, gaps between model calls were 157 s at p99 and 1,508 s at p99.9 over 174,119 gaps in the 3 days to 10-14 08 KST. A slot quiet for longer belongs to a turn that ended with no release.",
    "90 min is the daemon's own idle unload default. 10 timed reloads on 10-13 took 1.1 to 6.2 s, and the daemon rereads the setting within 5 minutes with no restart.",
    "Pinned chats stay loaded until the harness VP's detach fix lands, so the idle unload covers idle jobs and threads only.",
    "The chart counts turn_released lines in pi-pool.log per hour. Its median wait leaves out owner and prod turns, which never wait.",
  ];
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
