import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { InterruptedReport } from "./shared/interrupted.ts";

/** The resume-paused-sessions skill owns the rule for which runs count as interrupted; the chat only runs it. */
const script = fileURLToPath(new URL("../../../skills/resume-paused-sessions/scripts/resume_paused.py", import.meta.url));
const CHECK_TTL_MS = 15_000;

function runScript(args: readonly string[]): Promise<InterruptedReport> {
  return new Promise((resolve, reject) => {
    execFile(process.env.PYTHON ?? "python3", ["-B", script, "--json", ...args], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || stdout).trim().split("\n").at(-1) || error.message)); return; }
      try { resolve(JSON.parse(stdout) as InterruptedReport); }
      catch { reject(new Error("The resume script printed no JSON.")); }
    });
  });
}

/**
 * Runs the check at most once per 15 s for every open tab, and never next to a resume, so two clicks or two tabs cannot send
 * "continue" to the same head twice.
 */
export class InterruptedRuns {
  private last: { at: number; report: Promise<InterruptedReport> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly run: (args: readonly string[]) => Promise<InterruptedReport> = runScript) {}

  check(): Promise<InterruptedReport> {
    if (this.last && Date.now() - this.last.at < CHECK_TTL_MS) return this.last.report;
    const report = this.serial(() => this.run(["--dry-run"]));
    this.last = { at: Date.now(), report };
    report.catch(() => { if (this.last?.report === report) this.last = null; });
    return report;
  }

  /**
   * A hung run (working, no activity for 30 min) cannot take a message, so `unstick` aborts it first; the script then counts the
   * aborted run as resumable through --unstuck and messages its head. A run whose worker died takes no command at all, so `reopen` opens
   * its head from the saved file, which starts the head on a new worker; the script then sees the reopened head and messages it.
   */
  resume(unstick: (sessionId: string) => Promise<void>, reopen: (sessionId: string) => Promise<void>): Promise<InterruptedReport> {
    const report = this.serial(async () => {
      const planned = await this.run(["--dry-run"]);
      const unstuck: string[] = [];
      for (const run of planned.paused) {
        if (run.reason !== "hung" || !run.session_id) continue;
        try { await unstick(run.session_id); unstuck.push(run.session_id); }
        catch (error) { process.stderr.write(`resume: could not abort ${run.id}: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
      const dead = new Set(planned.paused.flatMap(run => run.reason === "worker_failed" && run.head_session_id ? [run.head_session_id] : []));
      for (const head of dead) {
        try { await reopen(head); }
        catch (error) { process.stderr.write(`resume: could not reopen ${head}: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
      // The abort lands in the session file a moment after the call returns.
      if (unstuck.length) await new Promise(resolve => setTimeout(resolve, 2000));
      return this.run(unstuck.length ? ["--unstuck", unstuck.join(",")] : []);
    });
    this.last = null;
    return report;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export const interruptedRuns = new InterruptedRuns();
