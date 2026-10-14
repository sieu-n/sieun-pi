import type { AgentQueueGovernor, AgentQueuePool, PoolSetRecord, PressureChange, PressureReading } from "../shared/types.ts";
import { duration } from "./format.ts";

export const POOL_SILENT = "The pool did not answer. The queue is off until it does.";

/** The live line of Settings > This Mac > Agent queue: how many turns work and wait, and which one goes next. */
export function queueLine(pool: AgentQueuePool): string {
  if (pool.state === "unread") return POOL_SILENT;
  if (!pool.enabled) return "The queue is off, so every turn starts at once.";
  const head = `${pool.working.length} working, ${pool.queued.length} queued.`;
  const next = pool.queued[0];
  if (!next) return head;
  const name = pool.nextTitle ?? next.session.slice(0, 8);
  const kind = next.basePriority === next.priority ? `a ${next.priority} turn` : `a ${next.basePriority} turn moved up to ${next.priority}`;
  return `${head} Next: ${name}, ${kind}, queued for ${duration(next.waitMs)}.`;
}

const KST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const kst = (ms: number): string => {
  const part = Object.fromEntries(KST.formatToParts(ms).map(p => [p.type, p.value]));
  return `${part.month}-${part.day} ${part.hour}:${part.minute} KST`;
};

/** Who last set a pool limit and when, from `pi-pool set`'s record; `fallback` is the default the limit holds with no record. */
export function setLine(value: number, record: PoolSetRecord | null, fallback: number): string {
  if (!record) return `Holds the default ${fallback}; nobody has set it.`;
  if (!record.by) return `Set to ${value} at ${kst(record.at)}, the file time of config.json, by a writer pi-pool did not record then.`;
  return `Set to ${value} by ${record.by} at ${kst(record.at)}.`;
}

const KERNEL: Readonly<Record<number, string>> = { 1: "normal", 2: "warn", 4: "critical" };
const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);
const readingText = (r: PressureReading): string =>
  `kernel ${KERNEL[r.kernel] ?? r.kernel}, compressor ${gb(r.compressorBytes)} of ${gb(r.ramBytes)} GB, swap ${gb(r.swapUsedBytes)} of ${gb(r.swapTotalBytes)} GB`;

/** The governor's line under the live line: the level, the limit it allows and the turns it holds, with the reading behind it. Null with no governor. */
export function pressureLine(governor: AgentQueueGovernor | null, macWorkingMax: number): string | null {
  if (!governor) return null;
  if (!governor.on) return "The memory governor is off, so the limit holds under any memory pressure.";
  const reading = governor.reading ? ` (${readingText(governor.reading)})` : "";
  if (governor.level === "ok") return `Memory pressure ok${reading}.`;
  return `Memory pressure ${governor.level}${reading}: up to ${governor.limit} of ${macWorkingMax} working, ${governor.held} low turns held.`;
}

/** The governor's last limit change on the Mac limit's row, with the reading that made it. */
export function pressureChangeLine(change: PressureChange | null): string | null {
  if (!change) return null;
  const why = `memory pressure went ${change.to}${change.reading ? ` (${readingText(change.reading)})` : ""}`;
  if (change.limitFrom === change.limitTo) return `At ${kst(change.at)} ${why}, and the limit stayed ${change.limitTo}.`;
  return `${change.limitTo < change.limitFrom ? "Lowered" : "Raised"} from ${change.limitFrom} to ${change.limitTo} at ${kst(change.at)}: ${why}.`;
}
