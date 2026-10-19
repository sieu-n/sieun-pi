import type { HungCall } from "./hung-calls.ts";

/**
 * Stops the bash() commands of a hung tool call, so the await that waits on them returns and the session gets its turn back.
 *
 * A hung call (src/hung-calls.ts: silent 60 min while its commands used under 0.1 cores) is a one-shot `await bash(...)` on a command that never
 * ends, and a message to the session waits until that call returns, so neither the session nor its chat can act on it. At 20:05Z and 20:36Z on
 * 10-19 d7 read 3 and 2 such calls: ci-plan-replay sat 178 min in a `node --test` whose tests had passed, and share-cascade 228 min in a
 * curl_cffi probe at 0 cores. Prime's await returns as soon as the command's shell exits (rlm/bash.py `_watch`), with exit code -15 after a
 * SIGTERM, and the rest of the session and its kernel are left alone. Prime has no request that interrupts one tool call without aborting the
 * turn, and an abort loses the turn ("Request was aborted" at 14:49Z on 10-19).
 *
 * Only a call with no progress is stopped, and only the handles its kernel started since the call went silent; a kernel that burns CPU on its
 * own has no command to stop and stays hung. The first minute a call is judged hung its handles get SIGTERM; a call still hung a minute later
 * gets SIGKILL and counts as hung, since the TERM did not free it.
 */

/** A bash() handle a hung call's kernel started, as the footprint helper's `--handles` reads it: the shell first in `pids`, then its descendants. */
export interface CallHandle { kernel: number; pid: number; started: number; command: string; pids: number[] }

/** A hung call whose handles got their first signal this minute. */
export interface StoppedCall extends HungCall { handles: { pid: number; command: string }[] }

export interface StopDeps {
  /** The handles each (kernel pid, since in epoch seconds) pair started (worker-footprint.py `--handles`). */
  handles: (wanted: readonly { kernel: number; since: number }[]) => Promise<CallHandle[]>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Tells the session why its call returned, through the agent outbox, which delivers it once the call is done. */
  tell: (session: string, root: string, text: string) => Promise<void>;
  log: (line: string) => void;
}

/** The message a session gets when the watch stopped its call. */
export function stoppedText(call: StoppedCall): string {
  const pids = call.handles.map(handle => handle.pid).join(", ");
  return `[hung call] Your tool call ran ${call.silentMin} min with no output while its commands used ${call.workCores} cores, so the chat service sent ` +
    `SIGTERM to the bash() command it waited on (pid ${pids}: ${call.handles[0]?.command.slice(0, 160) ?? ""}) and that await returned with exit -15. ` +
    `Nothing else in your session or kernel was touched. If the command hung, find what it waited on and give it a deadline before you run it again. ` +
    `If it was meant to run long, start it detached with systemd-run and wait with board.wake (AGENTS.md rule 6).`;
}

const keyOf = (call: HungCall): string => `${call.session}:${call.since}`;

export class CallStopper {
  /** The calls signaled so far that are still hung, by session and since. */
  private signaled = new Set<string>();

  constructor(private readonly deps: StopDeps) {}

  /** Signals the handles of this minute's hung calls; `left` are the calls still hung after it, `stopped` the ones that got their first signal. */
  async stop(hung: readonly HungCall[], kernels: readonly { pid: number; session: string }[]): Promise<{ stopped: StoppedCall[]; left: HungCall[] }> {
    const kernelOf = new Map(kernels.map(kernel => [kernel.session, kernel.pid] as const));
    const stoppable = hung.filter(call => call.why === "no progress" && call.since !== undefined && kernelOf.has(call.session));
    const found = stoppable.length ? await this.deps.handles(stoppable.map(call => ({ kernel: kernelOf.get(call.session)!, since: Math.floor(call.since! / 1000) }))).catch(error => {
      this.deps.log(`hung-stop: handle read failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }) : [];
    const stopped: StoppedCall[] = [], left: HungCall[] = [], current = new Set<string>();
    for (const call of hung) {
      const kernel = kernelOf.get(call.session);
      const handles = stoppable.includes(call) ? found.filter(handle => handle.kernel === kernel && handle.started >= Math.floor(call.since! / 1000)) : [];
      if (!handles.length) { left.push(call); continue; }
      const key = keyOf(call);
      current.add(key);
      const again = this.signaled.has(key);
      const signal = again ? "SIGKILL" : "SIGTERM";
      for (const pid of handles.flatMap(handle => handle.pids)) {
        try { this.deps.kill(pid, signal); } catch { /* gone already */ }
      }
      this.deps.log(`hung-stop: ${signal} to ${call.name} (${call.session}) silent ${call.silentMin} min at ${call.workCores} cores: ${handles.map(handle => `${handle.pid} ${handle.command.slice(0, 80)}`).join("; ")}`);
      if (again) { left.push(call); continue; }
      this.signaled.add(key);
      const entry: StoppedCall = { ...call, handles: handles.map(handle => ({ pid: handle.pid, command: handle.command.slice(0, 200) })) };
      stopped.push(entry);
      await this.deps.tell(call.session, call.root, stoppedText(entry)).catch(error =>
        this.deps.log(`hung-stop: tell ${call.session} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    for (const key of this.signaled) if (!current.has(key)) this.signaled.delete(key);
    return { stopped, left };
  }
}
