/**
 * Stalled jobs: a session whose newest entry is an open tool call that has written nothing for STALL_MS. Prime writes a tool call's result to
 * the session only when the call returns, and the daemon row's `lastActivityAt` and `modified` stay where the call began, so a session in one
 * long call reads `activity: "working"`, `isSessionActive: true` and `isRunningTools: true` the whole time. On 10-23 the job "codex fhnyq29tw5
 * sign-in" started `python3 /tmp/codex_scan.py` at 10:19:56Z, whose glob walked all of /home/sieun; it ran at 99% CPU for 2 h 53 min until the
 * d5 run killed it at 13:13Z, and the board, the d5 brief and d9 read p919 as owned by a live job all that time. A stalled job is no live owner:
 * the duty brief (`fixJobLive`, `missLine`), the check-in's stuck steps (`withStalls`, end state `stalled`) and d9's owner reads
 * (`withCatalogOwners`) count it as not at work and name its process, so the next run kills it and steers the job. Pure and browser-safe.
 */

/**
 * How long one tool call may run with no new session entry before its job reads as stalled. Measured over 24,668 finished tool calls in the
 * root sessions on us-metal02 (~/.prime/agent/sessions) and the Mac's copy, 10-07 to 10-23 (~/work/stalled-job-detector/measure_tool_calls.py):
 * p99 115 s, p99.9 442 s, p99.99 1,717 s, and the longest that returned on its own 1,889 s (31.5 min); the hung codex scan ran 10,414 s. 45 min
 * is 1.4 times the longest call that returned.
 */
export const STALL_MS = 45 * 60_000;

/** The daemon row fields the stall reads: its own `list`, the catalog's `daemonRows()` and the catalog copies all carry them for a live row. */
export interface StallRow { sessionId: string; lifecycle?: unknown; activeSessionId?: unknown; isRunningTools?: unknown; lastActivityAt?: unknown; modified?: unknown }

/** The biggest command under the stalled session's kernel, as the chat service's watch saw it (src/hung-calls.ts `CallWatch.process`). */
export interface CallProcess { pid: number; command: string;
  /** When the process started, ms; absent when the watch could not read it. */
  startedAt?: number }

/** A stalled session: since when it has written nothing (`since`, ms), and the process its open call runs when this box's watch knows it. */
export interface StalledCall { session: string; since: number; process?: CallProcess }

const at = (value: unknown): number => typeof value === "string" ? Date.parse(value) : NaN;

/** When a live row in a tool call last wrote, if that is STALL_MS or more before `now`; undefined for any other row. */
export function stalledSince(row: StallRow, now: number): number | undefined {
  if (row.lifecycle === "archived" || typeof row.activeSessionId !== "string" || row.isRunningTools !== true) return undefined;
  const wrote = Math.max(...[at(row.lastActivityAt), at(row.modified)].filter(Number.isFinite));
  return Number.isFinite(wrote) && now - wrote >= STALL_MS ? wrote : undefined;
}

/** Every stalled session among `rows`, by session id, with its process from `processOf` when known. */
export function stalledCalls(rows: readonly StallRow[], now: number, processOf: (session: string) => CallProcess | undefined = () => undefined): Map<string, StalledCall> {
  const calls = new Map<string, StalledCall>();
  for (const row of rows) {
    const since = stalledSince(row, now);
    if (since === undefined) continue;
    const process = processOf(row.sessionId);
    calls.set(row.sessionId, { session: row.sessionId, since, ...process ? { process } : {} });
  }
  return calls;
}

const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000));
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + "Z";

/**
 * The stall in words, for a brief or a precheck line: "has sat in one tool call for 173 min since 10:19Z with no new session entry; its
 * process pid 3281775 runs `python3 /tmp/codex_scan.py` and has run 173 min".
 */
export function stallWords(call: StalledCall, now: number): string {
  const head = `has sat in one tool call for ${minutes(now - call.since)} min since ${clock(call.since)} with no new session entry`;
  const process = call.process;
  if (!process) return `${head}; this box's watch does not see its process, so find it under the session's kernel on its box`;
  const ran = process.startedAt !== undefined ? ` and has run ${minutes(now - process.startedAt)} min` : "";
  return `${head}; its process pid ${process.pid} runs \`${process.command.slice(0, 120)}\`${ran}`;
}
