const MINUTE = 60_000;

/**
 * Tool calls that hang: a session in a tool call that wrote nothing for HUNG_SILENT_MS, while the commands its kernel runs made no progress, or
 * its kernel burns CPU on its own. On 10-19 three such calls read working on Settings > Hosts for 9 to 13 h and kept us-metal02 from ever
 * reading 0 working, so d7's quiet_agent_gb had no quiet minute to judge from 01:43Z: restart-cold-start's `await h` on a rig whose tree used
 * 0.01 cores, fix4-ops-d2's node test under a defunct child, and p258-critical-path's kernel at about 1 core with 10 GB for 9 h. At 11:40Z a
 * fourth sat 148 min on an ssh to the Mac that used no CPU (mac-local-keys). d7's hung_calls names each one with its
 * session and chat, src/hung-stop.ts stops the bash() commands of a call with no progress, or else interrupts its cell, so the call returns, and
 * Settings > Hosts counts a call it could not stop as hung instead of working.
 */
export const HUNG_SILENT_MS = 60 * MINUTE;
/** How far back progress is read: the call's marks start this much before it reaches HUNG_SILENT_MS. */
export const PROGRESS_WINDOW_MS = 30 * MINUTE;
/** The shortest span of marks that judges progress, so a service restart inside the window leaves a call unjudged instead of judged on two minutes. */
export const PROGRESS_SPAN_MS = 20 * MINUTE;
/**
 * The CPU, in cores, that a call's commands (the kernel's descendants and what they reaped) use on average for the call to count as making
 * progress. Measured on us-metal02: restart-cold-start's hung rig at 0.01 cores (harnessSplit at 06:01Z on 10-19) and mac-local-keys's hung ssh
 * at 0.00 (60 s at 11:40Z); the 10 busy calls of that sample used 0.21 to 4.15 cores.
 */
export const PROGRESS_CORES = 0.1;
/** A kernel that burns this much CPU on its own with no output counts as hung whatever its commands do: p258-critical-path's ran at about 1 core. */
export const BURNING_CORES = 0.5;

/** One minute's reading of a session in a tool call that has been silent at least HUNG_SILENT_MS less PROGRESS_WINDOW_MS. */
export interface CallMark {
  session: string;
  /** When the session last wrote (the daemon row's lastActivityAt), ms; a new value is a new call or output. */
  since: number;
  at: number;
  /** The kernel process's own CPU seconds. */
  kernelS: number;
  /** The CPU seconds of the kernel's descendants and of the children it and they reaped. */
  workS: number;
  /** The kernel's largest command that is no Prime process, cut to 120 characters. */
  command: string | null;
}

/** A hung call as d7 and Settings > Hosts read it. */
export interface HungCall { session: string; name: string; root: string; tree: string; silentMin: number; workCores: number; kernelCores: number; command: string | null;
  why: "no progress" | "kernel burning";
  /** When the call went silent (its marks' `since`), ms; absent from lines before 10-19 21Z. */
  since?: number }

/** The kernel numbers the footprint helper (src/worker-footprint.py) reports, as the marks read them. */
export interface KernelCpu { session: string; cpu_s?: number; work_cpu_s?: number; biggest: { command: string } | null }
/** The daemon row fields the marks read. */
export interface CallRow { sessionId: string; lifecycle?: unknown; activeSessionId?: unknown; isRunningTools?: unknown; lastActivityAt?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The marks of this minute: every live session in a tool call, silent long enough to be judged within PROGRESS_WINDOW_MS, with a kernel that reports CPU. */
export function callMarks(rows: readonly unknown[], kernels: readonly KernelCpu[], now: number): CallMark[] {
  const byKernel = new Map(kernels.filter(kernel => typeof kernel.cpu_s === "number" && typeof kernel.work_cpu_s === "number").map(kernel => [kernel.session, kernel] as const));
  return rows.flatMap(row => {
    if (!isRecord(row) || typeof row.sessionId !== "string" || row.lifecycle !== "live" || typeof row.activeSessionId !== "string" || row.isRunningTools !== true) return [];
    const since = typeof row.lastActivityAt === "string" ? Date.parse(row.lastActivityAt) : NaN;
    const kernel = byKernel.get(row.sessionId);
    if (!kernel || !Number.isFinite(since) || now - since < HUNG_SILENT_MS - PROGRESS_WINDOW_MS) return [];
    return [{ session: row.sessionId, since, at: now, kernelS: kernel.cpu_s!, workS: kernel.work_cpu_s!, command: kernel.biggest?.command.slice(0, 120) ?? null }];
  });
}

const cores = (seconds: number, ms: number): number => Math.round(100 * seconds * 1000 / ms) / 100;

/**
 * The hung calls among `now`'s marks, judged against the earlier marks of the same call (same session and `since`) within PROGRESS_WINDOW_MS:
 * silent for HUNG_SILENT_MS, marks spanning PROGRESS_SPAN_MS, and its commands under PROGRESS_CORES or its kernel at BURNING_CORES. Work
 * seconds that fell (a reaped process left the tree) count as progress.
 */
export function hungCalls(history: readonly CallMark[], now: readonly CallMark[], name: (session: string) => { name: string; root: string; tree: string }): HungCall[] {
  return now.flatMap(mark => {
    if (mark.at - mark.since < HUNG_SILENT_MS) return [];
    const first = history.find(earlier => earlier.session === mark.session && earlier.since === mark.since && earlier.at >= mark.at - PROGRESS_WINDOW_MS && earlier.at < mark.at);
    const span = first ? mark.at - first.at : 0;
    if (!first || span < PROGRESS_SPAN_MS) return [];
    const work = mark.workS - first.workS, kernel = mark.kernelS - first.kernelS;
    if (work < 0) return [];
    const workCores = cores(work, span), kernelCores = cores(Math.max(0, kernel), span);
    const why = kernelCores >= BURNING_CORES ? "kernel burning" as const : workCores < PROGRESS_CORES ? "no progress" as const : null;
    if (!why) return [];
    return [{ session: mark.session, ...name(mark.session), silentMin: Math.round((mark.at - mark.since) / MINUTE), workCores, kernelCores, command: mark.command, why, since: mark.since }];
  });
}

/**
 * The marks of the last PROGRESS_WINDOW_MS and the hung calls of the newest minute, kept by the chat service's watch (src/mac-usable-watch.ts)
 * and read by Settings > Hosts. The watch seeds it from its own lines after a restart, so a restart costs no judgment.
 */
export class CallWatch {
  private marks: CallMark[] = [];
  private latest: HungCall[] = [];

  /** Adds the marks of earlier watch lines (oldest first), as a restart reads them back. */
  seed(lines: readonly { calls?: readonly CallMark[] }[]): void {
    const seen = new Set(this.marks.map(mark => `${mark.session}:${mark.at}`));
    for (const line of lines) for (const mark of line.calls ?? []) if (!seen.has(`${mark.session}:${mark.at}`)) this.marks.push(mark);
    this.marks.sort((a, b) => a.at - b.at);
  }

  /** Judges `marks`, taken at `at`, against the kept ones, keeps them, and returns the hung calls. */
  judge(marks: readonly CallMark[], at: number, name: (session: string) => { name: string; root: string; tree: string }): HungCall[] {
    this.marks = this.marks.filter(mark => mark.at >= at - PROGRESS_WINDOW_MS);
    this.latest = hungCalls(this.marks, marks, name);
    this.marks.push(...marks);
    return this.latest;
  }

  /** Drops calls the watch stopped (src/hung-stop.ts) from the newest minute's hung calls. */
  release(sessions: readonly string[]): void { this.latest = this.latest.filter(call => !sessions.includes(call.session)); }

  /** The sessions of the newest minute's hung calls. */
  hung(): ReadonlySet<string> { return new Set(this.latest.map(call => call.session)); }
}
