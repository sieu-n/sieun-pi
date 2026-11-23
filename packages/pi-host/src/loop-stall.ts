/**
 * pi-host's event-loop stalls. Every command on the socket, every kernel's host request and every agent's tool call shares one loop, so a
 * command that holds it for seconds delays all of them. On 11-23 a list_agents on a thread with 2,558 job rows held it for 5.1 s, and the
 * daily scheduler reopen of 01a17e5d for 4.3 to 5.4 s (~/work/pi-host-stalls/a-census/report.md).
 *
 * A timer every 50 ms measures how late it runs. A gap over 500 ms writes one host.log line that names the work that ran in it: the
 * commands, host requests and scheduler reopens that started or ended inside the gap (`track`), with their thread and row count, the work
 * still in flight across it, and the last host.log line written in it. Counts per UTC day (over 500 ms, over 1 s, longest, by cause) stay
 * in `<data dir>/loop-stalls.json` for today and the 2 days before it, so a duty reads them across restarts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";

/** One piece of tracked work: a socket command, a kernel host request or a scheduler reopen. `rows` is the answer's longest list. */
interface Work {
  readonly type: string;
  readonly thread: string | undefined;
  readonly start: number;
  end?: number;
  rows?: number;
}

const inFlight = new Set<Work>();
/** Work that ended since the monitor's last tick, so a command that ran inside a stall and ended in it is still named. */
let ended: Work[] = [];
let lastLine: { at: number; text: string } | undefined;

/** The length of the longest list among a value's own fields, or its `data`'s fields for a socket response; undefined when it has none. */
export function rowsOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = Object.values(value);
  const data = "data" in value && typeof value.data === "object" && value.data !== null ? Object.values(value.data) : [];
  const lengths = [...fields, ...data].filter(Array.isArray).map(list => list.length);
  return lengths.length ? Math.max(...lengths) : undefined;
}

/** Runs `run` as tracked work, so a stall while it runs names it. */
export async function track<T>(type: string, thread: string | undefined, run: () => Promise<T>): Promise<T> {
  const work: Work = { type, thread, start: performance.now() };
  inFlight.add(work);
  try {
    const result = await run();
    work.rows = rowsOf(result);
    return result;
  } finally {
    work.end = performance.now();
    inFlight.delete(work);
    ended.push(work);
  }
}

/** The start of the monitor's own lines, which `noteLine` skips: on 11-23 each stall of a burst named the one before as its last log line. */
const OWN_LINE = "loop stall ";

/** Notes a host.log line, so a stall names the last line written in it, such as a scheduler reopen's. */
export function noteLine(text: string): void {
  if (text.startsWith(OWN_LINE)) return;
  lastLine = { at: performance.now(), text };
}

interface CauseCount { count: number; over1s: number; totalMs: number; longestMs: number }
interface DayCount { over500: number; over1s: number; totalMs: number; longestMs: number; byCause: Record<string, CauseCount> }
export interface StallCounts { days: Record<string, DayCount> }

const KEEP_DAYS = 2;
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

function isCause(value: unknown): value is CauseCount {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["count", "over1s", "totalMs", "longestMs"].every(key => typeof v[key] === "number");
}

function isDay(value: unknown): value is DayCount {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["over500", "over1s", "totalMs", "longestMs"].every(key => typeof v[key] === "number")
    && typeof v.byCause === "object" && v.byCause !== null && Object.values(v.byCause).every(isCause);
}

/** `loop-stalls.json` as a previous run left it; a missing or unreadable file starts empty. */
export function readCounts(file: string): StallCounts {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const days = typeof parsed === "object" && parsed !== null && "days" in parsed ? parsed.days : undefined;
    if (typeof days !== "object" || days === null) return { days: {} };
    return { days: Object.fromEntries(Object.entries(days).filter((entry): entry is [string, DayCount] => isDay(entry[1]))) };
  } catch {
    return { days: {} };
  }
}

const ms = (n: number): number => Math.round(n);
/** A thread or session id as host.log names it: its first 8 characters, plus a harness session's `-<conversation>` after a 36-character id. */
const short = (thread: string | undefined): string => (thread ? ` in ${thread.slice(0, 8)}${thread.slice(36)}` : "");

function describe(work: Work, from: number, to: number): string {
  const inside = Math.min(work.end ?? to, to) - Math.max(work.start, from);
  return `${work.type}${short(work.thread)}${work.rows === undefined ? "" : `, ${work.rows} rows`}, ${ms(inside)} ms of it in the stall`;
}

export interface LoopStallOptions {
  log: (line: string) => void;
  /** Where the daily counts go; unset keeps them in memory only. */
  file?: string;
  /** A gap over this many ms is a stall. */
  thresholdMs?: number;
  intervalMs?: number;
}

export class LoopStalls {
  readonly counts: StallCounts;
  private readonly threshold: number;
  private readonly interval: number;
  private last = performance.now();
  /** The loop thread's CPU time at the last tick, so a stall says how much of it the thread ran and how much it waited for a core. */
  private cpu = process.threadCpuUsage();
  /** GC pauses since a little before the last stall, from a `gc` observer, so a stall says how much of it was GC. */
  private gc: { start: number; ms: number }[] = [];
  private readonly gcObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) this.gc.push({ start: entry.startTime, ms: entry.duration }); });
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: LoopStallOptions) {
    this.threshold = options.thresholdMs ?? 500;
    this.interval = options.intervalMs ?? 50;
    this.counts = options.file ? readCounts(options.file) : { days: {} };
    this.gcObserver.observe({ entryTypes: ["gc"] });
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref();
  }

  private tick(): void {
    const now = performance.now();
    const cpu = process.threadCpuUsage();
    const from = this.last;
    const gap = now - from - this.interval;
    const cpuMs = (cpu.user + cpu.system - this.cpu.user - this.cpu.system) / 1000;
    this.last = now;
    this.cpu = cpu;
    if (gap > this.threshold) {
      // The gc observer hears of a pause in the gap only on a later turn, so the line is written one turn on, with the work as it is now.
      const all = [...ended, ...inFlight];
      setImmediate(() => this.report(from, now, gap, cpuMs, all));
    } else {
      this.gc = this.gc.filter(pause => pause.start >= from);
    }
    ended = [];
  }

  private report(from: number, to: number, gap: number, cpuMs: number, all: readonly Work[]): void {
    // Work that started or ended inside the gap ran in it; work in flight across the whole gap may only have been waiting.
    const ran = all.filter(work => work.start >= from || (work.end !== undefined && work.end <= to))
      .sort((a, b) => (Math.min(b.end ?? to, to) - Math.max(b.start, from)) - (Math.min(a.end ?? to, to) - Math.max(a.start, from)));
    const waiting = all.filter(work => !ran.includes(work));
    const startedAt = new Date(Date.now() - (to - from)).toISOString().slice(11, 23);
    const parts = [`${OWN_LINE}${ms(gap)} ms from ${startedAt}Z`];
    parts.push(ran.length ? `ran: ${ran.map(work => describe(work, from, to)).join("; ")}` : "ran: no tracked work");
    if (waiting.length) {
      const types = new Map<string, number>();
      for (const work of waiting) types.set(work.type, (types.get(work.type) ?? 0) + 1);
      parts.push(`in flight across it: ${waiting.length} (${[...types].map(([type, n]) => `${type} x${n}`).join(", ")})`);
    }
    // On CPU for most of the gap: work or GC held the loop. Off CPU for most of it: the thread waited for a core or on a blocking call.
    const gc = this.gc.filter(pause => pause.start >= from && pause.start < to);
    if (lastLine && lastLine.at >= from - this.interval) parts.push(`last log line: ${JSON.stringify(lastLine.text.slice(0, 200))}`);
    parts.push(`loop thread on CPU ${ms(cpuMs)} ms${gc.length ? `, gc ${ms(gc.reduce((sum, pause) => sum + pause.ms, 0))} ms in ${gc.length} pauses` : ""}`);
    this.options.log(parts.join(" | "));
    this.count(ran[0]?.type ?? (lastLine && lastLine.at >= from - this.interval ? "untracked, see last log line" : "untracked"), gap);
  }

  private count(cause: string, gap: number): void {
    const today = dayOf(Date.now());
    const day = this.counts.days[today] ??= { over500: 0, over1s: 0, totalMs: 0, longestMs: 0, byCause: {} };
    const byCause = day.byCause[cause] ??= { count: 0, over1s: 0, totalMs: 0, longestMs: 0 };
    const over1s = gap > 1000 ? 1 : 0;
    day.over500 += 1; day.over1s += over1s; day.totalMs += ms(gap); day.longestMs = Math.max(day.longestMs, ms(gap));
    byCause.count += 1; byCause.over1s += over1s; byCause.totalMs += ms(gap); byCause.longestMs = Math.max(byCause.longestMs, ms(gap));
    const oldest = dayOf(Date.parse(today) - KEEP_DAYS * 86_400_000);
    for (const key of Object.keys(this.counts.days)) if (key < oldest) delete this.counts.days[key];
    if (!this.options.file) return;
    try {
      const temp = `${this.options.file}.${process.pid}.tmp`;
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(this.counts, null, 1)}\n`);
      renameSync(temp, this.options.file);
    } catch (error) {
      this.options.log(`${OWN_LINE}counts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.gcObserver.disconnect();
  }
}

export const countsFileOf = (dataDir: string): string => join(dataDir, "loop-stalls.json");
