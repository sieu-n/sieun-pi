import { readFileSync } from "node:fs";
import type { HungCall } from "./hung-calls.ts";

/**
 * Stops a hung tool call, through its bash() commands or else the cell its kernel runs, so the call returns and the session gets its turn back.
 *
 * A hung call (src/hung-calls.ts: silent 60 min while its commands used under 0.1 cores) is a one-shot `await bash(...)` on a command that never
 * ends, and a message to the session waits until that call returns, so neither the session nor its chat can act on it. At 20:05Z and 20:36Z on
 * 10-19 d7 read 3 and 2 such calls: ci-plan-replay sat 178 min in a `node --test` whose tests had passed, and share-cascade 228 min in a
 * curl_cffi probe at 0 cores. Prime's await returns as soon as the command's shell exits (rlm/bash.py `_watch`), with exit code -15 after a
 * SIGTERM, and the rest of the session and its kernel are left alone. Prime has no request that interrupts one tool call without aborting the
 * turn, and an abort loses the turn ("Request was aborted" at 14:49Z on 10-19).
 *
 * Only a call with no progress is stopped, and only the handles its kernel started since the call went silent. When there are none, the call
 * awaits a handle an earlier cell started (`h = bash(...)`, then `await h`), so every handle its kernel still runs is stopped: at 23:13Z on
 * 10-19 li-http-reads sat 87 min in `await hp` on a `g07_stage.py` started 42 s before, and the watch left it hung. A kernel that burns CPU
 * on its own has no command to stop. The first minute a call is judged hung its handles get SIGTERM, and a minute later whatever of them
 * still runs gets SIGKILL.
 *
 * A call with no handle to stop, a kernel that burns CPU on its own, and a call still hung a minute after its SIGKILL get their cell interrupted:
 * SIGUSR2 to the kernel, whose handler the board skill installs in every Prime kernel (skills/board/src/board/_interrupt.py), raises
 * KeyboardInterrupt in the cell or cancels its await, and the kernel keeps its variables. At 05:51Z on 10-20 rb-api-portal sat 96 min in a
 * backtracking re.findall at 0.99 cores, which had no command to stop. A kernel that has no such handler, one booted before it or on a box
 * without the board skill, is never sent SIGUSR2, since the default action ends it. A call still hung after its interrupt counts as hung.
 */

/** A bash() handle a hung call's kernel started, as the footprint helper's `--handles` reads it: the shell first in `pids`, then its descendants. */
export interface CallHandle { kernel: number; pid: number; started: number; command: string; pids: number[] }

/** A hung call whose handles got their first signal this minute, or, with `cell`, whose cell the watch interrupted in that kernel pid. */
export interface StoppedCall extends HungCall { handles: { pid: number; command: string }[]; cell?: number }

export interface StopDeps {
  /** The handles each (kernel pid, since in epoch seconds) pair started (worker-footprint.py `--handles`). */
  handles: (wanted: readonly { kernel: number; since: number }[]) => Promise<CallHandle[]>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Interrupts the cell a kernel runs (`interruptCell`); false when the kernel has no handler for it. */
  interrupt: (kernel: number) => boolean;
  /** Whether a process still runs. */
  alive: (pid: number) => boolean;
  /** Tells the session why its call returned, through the agent outbox, which delivers it once the call is done. */
  tell: (session: string, root: string, text: string) => Promise<void>;
  log: (line: string) => void;
}

/** The message a session gets when the watch stopped its call. */
export function stoppedText(call: StoppedCall): string {
  if (call.cell !== undefined) {
    return `[hung call] Your tool call ran ${call.silentMin} min with no output while your kernel used ${call.kernelCores} cores and its commands ` +
      `${call.workCores}, so the chat service interrupted the cell (SIGUSR2 to kernel pid ${call.cell}) and the call returned KeyboardInterrupt. ` +
      `Your kernel and its variables were kept. If the code looped, for example a regular expression that backtracks, fix it before you run it ` +
      `again. If it was meant to run long, start it detached with systemd-run and wait with board.wake (AGENTS.md rule 6).`;
  }
  const pids = call.handles.map(handle => handle.pid).join(", ");
  return `[hung call] Your tool call ran ${call.silentMin} min with no output while its commands used ${call.workCores} cores, so the chat service sent ` +
    `SIGTERM to the bash() command it waited on (pid ${pids}: ${call.handles[0]?.command.slice(0, 160) ?? ""}) and that await returned with exit -15. ` +
    `Nothing else in your session or kernel was touched. If the command hung, find what it waited on and give it a deadline before you run it again. ` +
    `If it was meant to run long, start it detached with systemd-run and wait with board.wake (AGENTS.md rule 6).`;
}

/** Whether a process runs, by signal 0. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** SIGUSR2's bit in a /proc status signal mask. */
const SIGUSR2_BIT = 1n << 11n;

/** Sends SIGUSR2 to a kernel whose /proc status shows the signal caught, which interrupts its running cell; false when it has no handler. */
export function interruptCell(kernel: number, status: (pid: number) => string = pid => readFileSync(`/proc/${pid}/status`, "utf8")): boolean {
  let caught: bigint;
  try {
    const mask = /^SigCgt:\s*([0-9a-f]+)$/m.exec(status(kernel))?.[1];
    if (!mask) return false;
    caught = BigInt(`0x${mask}`);
  } catch {
    return false;
  }
  if (!(caught & SIGUSR2_BIT)) return false;
  process.kill(kernel, "SIGUSR2");
  return true;
}

const keyOf = (call: HungCall): string => `${call.session}:${call.since}`;

export class CallStopper {
  /** The processes each call got SIGTERM on last minute, by session and since, which get SIGKILL this minute if any is still alive. */
  private termed = new Map<string, { name: string; pids: number[] }>();
  /** The calls that got both signals, whose cell is interrupted when they are judged hung again. */
  private killed = new Set<string>();
  /** The calls whose cell got interrupted, which are left hung from then on. */
  private interrupted = new Set<string>();

  constructor(private readonly deps: StopDeps) {}

  /**
   * Sends SIGKILL to what last minute's SIGTERM left alive, then SIGTERM to the handles of this minute's hung calls, and interrupts the cell of
   * each hung call with no handle to stop; `left` are the calls still hung after it, `stopped` the ones that got their first signal or interrupt. It runs every minute, hung calls or none: at 22:47Z on 10-19 a SIGTERM left
   * hdx-metaads-commit's `uv run python revoke_probe.py` call waiting, its work seconds fell as a child died, so the call was not judged hung
   * again for 30 min, and the escalation that waited on that judgment came only at 23:17Z.
   */
  async stop(hung: readonly HungCall[], kernels: readonly { pid: number; session: string }[]): Promise<{ stopped: StoppedCall[]; left: HungCall[] }> {
    const killedNow = new Set(this.termed.keys());
    for (const [key, termed] of this.termed) {
      const alive = termed.pids.filter(pid => this.deps.alive(pid));
      for (const pid of alive) {
        try { this.deps.kill(pid, "SIGKILL"); } catch { /* gone already */ }
      }
      if (alive.length) this.deps.log(`hung-stop: SIGKILL to ${termed.name} (${key}): ${alive.join(", ")} outlived SIGTERM`);
      this.killed.add(key);
    }
    this.termed.clear();
    const kernelOf = new Map(kernels.map(kernel => [kernel.session, kernel.pid] as const));
    const stoppable = hung.filter(call => call.why === "no progress" && call.since !== undefined && kernelOf.has(call.session) && !this.killed.has(keyOf(call)));
    const found = stoppable.length ? await this.deps.handles(stoppable.map(call => ({ kernel: kernelOf.get(call.session)!, since: 0 }))).catch(error => {
      this.deps.log(`hung-stop: handle read failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }) : [];
    const stopped: StoppedCall[] = [], left: HungCall[] = [];
    for (const call of hung) {
      const kernel = kernelOf.get(call.session);
      const running = stoppable.includes(call) ? found.filter(handle => handle.kernel === kernel) : [];
      const own = running.filter(handle => handle.started >= Math.floor(call.since! / 1000));
      const handles = own.length ? own : running;
      if (!handles.length) {
        if (kernel !== undefined && !killedNow.has(keyOf(call)) && !this.interrupted.has(keyOf(call)) && this.sendInterrupt(kernel, call)) {
          this.interrupted.add(keyOf(call));
          const entry: StoppedCall = { ...call, handles: [], cell: kernel };
          stopped.push(entry);
          await this.tell(entry);
        } else {
          left.push(call);
        }
        continue;
      }
      const pids = handles.flatMap(handle => handle.pids);
      for (const pid of pids) {
        try { this.deps.kill(pid, "SIGTERM"); } catch { /* gone already */ }
      }
      this.deps.log(`hung-stop: SIGTERM to ${call.name} (${call.session}) silent ${call.silentMin} min at ${call.workCores} cores: ${handles.map(handle => `${handle.pid} ${handle.command.slice(0, 80)}`).join("; ")}`);
      this.termed.set(keyOf(call), { name: call.name, pids });
      const entry: StoppedCall = { ...call, handles: handles.map(handle => ({ pid: handle.pid, command: handle.command.slice(0, 200) })) };
      stopped.push(entry);
      await this.tell(entry);
    }
    return { stopped, left };
  }

  private sendInterrupt(kernel: number, call: HungCall): boolean {
    let sent = false;
    try { sent = this.deps.interrupt(kernel); } catch (error) {
      this.deps.log(`hung-stop: interrupt ${kernel} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sent) this.deps.log(`hung-stop: SIGUSR2 to ${call.name} (${call.session}) kernel ${kernel}, silent ${call.silentMin} min, ` +
      `kernel at ${call.kernelCores} cores, commands at ${call.workCores}`);
    return sent;
  }

  private async tell(entry: StoppedCall): Promise<void> {
    await this.deps.tell(entry.session, entry.root, stoppedText(entry)).catch(error =>
      this.deps.log(`hung-stop: tell ${entry.session} failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
