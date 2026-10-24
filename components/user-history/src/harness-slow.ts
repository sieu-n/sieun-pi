import type { ChatLatency } from "./chat-latency.ts";
import type { DaemonFault } from "./daemon-faults.ts";

/**
 * Whether the harness itself was slow in a minute its box read CPU-unusable, for the Whole system duty (scripts/duties/whole-system.ts). The chat
 * VP's rule on 10-18 at 11:58Z: a busy box from real job work is no harness fault, so a CPU minute is dirty only when the owner would notice,
 * when (a) the chat service answered a page or API read in over 1 s or its event loop stalled that long, (b) a Prime worker missed the
 * supervisor's poll, or (c) a send or wake timed out (src/daemon-faults.ts). Before this rule d7 at 11:54Z read 28 CPU-dirty minutes.
 */

/** The owner's line: a page or API read slower than this is one he notices. */
export const SLOW_READ_MS = 1000;

/**
 * When the supervisor's poll of a worker went unanswered, from a daemon log's lines: its scheduled job and heartbeat lists timing out
 * ("Could not list scheduled jobs from a worker: Timed out waiting for daemon worker response to cron_list", 7 lines from 10:52Z to 11:00Z on
 * 10-18) and a worker it parked as unresponsive. A list refused by a worker that is stopping is no miss.
 */
export function workerMisses(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const found = /^\[(\S+Z)\] supervisor: (?:Could not list [\w ]+ from a worker: Timed out waiting for daemon worker response|Worker \S+ is unresponsive; parked)/.exec(line);
    const at = found ? Date.parse(found[1]!) : NaN;
    if (Number.isFinite(at)) out.push(at);
  }
  return out;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A watch line's chat latency checked at the edge; undefined when absent or malformed. */
export function chatLatency(value: unknown): ChatLatency | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { readMs, read, loopMs, gcMs, gc } = value as Record<string, unknown>;
  const kind = gc === "major" || gc === "minor" || gc === "incremental" || gc === "weak" ? gc : undefined;
  return count(readMs) && count(loopMs) ? { readMs, loopMs, ...typeof read === "string" ? { read } : {}, ...count(gcMs) && kind ? { gcMs, gc: kind } : {} } : undefined;
}

/**
 * A send or wake that timed out or ran long, which waiting on CPU explains. A refusal is the session's answer, not a wait: from 11:44Z on 10-18
 * an outbox send to 01a0cc5e failed every minute with "too many pending messages", and a send to a worker still starting is that worker's state.
 */
export const waitedOnCpu = (what: string): boolean => /\b(?:send|wake)/.test(what) && /timed out|\btook \d+ s\b/.test(what);

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/** The chat service's read slower than SLOW_READ_MS in a line `own` says the box wrote; every read it times is a route of the chat service's own code. */
export function slowChatRead(own: boolean, latency: unknown): ChatLatency | undefined {
  const read = own ? chatLatency(latency) : undefined;
  return read && read.readMs > SLOW_READ_MS ? read : undefined;
}

/**
 * What made the harness slow in [from, to) on `box`, in the flag's words; empty when it stayed fast. `own` says whether `box` wrote the line,
 * since only that box's chat service timed its reads and only its supervisor log was read.
 */
export function harnessSlow(input: { box: string; own: boolean; latency: unknown; from: number; to: number; misses: readonly number[]; faults: readonly DaemonFault[] }): string[] {
  const out: string[] = [];
  const latency = input.own ? chatLatency(input.latency) : undefined;
  const slowRead = slowChatRead(input.own, input.latency);
  if (slowRead) out.push(`the chat answered ${slowRead.read ?? "a read"} in ${seconds(slowRead.readMs)}`);
  if (latency && latency.loopMs > SLOW_READ_MS) {
    const gc = latency.gcMs !== undefined && latency.gcMs > SLOW_READ_MS / 2 ? ` (a ${latency.gc} GC took ${seconds(latency.gcMs)})` : "";
    out.push(`the chat's event loop stalled ${seconds(latency.loopMs)}${gc}`);
  }
  const misses = input.own ? input.misses.filter(at => at >= input.from && at < input.to).length : 0;
  if (misses) out.push(`${misses} worker poll${misses === 1 ? "" : "s"} went unanswered`);
  const slow = input.faults.filter(fault => fault.host === input.box && fault.at >= input.from && fault.at < input.to && waitedOnCpu(fault.what)).length;
  if (slow) out.push(`${slow} send${slow === 1 ? "" : "s"} or wake${slow === 1 ? "" : "s"} timed out`);
  return out;
}
